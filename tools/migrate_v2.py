"""v1 → v2 Firestore migration: single user → profiles.

Three separate steps, run in order and checked in between:

    backup   Read-only. Dumps every top-level collection (and any
             subcollections) to backups/<UTC timestamp>/<collection>.json.
             OAuth token collections are skipped — they hold live bearer
             tokens and are recreated by signing in again.

    migrate  Creates profiles/<owner> and profiles/<other> (if missing), mirrors
             the v1 top-level entries / weights / days into profiles/<owner>/…
             (same doc ids), turns config/singleton.targets into the owner's
             default_targets, and seeds the shared exercise catalogue. Leaves the
             v1 collections untouched.

             Re-running is a sync: the owner's entries / weights / days are made
             identical to v1 again (v1 docs re-copied, v2-only docs deleted), so
             it can be run once more at cutover to pick up anything logged in v1
             since. Existing profile docs are left as they are.

    cleanup  Deletes the v1 top-level entries / weights / days / config — only
             after re-checking that the owner's copies have matching doc ids.
             Requires --yes.

Usage:
    python tools/migrate_v2.py backup  [--project ID]
    python tools/migrate_v2.py migrate --owner-email A --other-email B [--project ID]
    python tools/migrate_v2.py cleanup [--project ID] --yes
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make the repo root importable when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.store import (  # noqa: E402
    DAYS_COLLECTION,
    ENTRIES_COLLECTION,
    EXERCISES_COLLECTION,
    PROFILES_COLLECTION,
    WEIGHTS_COLLECTION,
    get_client,
)

OWNER = {"id": "antoni", "name": "Antoni", "colour": "#c05f3e"}
OTHER = {"id": "emy", "name": "Emy", "colour": "#5f7d4a"}

V1_CONFIG = ("config", "singleton")
V1_COPIED = (ENTRIES_COLLECTION, WEIGHTS_COLLECTION, DAYS_COLLECTION)
SEED_EXERCISES = [{"name": "Bench press", "muscle_group": "chest", "equipment": "barbell"}]

BATCH_LIMIT = 400  # Firestore caps a batch at 500 writes


def _jsonable(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v


# Only profile docs have subcollections; probing every doc for them costs one
# round trip each, which makes a backup of a few thousand docs take minutes.
HAS_SUBCOLLECTIONS = {PROFILES_COLLECTION}


def _dump_collection(col) -> dict[str, Any]:
    out = {}
    probe = col.id in HAS_SUBCOLLECTIONS
    for doc in col.stream():
        entry: dict[str, Any] = {"data": _jsonable(doc.to_dict())}
        subs = {sub.id: _dump_collection(sub) for sub in doc.reference.collections()} if probe else {}
        if subs:
            entry["subcollections"] = subs
        out[doc.id] = entry
    return out


def backup(db) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(__file__).resolve().parent.parent / "backups" / stamp
    out_dir.mkdir(parents=True, exist_ok=False)
    for col in db.collections():
        if col.id.startswith("oauth_"):
            print(f"  skip {col.id} (live OAuth state)")
            continue
        docs = _dump_collection(col)
        path = out_dir / f"{col.id}.json"
        path.write_text(json.dumps(docs, indent=1, sort_keys=True))
        print(f"  {col.id}: {len(docs)} docs -> {path}")
    print(f"Backup written to {out_dir}")


def _ids(col) -> set[str]:
    return {ref.id for ref in col.list_documents()}


def _commit_in_batches(db, ops) -> int:
    """ops: iterable of callables taking a batch. Returns the number applied."""
    n, batch = 0, db.batch()
    for op in ops:
        op(batch)
        n += 1
        if n % BATCH_LIMIT == 0:
            batch.commit()
            batch = db.batch()
    batch.commit()
    return n


def migrate(db, owner_email: str, other_email: str) -> None:
    config = db.collection(V1_CONFIG[0]).document(V1_CONFIG[1]).get().to_dict() or {}
    dropped = {k: config[k] for k in ("goal_weight", "goal_date") if config.get(k) is not None}
    if dropped:
        print(f"  note: v1 global goal not carried over (goals live on phases now): {dropped}")

    profiles = db.collection(PROFILES_COLLECTION)
    for spec, email, targets in ((OWNER, owner_email, config.get("targets", {})),
                                 (OTHER, other_email, {})):
        ref = profiles.document(spec["id"])
        if ref.get().exists:
            print(f"  profiles/{spec['id']}: exists, left as is")
            continue
        ref.set({"name": spec["name"], "colour": spec["colour"], "height_cm": None,
                 "default_targets": targets, "emails": [email.lower()]})
        print(f"  profiles/{spec['id']}: created ({email})")

    owner_ref = profiles.document(OWNER["id"])
    for name in V1_COPIED:
        src = list(db.collection(name).stream())
        dst = owner_ref.collection(name)
        stale = _ids(dst) - {d.id for d in src}
        n = _commit_in_batches(db, (
            (lambda b, d=d: b.set(dst.document(d.id), d.to_dict())) for d in src
        ))
        _commit_in_batches(db, ((lambda b, i=i: b.delete(dst.document(i))) for i in stale))
        print(f"  {name}: copied {n}, removed {len(stale)} no longer in v1")

    catalogue = db.collection(EXERCISES_COLLECTION)
    existing = {(d.to_dict() or {}).get("name", "").lower() for d in catalogue.stream()}
    for ex in SEED_EXERCISES:
        if ex["name"].lower() not in existing:
            catalogue.document().set(ex)
            print(f"  exercises: seeded {ex['name']}")

    _verify(db, exact=True)
    print("Migration done. v1 collections are untouched; run `cleanup --yes` once v2 is live.")


def _verify(db, exact: bool = False) -> None:
    """Every v1 doc id exists under the owner's profile (and, with `exact`, no
    others). cleanup uses the loose form: after cutover v2 gains new docs."""
    owner_ref = db.collection(PROFILES_COLLECTION).document(OWNER["id"])
    for name in V1_COPIED:
        v1, v2 = _ids(db.collection(name)), _ids(owner_ref.collection(name))
        if v1 - v2:
            sys.exit(f"VERIFY FAILED: {len(v1 - v2)} {name} docs missing from profiles/{OWNER['id']}")
        if exact and v2 - v1:
            sys.exit(f"VERIFY FAILED: {len(v2 - v1)} extra {name} docs under profiles/{OWNER['id']}")
        print(f"  verify {name}: {len(v1)} v1 docs all present in v2 ({len(v2)} total)")


def cleanup(db) -> None:
    _verify(db)
    for name in V1_COPIED:
        refs = list(db.collection(name).list_documents())
        n = _commit_in_batches(db, ((lambda b, r=r: b.delete(r)) for r in refs))
        print(f"  {name}: deleted {n} v1 docs")
    db.collection(V1_CONFIG[0]).document(V1_CONFIG[1]).delete()
    print(f"  deleted {V1_CONFIG[0]}/{V1_CONFIG[1]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["backup", "migrate", "cleanup"])
    ap.add_argument("--project")
    ap.add_argument("--owner-email")
    ap.add_argument("--other-email")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    db = get_client(args.project)
    print(f"Project: {db.project}")
    if args.step == "backup":
        backup(db)
    elif args.step == "migrate":
        if not (args.owner_email and args.other_email):
            ap.error("migrate needs --owner-email and --other-email")
        migrate(db, args.owner_email, args.other_email)
    else:
        if not args.yes:
            ap.error("cleanup deletes the v1 collections; pass --yes to confirm")
        cleanup(db)


if __name__ == "__main__":
    main()
