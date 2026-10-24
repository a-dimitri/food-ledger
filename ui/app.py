"""FastAPI app for the human web UI.

Scoped JSON API — no monolithic "load everything" endpoint. Reads are decomposed
so each scales with what it needs. Per-profile routes live under
/api/p/{profile_id}/…; the pantry and exercise catalogue are shared.

    GET    /api/me                         caller, their profile, all profiles (+ active phase)
    PATCH  /api/profiles/{pid}             name / colour / height / default targets

    GET    /api/foods                      shared pantry; POST, PATCH/DELETE /api/foods/{id}
    GET    /api/exercises                  shared catalogue; POST, PATCH/DELETE /api/exercises/{id}

  under /api/p/{pid}:
    GET    /dates                          date list for navigation (from `days` rollups)
    GET    /day/{date}                     entries + totals + targets + weigh-ins + workouts
    GET    /dashboard                      averages, per-day series, phases, weight stats
    POST   /entries                        add an entry; PATCH/DELETE /entries/{id}
    POST   /days/{date}/complete           mark an in-progress day as tracked
    POST   /weights                        log a weigh-in; DELETE /weights/{id}
    GET    /phases                         phases + untracked windows; POST, PATCH/DELETE /phases/{id}
    GET    /workouts[?since=]              POST; GET/PATCH/DELETE /workouts/{id}
    GET    /exercises/{eid}/history        top sets for one exercise
    GET    /lifts[?since=]                 weekly workout counts + latest top set per exercise
    GET    /routines                       POST, PATCH/DELETE /routines/{id}

Auth: in production the service sits behind IAP; this app validates the injected
assertion as defence-in-depth, then admits the caller only if their email is
listed on a profile (profiles/<id>.emails). There are no per-profile
permissions: any admitted caller may read and write either profile.
Locally, set DEV_AUTH_BYPASS=1 to skip it (DEV_PROFILE picks the landing profile).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from google.api_core import exceptions as gexc
from pydantic import BaseModel, Field

from core import compute, phases as phase_rules, workouts as workout_rules
from core.store import ConflictError, InvalidError, NotFoundError, ProfileStore, Store
from core.timeutils import sydney_today

app = FastAPI(title="Diet Tracker")

STATIC_DIR = Path(__file__).parent / "static"

# ── store (constructed lazily so importing the app needs no credentials) ──
_store: Optional[Store] = None


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store(project=os.environ.get("GOOGLE_CLOUD_PROJECT"))
    return _store


# ── errors raised by the store → HTTP ───────────────────────────────────────
@app.exception_handler(InvalidError)
def _invalid(_: Request, exc: InvalidError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(ConflictError)
def _conflict(_: Request, exc: ConflictError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(NotFoundError)
@app.exception_handler(gexc.NotFound)  # update() on a missing doc
def _not_found(_: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": "not found"})


# ── auth ──────────────────────────────────────────────────────────────────
IAP_AUDIENCE = os.environ.get("IAP_AUDIENCE")           # set in prod
DEV_BYPASS = os.environ.get("DEV_AUTH_BYPASS") == "1"
DEV_PROFILE = os.environ.get("DEV_PROFILE")


def current_email(
    x_goog_iap_jwt_assertion: Optional[str] = Header(default=None),
    x_goog_authenticated_user_email: Optional[str] = Header(default=None),
) -> Optional[str]:
    """Return the caller email from IAP, or 401. None under DEV_AUTH_BYPASS.

    IAP is the platform gate. This resolves the caller identity from IAP's
    injected headers:
      - If IAP_AUDIENCE is set, cryptographically verify the signed JWT
        assertion (strongest — defence in depth).
      - Otherwise trust the X-Goog-Authenticated-User-Email header, which is
        safe because IAP rejects ingress that doesn't pass through it.
    """
    if DEV_BYPASS:
        return None

    if IAP_AUDIENCE and x_goog_iap_jwt_assertion:
        try:
            from google.auth.transport import requests as g_requests
            from google.oauth2 import id_token

            payload = id_token.verify_token(
                x_goog_iap_jwt_assertion,
                g_requests.Request(),
                audience=IAP_AUDIENCE,
                certs_url="https://www.gstatic.com/iap/verify/public_key",
            )
            email = payload.get("email")
        except Exception:
            raise HTTPException(status_code=401, detail="invalid IAP assertion")
    elif x_goog_authenticated_user_email:
        # Header form: "accounts.google.com:user@example.com".
        email = x_goog_authenticated_user_email.split(":")[-1]
    else:
        raise HTTPException(status_code=401, detail="unauthenticated")
    if not email:
        raise HTTPException(status_code=401, detail="unauthenticated")
    return email.lower()


# email -> profile id, refreshed every few minutes so a profile change on the
# server is picked up without a redeploy (and without a read per request).
# Starts empty-and-unloaded (None), never as "loaded at time 0": monotonic()
# counts from an arbitrary origin, which on a fresh Cloud Run instance is near
# zero, so a zero timestamp would look fresh and lock everyone out.
_EMAIL_CACHE_TTL = 300
_email_cache: Optional[tuple[float, dict[str, str]]] = None


def _load_email_map(store: Store) -> dict[str, str]:
    global _email_cache
    mapping = {e.lower(): p["id"] for p in store.list_profiles() for e in p.get("emails", [])}
    _email_cache = (time.monotonic(), mapping)
    return mapping


def _profile_for_email(store: Store, email: str) -> Optional[str]:
    if _email_cache is None or time.monotonic() - _email_cache[0] > _EMAIL_CACHE_TTL:
        _load_email_map(store)
    profile_id = _email_cache[1].get(email)
    if profile_id is None:
        # A miss may be a profile added since the last load; check once more.
        # (Only IAP-admitted accounts get this far, so this can't be spammed.)
        profile_id = _load_email_map(store).get(email)
    return profile_id


@dataclass
class Caller:
    email: Optional[str]
    profile_id: str   # the caller's own profile — where the UI lands


def caller(email: Optional[str] = Depends(current_email), store: Store = Depends(get_store)) -> Caller:
    if email is None:  # DEV_AUTH_BYPASS
        profiles = store.list_profiles()
        if DEV_PROFILE:
            return Caller(None, DEV_PROFILE)
        if not profiles:
            raise HTTPException(status_code=503, detail="no profiles exist yet")
        return Caller(None, profiles[0]["id"])
    profile_id = _profile_for_email(store, email)
    if profile_id is None:
        raise HTTPException(status_code=403, detail="not authorized")
    return Caller(email, profile_id)


def profile_store(profile_id: str, _: Caller = Depends(caller),
                  store: Store = Depends(get_store)) -> ProfileStore:
    if store.get_profile(profile_id) is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return store.profile(profile_id)


# ── request models ──────────────────────────────────────────────────────────
class EntryIn(BaseModel):
    date: str
    time: Optional[str] = None
    food: Optional[str] = None
    source: Optional[str] = None
    quantity: Optional[str] = None
    notes: Optional[str] = None
    calories: Optional[float] = None
    protein: Optional[float] = None
    carbs: Optional[float] = None
    fat: Optional[float] = None
    fiber: Optional[float] = None
    sodium: Optional[float] = None
    sugar: Optional[float] = None


class EntryPatch(BaseModel):
    date: Optional[str] = None
    time: Optional[str] = None
    food: Optional[str] = None
    source: Optional[str] = None
    quantity: Optional[str] = None
    notes: Optional[str] = None
    calories: Optional[float] = None
    protein: Optional[float] = None
    carbs: Optional[float] = None
    fat: Optional[float] = None
    fiber: Optional[float] = None
    sodium: Optional[float] = None
    sugar: Optional[float] = None


class FoodIn(BaseModel):
    name: str
    source: Optional[str] = None
    unit: Optional[str] = None
    per: dict[str, float] = {}          # nutrients for ONE unit


class FoodPatch(BaseModel):
    name: Optional[str] = None
    source: Optional[str] = None
    unit: Optional[str] = None
    per: Optional[dict[str, float]] = None


class WeightIn(BaseModel):
    datetime: str
    kg: float


class CompleteIn(BaseModel):
    completed: bool = True


class ProfilePatch(BaseModel):
    # `emails` is deliberately absent: who may sign in is set by the
    # migration/admin, never through the API.
    name: Optional[str] = None
    colour: Optional[str] = None
    height_cm: Optional[float] = None
    default_targets: Optional[dict[str, float]] = None


class PhaseIn(BaseModel):
    kind: Literal["phase", "untracked"] = "phase"
    name: Optional[str] = None
    colour: Optional[str] = None
    start: str
    end: Optional[str] = None
    targets: Optional[dict[str, float]] = None
    goal_kg: Optional[float] = None
    goal_rate_kg_wk: Optional[float] = None
    notes: Optional[str] = None


class PhasePatch(BaseModel):
    # exclude_unset, so an explicit null clears a field (e.g. end → open-ended).
    name: Optional[str] = None
    colour: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    targets: Optional[dict[str, float]] = None
    goal_kg: Optional[float] = None
    goal_rate_kg_wk: Optional[float] = None
    notes: Optional[str] = None


class ExerciseIn(BaseModel):
    name: str
    muscle_group: Literal[workout_rules.MUSCLE_GROUPS]  # type: ignore[valid-type]
    equipment: Literal[workout_rules.EQUIPMENT]  # type: ignore[valid-type]


class ExercisePatch(BaseModel):
    name: Optional[str] = None
    muscle_group: Optional[Literal[workout_rules.MUSCLE_GROUPS]] = None  # type: ignore[valid-type]
    equipment: Optional[Literal[workout_rules.EQUIPMENT]] = None  # type: ignore[valid-type]


class TopSetIn(BaseModel):
    exercise_id: str
    name: str                            # snapshot of the catalogue name
    kg: Optional[float] = Field(default=None, ge=0)
    reps: int = Field(ge=1)


class WorkoutIn(BaseModel):
    date: str
    name: Optional[str] = None
    routine_id: Optional[str] = None
    notes: Optional[str] = None
    exercises: list[TopSetIn] = []


class WorkoutPatch(BaseModel):
    date: Optional[str] = None
    name: Optional[str] = None
    routine_id: Optional[str] = None
    notes: Optional[str] = None
    exercises: Optional[list[TopSetIn]] = None


class RoutineExerciseIn(BaseModel):
    exercise_id: str
    name: str


class RoutineIn(BaseModel):
    name: str
    exercises: list[RoutineExerciseIn] = []


class RoutinePatch(BaseModel):
    name: Optional[str] = None
    exercises: Optional[list[RoutineExerciseIn]] = None


def _patch(body: BaseModel) -> dict[str, Any]:
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="no fields to update")
    return data


# ── shell + PWA ─────────────────────────────────────────────────────────────
@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


# Front-end shell. In prod IAP gates this request; in dev it's open. The JS it
# loads calls the /api/* endpoints, which carry their own auth check.
@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# PWA plumbing. Served from the root (not /static) so the service worker's scope
# is the whole app and the manifest carries the right content type.
@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest() -> FileResponse:
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js", include_in_schema=False)
def service_worker() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="text/javascript",
        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
    )


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ── profiles ────────────────────────────────────────────────────────────────
def _active_phase(phases: list[dict[str, Any]], today: str) -> Optional[dict[str, Any]]:
    """The window covering today, shaped for the header pill."""
    p = phase_rules.phase_on(phases, today)
    if p is None:
        return None
    week, total = phase_rules.week_of(p, today)
    return {"id": p["id"], "kind": p["kind"], "name": p.get("name"),
            "colour": p.get("colour"), "week": week, "total_weeks": total}


def _public_profile(p: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in p.items() if k not in ("emails", "created_at", "updated_at")}


@app.get("/api/me")
def get_me(who: Caller = Depends(caller), store: Store = Depends(get_store)) -> dict[str, Any]:
    today = sydney_today()
    profiles = []
    for p in store.list_profiles():
        ps = store.profile(p["id"])
        latest = ps.latest_weight()
        profiles.append({
            **_public_profile(p),
            "active_phase": _active_phase(ps.list_phases(), today),
            "latest_kg": latest["kg"] if latest else None,
        })
    return {"email": who.email, "profile_id": who.profile_id, "today": today, "profiles": profiles}


@app.patch("/api/profiles/{profile_id}")
def edit_profile(profile_id: str, body: ProfilePatch, _: Caller = Depends(caller),
                 store: Store = Depends(get_store)) -> dict[str, str]:
    store.update_profile(profile_id, _patch(body))
    return {"id": profile_id}


# ── shared: pantry ──────────────────────────────────────────────────────────
# CRUD only. Scaling a food into an entry happens client-side (multiply `per`
# by the quantity) and posts through the normal entries path, so entries stay
# self-contained snapshots and this endpoint has no scaling logic.
@app.get("/api/foods")
def get_foods(_: Caller = Depends(caller), store: Store = Depends(get_store)) -> dict[str, Any]:
    return {"foods": store.list_foods()}


@app.post("/api/foods")
def create_food(body: FoodIn, _: Caller = Depends(caller), store: Store = Depends(get_store)) -> dict[str, str]:
    return {"id": store.add_food(body.model_dump(exclude_none=True))}


@app.patch("/api/foods/{food_id}")
def edit_food(food_id: str, body: FoodPatch, _: Caller = Depends(caller),
              store: Store = Depends(get_store)) -> dict[str, str]:
    store.update_food(food_id, _patch(body))
    return {"id": food_id}


@app.delete("/api/foods/{food_id}")
def remove_food(food_id: str, _: Caller = Depends(caller), store: Store = Depends(get_store)) -> dict[str, str]:
    store.delete_food(food_id)
    return {"id": food_id}


# ── shared: exercise catalogue ──────────────────────────────────────────────
@app.get("/api/exercises")
def get_exercises(_: Caller = Depends(caller), store: Store = Depends(get_store)) -> dict[str, Any]:
    return {"exercises": store.list_exercises()}


@app.post("/api/exercises")
def create_exercise(body: ExerciseIn, _: Caller = Depends(caller),
                    store: Store = Depends(get_store)) -> dict[str, str]:
    return {"id": store.add_exercise(body.model_dump())}


@app.patch("/api/exercises/{exercise_id}")
def edit_exercise(exercise_id: str, body: ExercisePatch, _: Caller = Depends(caller),
                  store: Store = Depends(get_store)) -> dict[str, str]:
    store.update_exercise(exercise_id, _patch(body))
    return {"id": exercise_id}


@app.delete("/api/exercises/{exercise_id}")
def remove_exercise(exercise_id: str, _: Caller = Depends(caller),
                    store: Store = Depends(get_store)) -> dict[str, str]:
    store.delete_exercise(exercise_id)
    return {"id": exercise_id}


# ── per-profile: days ───────────────────────────────────────────────────────
@app.get("/api/p/{profile_id}/dates")
def get_dates(ps: ProfileStore = Depends(profile_store)) -> dict[str, Any]:
    today = sydney_today()
    dates = [
        {"date": r["date"], "entry_count": r.get("entry_count", 0), "completed": r.get("completed", False)}
        for r in ps.list_day_rollups()
    ]
    if not any(d["date"] == today for d in dates):
        dates.append({"date": today, "entry_count": 0, "completed": False})
    dates.sort(key=lambda d: d["date"], reverse=True)
    return {"today": today, "dates": dates}


@app.get("/api/p/{profile_id}/day/{date}")
def get_day(profile_id: str, date: str, ps: ProfileStore = Depends(profile_store),
            store: Store = Depends(get_store)) -> dict[str, Any]:
    entries = ps.list_entries(date)
    phases = ps.list_phases()
    defaults = (store.get_profile(profile_id) or {}).get("default_targets", {})
    window = phase_rules.phase_on(phases, date)
    return {
        "date": date,
        "entries": entries,
        "totals": compute.day_total(entries, date),
        "targets": phase_rules.targets_for(phases, date, defaults),   # None when untracked
        "phase": window,
        "untracked": bool(window and window.get("kind") == "untracked"),
        "completed": bool((ps.get_day_rollup(date) or {}).get("completed")),
        "weights": [w for w in ps.list_weights() if w.get("datetime", "").startswith(date)],
        "workouts": [w for w in ps.list_workouts(since=date) if w.get("date") == date],
    }


@app.post("/api/p/{profile_id}/days/{date}/complete")
def complete_day(date: str, body: CompleteIn, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.set_day_completed(date, body.completed)
    return {"status": "ok"}


@app.get("/api/p/{profile_id}/dashboard")
def get_dashboard(profile_id: str, ps: ProfileStore = Depends(profile_store),
                  store: Store = Depends(get_store)) -> dict[str, Any]:
    today = sydney_today()
    profile = store.get_profile(profile_id) or {}
    phases = ps.list_phases()
    rollups = ps.list_day_rollups()
    # Untracked days never count toward averages, even if something slipped in.
    day_totals = {r["date"]: r.get("totals", {}) for r in rollups
                  if not phase_rules.is_untracked(phases, r["date"])}
    completed = [r["date"] for r in rollups if r.get("completed")]
    averages, tracked_count = compute.averages_from_day_totals(day_totals, today, completed)
    weights = ps.list_weights()
    # Per-day series for the charts, oldest first; the client windows it. Each
    # day carries the window it falls in so charts can band by phase and break
    # lines across untracked windows instead of interpolating over them.
    days = []
    for r in rollups:
        window = phase_rules.phase_on(phases, r["date"])
        days.append({
            "date": r["date"],
            "totals": r.get("totals", {}),
            "completed": r.get("completed", False),
            "phase_id": window["id"] if window else None,
        })
    phase_rows = [
        {**p, "summary": compute.phase_summary(p, day_totals, today, completed)}
        if p["kind"] == "phase" else p
        for p in phases
    ]
    latest = weights[-1]["kg"] if weights else None
    return {
        "today": today,
        "default_targets": profile.get("default_targets", {}),
        "height_cm": profile.get("height_cm"),
        "bmi": compute.bmi(latest, profile.get("height_cm")) if latest is not None else None,
        "phases": phase_rows,
        "active_phase": _active_phase(phases, today),
        "averages": averages,
        "tracked_count": tracked_count,
        "days": days,
        "weights": weights,
        "weight_stats": compute.weight_stats(weights, averages.get("calories", 0.0)),
    }


# ── per-profile: entries ────────────────────────────────────────────────────
@app.post("/api/p/{profile_id}/entries")
def create_entry(body: EntryIn, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    return {"id": ps.add_entry(body.model_dump(exclude_none=True))}


@app.patch("/api/p/{profile_id}/entries/{entry_id}")
def edit_entry(entry_id: str, body: EntryPatch, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.update_entry(entry_id, _patch(body))
    return {"id": entry_id}


@app.delete("/api/p/{profile_id}/entries/{entry_id}")
def remove_entry(entry_id: str, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.delete_entry(entry_id)
    return {"id": entry_id}


# ── per-profile: weights ────────────────────────────────────────────────────
@app.post("/api/p/{profile_id}/weights")
def create_weight(body: WeightIn, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    return {"id": ps.add_weight(body.datetime, body.kg)}


@app.delete("/api/p/{profile_id}/weights/{weight_id}")
def remove_weight(weight_id: str, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.delete_weight(weight_id)
    return {"id": weight_id}


# ── per-profile: phases ─────────────────────────────────────────────────────
@app.get("/api/p/{profile_id}/phases")
def get_phases(ps: ProfileStore = Depends(profile_store)) -> dict[str, Any]:
    return {"phases": ps.list_phases()}


@app.post("/api/p/{profile_id}/phases")
def create_phase(body: PhaseIn, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    return {"id": ps.add_phase(body.model_dump(exclude_none=True))}


@app.patch("/api/p/{profile_id}/phases/{phase_id}")
def edit_phase(phase_id: str, body: PhasePatch, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.update_phase(phase_id, _patch(body))
    return {"id": phase_id}


@app.delete("/api/p/{profile_id}/phases/{phase_id}")
def remove_phase(phase_id: str, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.delete_phase(phase_id)
    return {"id": phase_id}


# ── per-profile: workouts ───────────────────────────────────────────────────
@app.get("/api/p/{profile_id}/workouts")
def get_workouts(since: Optional[str] = None, ps: ProfileStore = Depends(profile_store)) -> dict[str, Any]:
    return {"workouts": ps.list_workouts(since=since)}


@app.get("/api/p/{profile_id}/workouts/{workout_id}")
def get_workout(workout_id: str, ps: ProfileStore = Depends(profile_store)) -> dict[str, Any]:
    workout = ps.get_workout(workout_id)
    if workout is None:
        raise HTTPException(status_code=404, detail="workout not found")
    return workout


@app.post("/api/p/{profile_id}/workouts")
def create_workout(body: WorkoutIn, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    return {"id": ps.add_workout(body.model_dump(exclude_none=True))}


@app.patch("/api/p/{profile_id}/workouts/{workout_id}")
def edit_workout(workout_id: str, body: WorkoutPatch, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.update_workout(workout_id, _patch(body))
    return {"id": workout_id}


@app.delete("/api/p/{profile_id}/workouts/{workout_id}")
def remove_workout(workout_id: str, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.delete_workout(workout_id)
    return {"id": workout_id}


@app.get("/api/p/{profile_id}/exercises/{exercise_id}/history")
def get_exercise_history(exercise_id: str, ps: ProfileStore = Depends(profile_store)) -> dict[str, Any]:
    history = workout_rules.exercise_history(ps.workouts_with_exercise(exercise_id), exercise_id)
    active = phase_rules.phase_on(ps.list_phases(), sydney_today())
    phase_start = active["start"] if active and active["kind"] == "phase" else None
    return {
        "history": history,
        "best": workout_rules.best_set(history),
        "sessions": len(history),
        "change_vs_previous": workout_rules.kg_change(history),
        "change_this_phase": workout_rules.kg_change(history, since=phase_start) if phase_start else None,
    }


@app.get("/api/p/{profile_id}/lifts")
def get_lifts(since: Optional[str] = None, ps: ProfileStore = Depends(profile_store)) -> dict[str, Any]:
    """Insights › Lifts: workouts per week, and each exercise's latest top set
    with its change since the active phase began."""
    workouts = ps.list_workouts(since=since)
    phases = ps.list_phases()
    active = phase_rules.phase_on(phases, sydney_today())
    phase_start = active["start"] if active and active["kind"] == "phase" else None
    names: dict[str, str] = {}
    for w in workouts:
        for ex in w.get("exercises") or []:
            names.setdefault(ex["exercise_id"], ex.get("name"))
    lifts = []
    for exercise_id, name in names.items():
        history = workout_rules.exercise_history(workouts, exercise_id)
        latest = history[-1]
        lifts.append({
            "exercise_id": exercise_id, "name": name, "latest": latest,
            "change_this_phase": workout_rules.kg_change(history, since=phase_start) if phase_start else None,
        })
    lifts.sort(key=lambda l: l["latest"]["date"], reverse=True)
    return {"weekly_counts": workout_rules.weekly_counts(workouts), "lifts": lifts}


# ── per-profile: routines ───────────────────────────────────────────────────
@app.get("/api/p/{profile_id}/routines")
def get_routines(ps: ProfileStore = Depends(profile_store)) -> dict[str, Any]:
    return {"routines": ps.list_routines()}


@app.post("/api/p/{profile_id}/routines")
def create_routine(body: RoutineIn, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    return {"id": ps.add_routine(body.model_dump())}


@app.patch("/api/p/{profile_id}/routines/{routine_id}")
def edit_routine(routine_id: str, body: RoutinePatch, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.update_routine(routine_id, _patch(body))
    return {"id": routine_id}


@app.delete("/api/p/{profile_id}/routines/{routine_id}")
def remove_routine(routine_id: str, ps: ProfileStore = Depends(profile_store)) -> dict[str, str]:
    ps.delete_routine(routine_id)
    return {"id": routine_id}
