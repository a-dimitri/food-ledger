"""Firestore data-access layer.

Thin, explicit wrapper over the Firestore collections that hold the source of
truth. Both the web UI and the MCP server use this. Source data lives in
`config`, `entries`, and `weights`; the `days` collection is a *materialized*
per-day rollup maintained here on every entry write, so aggregate reads (the
date list, dashboard averages) scale with the number of days rather than the
number of entries.

Collections:
    config/singleton   — targets, goal_weight, goal_date
    entries/<auto-id>  — one food entry (see core.compute for the field shape)
    weights/<auto-id>  — one weigh-in {datetime, kg}
    days/<YYYY-MM-DD>  — rollup {date, totals{}, entry_count, completed}

This module is intentionally not imported by core/__init__ so that pure-compute
code (and its tests) need not depend on google-cloud-firestore.
"""

from __future__ import annotations

import os
from collections import defaultdict
from typing import Any, Optional

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from . import compute

CONFIG_COLLECTION = "config"
CONFIG_DOC = "singleton"
ENTRIES_COLLECTION = "entries"
WEIGHTS_COLLECTION = "weights"
DAYS_COLLECTION = "days"
FOODS_COLLECTION = "foods"


def get_client(project: Optional[str] = None) -> firestore.Client:
    """Firestore client for the default database.

    Project resolves from the argument, then GOOGLE_CLOUD_PROJECT, then the
    ambient credentials (ADC locally, the service account on Cloud Run).
    """
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT")
    return firestore.Client(project=project)


class Store:
    def __init__(self, client: Optional[firestore.Client] = None, project: Optional[str] = None):
        self.db = client or get_client(project)

    # ── config ──────────────────────────────────────────────────────────
    def get_config(self) -> dict[str, Any]:
        snap = self.db.collection(CONFIG_COLLECTION).document(CONFIG_DOC).get()
        return snap.to_dict() or {}

    def set_config(self, data: dict[str, Any]) -> None:
        self.db.collection(CONFIG_COLLECTION).document(CONFIG_DOC).set(data, merge=True)

    # ── entries ─────────────────────────────────────────────────────────
    def list_entries(self, date: Optional[str] = None) -> list[dict[str, Any]]:
        """All entries, or just those on `date`. Sorted client-side by time
        (the per-day set is tiny, so no composite index is needed)."""
        col = self.db.collection(ENTRIES_COLLECTION)
        query = col.where(filter=FieldFilter("date", "==", date)) if date else col
        entries = [{**d.to_dict(), "id": d.id} for d in query.stream()]
        entries.sort(key=lambda e: (e.get("date", ""), e.get("time", "")))
        return entries

    def add_entry(self, data: dict[str, Any]) -> str:
        ref = self.db.collection(ENTRIES_COLLECTION).document()
        ref.set({
            **data,
            "created_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
        self._recompute_day(data["date"])
        return ref.id

    def update_entry(self, entry_id: str, data: dict[str, Any]) -> None:
        ref = self.db.collection(ENTRIES_COLLECTION).document(entry_id)
        old = ref.get().to_dict() or {}
        old_date = old.get("date")
        ref.update({**data, "updated_at": firestore.SERVER_TIMESTAMP})
        new_date = data.get("date", old_date)
        if new_date:
            self._recompute_day(new_date)
        if old_date and old_date != new_date:
            self._recompute_day(old_date)  # entry moved days — fix the old day too

    def delete_entry(self, entry_id: str) -> None:
        ref = self.db.collection(ENTRIES_COLLECTION).document(entry_id)
        date = (ref.get().to_dict() or {}).get("date")
        ref.delete()
        if date:
            self._recompute_day(date)

    # ── day rollups ─────────────────────────────────────────────────────
    def list_day_rollups(self) -> list[dict[str, Any]]:
        """All per-day rollups: [{date, totals{}, entry_count, completed}]."""
        rollups = [d.to_dict() for d in self.db.collection(DAYS_COLLECTION).stream()]
        rollups.sort(key=lambda r: r.get("date", ""))
        return rollups

    def get_day_rollup(self, date: str) -> Optional[dict[str, Any]]:
        snap = self.db.collection(DAYS_COLLECTION).document(date).get()
        return snap.to_dict() if snap.exists else None

    def set_day_completed(self, date: str, completed: bool) -> None:
        self.db.collection(DAYS_COLLECTION).document(date).set(
            {"date": date, "completed": completed}, merge=True
        )

    def _recompute_day(self, date: str) -> None:
        """Rebuild days/<date> from that day's entries, in a transaction.

        Recompute-from-scratch (not incremental deltas) — robust to edits and
        deletes. Reads only the one day's entries. Removes the rollup when the
        day is emptied; preserves the `completed` flag otherwise.
        """
        entries_q = self.db.collection(ENTRIES_COLLECTION).where(
            filter=FieldFilter("date", "==", date)
        )
        day_ref = self.db.collection(DAYS_COLLECTION).document(date)

        @firestore.transactional
        def txn(transaction: firestore.Transaction) -> None:
            # All reads must precede writes within a transaction.
            existing = day_ref.get(transaction=transaction)
            entry_docs = list(entries_q.get(transaction=transaction))
            entries = [d.to_dict() for d in entry_docs]

            if not entries:
                if existing.exists:
                    transaction.delete(day_ref)
                return

            completed = bool((existing.to_dict() or {}).get("completed", False)) if existing.exists else False
            transaction.set(day_ref, {
                "date": date,
                "totals": compute.day_total(entries, date),
                "entry_count": len(entries),
                "completed": completed,
            })

        txn(self.db.transaction())

    def rebuild_rollups(self) -> int:
        """Regenerate the entire `days` collection from `entries`.

        Used by the importer and for repair. Preserves existing `completed`
        flags; drops rollups for dates that no longer have entries.
        Returns the number of days written.
        """
        by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for d in self.db.collection(ENTRIES_COLLECTION).stream():
            e = d.to_dict()
            by_date[e["date"]].append(e)

        existing = {doc.id: (doc.to_dict() or {}) for doc in self.db.collection(DAYS_COLLECTION).stream()}

        batch = self.db.batch()
        for date in existing:
            if date not in by_date:
                batch.delete(self.db.collection(DAYS_COLLECTION).document(date))
        for date, entries in by_date.items():
            batch.set(self.db.collection(DAYS_COLLECTION).document(date), {
                "date": date,
                "totals": compute.day_total(entries, date),
                "entry_count": len(entries),
                "completed": bool(existing.get(date, {}).get("completed", False)),
            })
        batch.commit()
        return len(by_date)

    # ── catalogue (saved foods) ─────────────────────────────────────────
    # A flat collection of reusable food templates, like `weights`: no rollup
    # interaction (catalogue items are never summed — only materialised into
    # entries via core.catalogue.scale, which carries absolute values across).
    def list_foods(self) -> list[dict[str, Any]]:
        """All saved foods, most-used first then alphabetical (for the picker)."""
        foods = [{**d.to_dict(), "id": d.id} for d in self.db.collection(FOODS_COLLECTION).stream()]
        foods.sort(key=lambda f: (-f.get("use_count", 0), (f.get("name") or "").lower()))
        return foods

    def get_food(self, food_id: str) -> Optional[dict[str, Any]]:
        snap = self.db.collection(FOODS_COLLECTION).document(food_id).get()
        return {**snap.to_dict(), "id": snap.id} if snap.exists else None

    def add_food(self, data: dict[str, Any]) -> str:
        ref = self.db.collection(FOODS_COLLECTION).document()
        ref.set({
            "use_count": 0,
            **data,
            "created_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
        return ref.id

    def update_food(self, food_id: str, data: dict[str, Any]) -> None:
        ref = self.db.collection(FOODS_COLLECTION).document(food_id)
        ref.update({**data, "updated_at": firestore.SERVER_TIMESTAMP})

    def delete_food(self, food_id: str) -> None:
        self.db.collection(FOODS_COLLECTION).document(food_id).delete()

    def increment_food_use(self, food_id: str) -> None:
        """Bump a food's use_count so the picker surfaces frequent items first."""
        self.db.collection(FOODS_COLLECTION).document(food_id).update(
            {"use_count": firestore.Increment(1)}
        )

    # ── weights ─────────────────────────────────────────────────────────
    def list_weights(self) -> list[dict[str, Any]]:
        query = self.db.collection(WEIGHTS_COLLECTION).order_by("datetime")
        return [{**d.to_dict(), "id": d.id} for d in query.stream()]

    def add_weight(self, dt: str, kg: float) -> str:
        ref = self.db.collection(WEIGHTS_COLLECTION).document()
        ref.set({"datetime": dt, "kg": kg})
        return ref.id

    def delete_weight(self, weight_id: str) -> None:
        self.db.collection(WEIGHTS_COLLECTION).document(weight_id).delete()
