"""Firestore data-access layer.

Thin, explicit wrapper over the Firestore collections that hold the source of
truth. Both the web UI and the MCP server use this.

Shared (top-level) collections — `Store`:
    profiles/<id>        {name, colour, height_cm, default_targets{}, emails[]}
    foods/<auto-id>      the shared pantry (see core.catalogue)
    exercises/<auto-id>  the shared exercise catalogue {name, muscle_group, equipment}

Per-profile subcollections under profiles/<id>/ — `ProfileStore`:
    entries/<auto-id>    one food entry (see core.compute for the field shape)
    weights/<auto-id>    one weigh-in {datetime, kg}
    days/<YYYY-MM-DD>    rollup {date, totals{}, entry_count, completed}
    phases/<auto-id>     a phase or untracked window (see core.phases)
    workouts/<auto-id>   one workout of top sets (see core.workouts)
    routines/<auto-id>   {name, exercises: [{exercise_id, name}]}

`days` is a *materialized* per-day rollup maintained here on every entry write,
so aggregate reads (the date list, dashboard averages) scale with the number of
days rather than the number of entries. Invariants that both writers (UI and
MCP) must respect also live here: rollups, non-overlapping phases, and no food
logging inside an untracked window.

This module is intentionally not imported by core/__init__ so that pure-compute
code (and its tests) need not depend on google-cloud-firestore.
"""

from __future__ import annotations

import os
from collections import defaultdict
from typing import Any, Optional

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from . import compute, phases as phase_rules, workouts as workout_rules

PROFILES_COLLECTION = "profiles"
FOODS_COLLECTION = "foods"
EXERCISES_COLLECTION = "exercises"

ENTRIES_COLLECTION = "entries"
WEIGHTS_COLLECTION = "weights"
DAYS_COLLECTION = "days"
PHASES_COLLECTION = "phases"
WORKOUTS_COLLECTION = "workouts"
ROUTINES_COLLECTION = "routines"


class InvalidError(ValueError):
    """A document failed validation (see core.phases / core.workouts)."""


class ConflictError(ValueError):
    """A write that would break a store invariant (overlapping phases, food
    logged inside an untracked window)."""


class NotFoundError(LookupError):
    """The addressed document does not exist."""


def get_client(project: Optional[str] = None) -> firestore.Client:
    """Firestore client for the default database.

    Project resolves from the argument, then GOOGLE_CLOUD_PROJECT, then the
    ambient credentials (ADC locally, the service account on Cloud Run).
    """
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT")
    return firestore.Client(project=project)


def _normalise_workout(data: dict[str, Any]) -> dict[str, Any]:
    try:
        return workout_rules.normalise(data)
    except ValueError as e:
        raise InvalidError(str(e)) from e


def _with_id(snap) -> dict[str, Any]:
    return {**(snap.to_dict() or {}), "id": snap.id}


def _stamped(data: dict[str, Any], *, created: bool) -> dict[str, Any]:
    out = {**data, "updated_at": firestore.SERVER_TIMESTAMP}
    if created:
        out["created_at"] = firestore.SERVER_TIMESTAMP
    return out


class Store:
    """Shared collections, and the entry point to each profile's data."""

    def __init__(self, client: Optional[firestore.Client] = None, project: Optional[str] = None):
        self.db = client or get_client(project)

    def profile(self, profile_id: str) -> "ProfileStore":
        return ProfileStore(self.db, profile_id)

    # ── profiles ────────────────────────────────────────────────────────
    def list_profiles(self) -> list[dict[str, Any]]:
        profiles = [_with_id(d) for d in self.db.collection(PROFILES_COLLECTION).stream()]
        profiles.sort(key=lambda p: (p.get("name") or p["id"]).lower())
        return profiles

    def get_profile(self, profile_id: str) -> Optional[dict[str, Any]]:
        snap = self.db.collection(PROFILES_COLLECTION).document(profile_id).get()
        return _with_id(snap) if snap.exists else None

    def update_profile(self, profile_id: str, data: dict[str, Any]) -> None:
        ref = self.db.collection(PROFILES_COLLECTION).document(profile_id)
        if not ref.get().exists:
            raise NotFoundError(f"profile {profile_id} not found")
        ref.update(_stamped(data, created=False))

    # ── catalogue (shared pantry) ───────────────────────────────────────
    # A flat collection of reusable food templates: no rollup interaction
    # (catalogue items are never summed — only materialised into entries via
    # core.catalogue.scale, which carries absolute values across).
    def list_foods(self) -> list[dict[str, Any]]:
        """All saved foods, most-used first then alphabetical (for the picker)."""
        foods = [_with_id(d) for d in self.db.collection(FOODS_COLLECTION).stream()]
        foods.sort(key=lambda f: (-f.get("use_count", 0), (f.get("name") or "").lower()))
        return foods

    def get_food(self, food_id: str) -> Optional[dict[str, Any]]:
        snap = self.db.collection(FOODS_COLLECTION).document(food_id).get()
        return _with_id(snap) if snap.exists else None

    def add_food(self, data: dict[str, Any]) -> str:
        ref = self.db.collection(FOODS_COLLECTION).document()
        ref.set(_stamped({"use_count": 0, **data}, created=True))
        return ref.id

    def update_food(self, food_id: str, data: dict[str, Any]) -> None:
        self.db.collection(FOODS_COLLECTION).document(food_id).update(_stamped(data, created=False))

    def delete_food(self, food_id: str) -> None:
        self.db.collection(FOODS_COLLECTION).document(food_id).delete()

    def increment_food_use(self, food_id: str) -> None:
        """Bump a food's use_count so the picker surfaces frequent items first."""
        self.db.collection(FOODS_COLLECTION).document(food_id).update(
            {"use_count": firestore.Increment(1)}
        )

    # ── exercise catalogue (shared) ─────────────────────────────────────
    def list_exercises(self) -> list[dict[str, Any]]:
        exercises = [_with_id(d) for d in self.db.collection(EXERCISES_COLLECTION).stream()]
        exercises.sort(key=lambda e: (e.get("name") or "").lower())
        return exercises

    def get_exercise(self, exercise_id: str) -> Optional[dict[str, Any]]:
        snap = self.db.collection(EXERCISES_COLLECTION).document(exercise_id).get()
        return _with_id(snap) if snap.exists else None

    def add_exercise(self, data: dict[str, Any]) -> str:
        ref = self.db.collection(EXERCISES_COLLECTION).document()
        ref.set(_stamped(data, created=True))
        return ref.id

    def update_exercise(self, exercise_id: str, data: dict[str, Any]) -> None:
        self.db.collection(EXERCISES_COLLECTION).document(exercise_id).update(_stamped(data, created=False))

    def delete_exercise(self, exercise_id: str) -> None:
        """Past workouts keep their snapshot of the name, so this is safe."""
        self.db.collection(EXERCISES_COLLECTION).document(exercise_id).delete()


class ProfileStore:
    """One profile's own data: entries, weights, rollups, phases, workouts, routines."""

    def __init__(self, db: firestore.Client, profile_id: str):
        self.db = db
        self.profile_id = profile_id
        self.root = db.collection(PROFILES_COLLECTION).document(profile_id)

    def _col(self, name: str):
        return self.root.collection(name)

    # ── entries ─────────────────────────────────────────────────────────
    def list_entries(self, date: Optional[str] = None) -> list[dict[str, Any]]:
        """All entries, or just those on `date`. Sorted client-side by time
        (the per-day set is tiny, so no composite index is needed)."""
        col = self._col(ENTRIES_COLLECTION)
        query = col.where(filter=FieldFilter("date", "==", date)) if date else col
        entries = [_with_id(d) for d in query.stream()]
        entries.sort(key=lambda e: (e.get("date", ""), e.get("time", "")))
        return entries

    def _check_loggable(self, date: str) -> None:
        if phase_rules.is_untracked(self.list_phases(), date):
            raise ConflictError(f"{date} is inside an untracked window; food can't be logged")

    def add_entry(self, data: dict[str, Any]) -> str:
        self._check_loggable(data["date"])
        ref = self._col(ENTRIES_COLLECTION).document()
        ref.set(_stamped(data, created=True))
        self._recompute_day(data["date"])
        return ref.id

    def update_entry(self, entry_id: str, data: dict[str, Any]) -> None:
        ref = self._col(ENTRIES_COLLECTION).document(entry_id)
        snap = ref.get()
        if not snap.exists:
            raise NotFoundError(f"entry {entry_id} not found")
        old_date = (snap.to_dict() or {}).get("date")
        new_date = data.get("date", old_date)
        if new_date != old_date:
            self._check_loggable(new_date)
        ref.update(_stamped(data, created=False))
        if new_date:
            self._recompute_day(new_date)
        if old_date and old_date != new_date:
            self._recompute_day(old_date)  # entry moved days — fix the old day too

    def delete_entry(self, entry_id: str) -> None:
        ref = self._col(ENTRIES_COLLECTION).document(entry_id)
        date = (ref.get().to_dict() or {}).get("date")
        ref.delete()
        if date:
            self._recompute_day(date)

    # ── day rollups ─────────────────────────────────────────────────────
    def list_day_rollups(self) -> list[dict[str, Any]]:
        """All per-day rollups: [{date, totals{}, entry_count, completed}]."""
        rollups = [d.to_dict() for d in self._col(DAYS_COLLECTION).stream()]
        rollups.sort(key=lambda r: r.get("date", ""))
        return rollups

    def get_day_rollup(self, date: str) -> Optional[dict[str, Any]]:
        snap = self._col(DAYS_COLLECTION).document(date).get()
        return snap.to_dict() if snap.exists else None

    def set_day_completed(self, date: str, completed: bool) -> None:
        self._col(DAYS_COLLECTION).document(date).set(
            {"date": date, "completed": completed}, merge=True
        )

    def _recompute_day(self, date: str) -> None:
        """Rebuild days/<date> from that day's entries, in a transaction.

        Recompute-from-scratch (not incremental deltas) — robust to edits and
        deletes. Reads only the one day's entries. Removes the rollup when the
        day is emptied; preserves the `completed` flag otherwise.
        """
        entries_q = self._col(ENTRIES_COLLECTION).where(filter=FieldFilter("date", "==", date))
        day_ref = self._col(DAYS_COLLECTION).document(date)

        @firestore.transactional
        def txn(transaction: firestore.Transaction) -> None:
            # All reads must precede writes within a transaction.
            existing = day_ref.get(transaction=transaction)
            entries = [d.to_dict() for d in entries_q.get(transaction=transaction)]

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
        """Regenerate this profile's `days` collection from its `entries`.

        Used by the migration and for repair. Preserves existing `completed`
        flags; drops rollups for dates that no longer have entries.
        Returns the number of days written.
        """
        by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for d in self._col(ENTRIES_COLLECTION).stream():
            e = d.to_dict()
            by_date[e["date"]].append(e)

        days = self._col(DAYS_COLLECTION)
        existing = {doc.id: (doc.to_dict() or {}) for doc in days.stream()}

        batch = self.db.batch()
        for date in existing:
            if date not in by_date:
                batch.delete(days.document(date))
        for date, entries in by_date.items():
            batch.set(days.document(date), {
                "date": date,
                "totals": compute.day_total(entries, date),
                "entry_count": len(entries),
                "completed": bool(existing.get(date, {}).get("completed", False)),
            })
        batch.commit()
        return len(by_date)

    # ── weights ─────────────────────────────────────────────────────────
    # Allowed inside untracked windows: a weigh-in is still a true reading.
    def list_weights(self) -> list[dict[str, Any]]:
        query = self._col(WEIGHTS_COLLECTION).order_by("datetime")
        return [_with_id(d) for d in query.stream()]

    def add_weight(self, dt: str, kg: float) -> str:
        ref = self._col(WEIGHTS_COLLECTION).document()
        ref.set({"datetime": dt, "kg": kg})
        return ref.id

    def latest_weight(self) -> Optional[dict[str, Any]]:
        query = self._col(WEIGHTS_COLLECTION).order_by(
            "datetime", direction=firestore.Query.DESCENDING).limit(1)
        return next((_with_id(d) for d in query.stream()), None)

    def delete_weight(self, weight_id: str) -> None:
        self._col(WEIGHTS_COLLECTION).document(weight_id).delete()

    # ── phases ──────────────────────────────────────────────────────────
    def list_phases(self) -> list[dict[str, Any]]:
        """All phases and untracked windows, oldest first (a handful of docs)."""
        phases = [_with_id(d) for d in self._col(PHASES_COLLECTION).stream()]
        phases.sort(key=lambda p: p.get("start", ""))
        return phases

    def _check_phase(self, phase: dict[str, Any]) -> None:
        try:
            phase_rules.validate(phase)
        except ValueError as e:
            raise InvalidError(str(e)) from e
        clash = phase_rules.find_overlap(self.list_phases(), phase)
        if clash:
            label = clash.get("name") or clash.get("kind")
            raise ConflictError(
                f"overlaps '{label}' ({clash['start']} – {clash.get('end') or 'open'})"
            )

    def add_phase(self, data: dict[str, Any]) -> str:
        self._check_phase(data)
        ref = self._col(PHASES_COLLECTION).document()
        ref.set(_stamped(data, created=True))
        return ref.id

    def update_phase(self, phase_id: str, data: dict[str, Any]) -> None:
        ref = self._col(PHASES_COLLECTION).document(phase_id)
        snap = ref.get()
        if not snap.exists:
            raise NotFoundError(f"phase {phase_id} not found")
        merged = {**(snap.to_dict() or {}), **data, "id": phase_id}
        self._check_phase(merged)
        ref.update(_stamped(data, created=False))

    def delete_phase(self, phase_id: str) -> None:
        self._col(PHASES_COLLECTION).document(phase_id).delete()

    # ── workouts ────────────────────────────────────────────────────────
    def list_workouts(self, since: Optional[str] = None) -> list[dict[str, Any]]:
        """Workouts newest first, optionally only those on/after `since`."""
        col = self._col(WORKOUTS_COLLECTION)
        query = col.where(filter=FieldFilter("date", ">=", since)) if since else col
        workouts = [_with_id(d) for d in query.stream()]
        workouts.sort(key=lambda w: w.get("date", ""), reverse=True)
        return workouts

    def get_workout(self, workout_id: str) -> Optional[dict[str, Any]]:
        snap = self._col(WORKOUTS_COLLECTION).document(workout_id).get()
        return _with_id(snap) if snap.exists else None

    def add_workout(self, data: dict[str, Any]) -> str:
        ref = self._col(WORKOUTS_COLLECTION).document()
        ref.set(_stamped(_normalise_workout(data), created=True))
        return ref.id

    def update_workout(self, workout_id: str, data: dict[str, Any]) -> None:
        ref = self._col(WORKOUTS_COLLECTION).document(workout_id)
        snap = ref.get()
        if not snap.exists:
            raise NotFoundError(f"workout {workout_id} not found")
        merged = _normalise_workout({**(snap.to_dict() or {}), **data})
        changed = {k: merged[k] for k in (*data, "exercise_ids") if k in merged}
        ref.update(_stamped(changed, created=False))

    def delete_workout(self, workout_id: str) -> None:
        self._col(WORKOUTS_COLLECTION).document(workout_id).delete()

    def workouts_with_exercise(self, exercise_id: str) -> list[dict[str, Any]]:
        """Every workout containing `exercise_id` (sorted by the caller)."""
        query = self._col(WORKOUTS_COLLECTION).where(
            filter=FieldFilter("exercise_ids", "array_contains", exercise_id)
        )
        return [_with_id(d) for d in query.stream()]

    # ── routines ────────────────────────────────────────────────────────
    def list_routines(self) -> list[dict[str, Any]]:
        routines = [_with_id(d) for d in self._col(ROUTINES_COLLECTION).stream()]
        routines.sort(key=lambda r: (r.get("name") or "").lower())
        return routines

    def add_routine(self, data: dict[str, Any]) -> str:
        ref = self._col(ROUTINES_COLLECTION).document()
        ref.set(_stamped(data, created=True))
        return ref.id

    def update_routine(self, routine_id: str, data: dict[str, Any]) -> None:
        ref = self._col(ROUTINES_COLLECTION).document(routine_id)
        if not ref.get().exists:
            raise NotFoundError(f"routine {routine_id} not found")
        ref.update(_stamped(data, created=False))

    def delete_routine(self, routine_id: str) -> None:
        self._col(ROUTINES_COLLECTION).document(routine_id).delete()
