"""MCP server exposing the diet tracker as tools for Claude.

Per-record tools over the shared core.store (the same Firestore the web UI uses),
so a record Claude writes is immediately visible in the UI and vice-versa. This
module defines the tools and the FastMCP app; auth is layered on in app.py.

Profile binding: every tool acts on the profile of the person who signed in to
the connector. The OAuth access token's subject is their verified Google email;
_profile() maps it to a profile on every call. No tool takes a profile argument,
so one person's Claude can never read or write the other's profile. The pantry
and exercise catalogue are shared by design.
"""

from __future__ import annotations

import os
from typing import Annotated, Any, Literal, Optional
from urllib.parse import urlparse

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field

from core import catalogue, compute, phases as phase_rules, workouts as workout_rules
from core.store import ProfileStore, Store, get_client
from core.timeutils import sydney_now, sydney_today

# Reusable field descriptions so Claude populates these free-text fields instead
# of omitting them (the tool schema is built from these annotations).
TimeField = Annotated[Optional[str], Field(description=(
    "Time eaten, 'HH:MM' 24-hour Sydney time. Use the current time (from "
    "get_today) unless the user says when they ate."))]
QuantityField = Annotated[Optional[str], Field(description=(
    "How much was eaten, human-readable, e.g. '1 bowl', '200 g', '2 slices'. "
    "Set it whenever the user states an amount."))]
SourceField = Annotated[Optional[str], Field(description=(
    "Where the food came from: a brand ('Coles'), 'homemade', or a restaurant. "
    "Set it when the user mentions it."))]

INSTRUCTIONS = """\
Diet and training tracker (Sydney timezone). It holds separate profiles for
different people; every tool acts on the profile of the person signed in to this
connector, and there is no way to act on anyone else's. The food pantry and the
exercise catalogue are shared between profiles.

Call get_today first: it resolves the current date AND time (Sydney), whose
profile this is, and the active phase. Dates are 'YYYY-MM-DD', times 'HH:MM'
(24h). Nutrient units: calories (kcal), protein/carbs/fat/fiber/sugar (grams),
sodium (mg).

Food: when the user reports eating something, add an entry, with `time` set to
the current time unless they give one, and `quantity`/`source` whenever they
mention them. Frequently-eaten items live in the shared pantry (save_food, nutrients
per one unit); log them by name at any quantity with add_entry_from_food, and
prefer that over add_entry when a matching pantry item exists (see list_foods).

Weight: when the user reports a weight, log a weigh-in.

Phases: a phase is a date window with its own daily targets and weight goal
(e.g. a cut or a bulk). An untracked window marks time off (e.g. a holiday): it has
no targets and food can't be logged in it. Days outside both use the profile's
default targets. Windows never overlap.

Workouts: each exercise in a workout records only its top set (kg × reps).
Exercises are referred to by catalogue name or id (list_exercises); add new ones
with add_exercise. For bodyweight exercises (equipment "bodyweight", e.g.
pull-ups, dips) `kg` is the ADDED load: omit it for bodyweight only, positive for a
belt/vest, negative for assistance (band or machine). Their 1RM estimates are
quoted as added kg, using the bodyweight recorded with the workout (taken from the
latest weigh-in unless you pass bodyweight_kg)."""

# Auth is enabled when the OAuth/Google config is present (prod); without it the
# server runs unauthenticated for local tool testing, as MCP_DEV_PROFILE.
ISSUER_URL = os.environ.get("ISSUER_URL")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
AUTH_ENABLED = bool(ISSUER_URL and GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
DEV_PROFILE = os.environ.get("MCP_DEV_PROFILE")

# DNS-rebinding protection: the streamable-HTTP transport rejects Host headers
# not on this allowlist. Cloud Run presents the service hostname, so add it
# (derived from ISSUER_URL) alongside localhost for dev.
_allowed_hosts = ["localhost", "127.0.0.1", "localhost:8001", "127.0.0.1:8001"]
_allowed_origins: list[str] = []
if ISSUER_URL:
    _host = urlparse(ISSUER_URL).netloc
    _allowed_hosts.append(_host)
    _allowed_origins.append(ISSUER_URL.rstrip("/"))
TRANSPORT_SECURITY = TransportSecuritySettings(
    allowed_hosts=_allowed_hosts, allowed_origins=_allowed_origins,
)

_store: Optional[Store] = None


def store() -> Store:
    global _store
    if _store is None:
        _store = Store(project=PROJECT)
    return _store


_auth_provider = None
if AUTH_ENABLED:
    from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions

    from mcp_server.auth import FirestoreOAuthProvider

    _issuer = ISSUER_URL.rstrip("/")
    _auth_provider = FirestoreOAuthProvider(
        get_client(project=PROJECT), _issuer,
        GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
        profile_for_email=lambda email: store().profile_id_for_email(email),
    )
    _auth_settings = AuthSettings(
        issuer_url=_issuer,
        resource_server_url=_issuer,
        required_scopes=["user"],
        client_registration_options=ClientRegistrationOptions(
            enabled=True, valid_scopes=["user"], default_scopes=["user"],
        ),
        revocation_options=RevocationOptions(enabled=True),
    )
    mcp = FastMCP(
        "Diet Tracker", instructions=INSTRUCTIONS,
        auth_server_provider=_auth_provider, auth=_auth_settings,
        transport_security=TRANSPORT_SECURITY,
    )
else:
    mcp = FastMCP("Diet Tracker", instructions=INSTRUCTIONS,
                  transport_security=TRANSPORT_SECURITY)


# ── profile binding ─────────────────────────────────────────────────────────
def _profile_id() -> str:
    """The calling person's profile id, from their access token. Raises
    PermissionError rather than ever falling back to some other profile."""
    if not AUTH_ENABLED:
        if not DEV_PROFILE:
            raise PermissionError("auth is disabled; set MCP_DEV_PROFILE for local testing")
        return DEV_PROFILE
    token = get_access_token()
    if token is None or not token.subject:
        raise PermissionError("no signed-in identity on this request")
    profile_id = store().profile_id_for_email(token.subject)
    if profile_id is None:
        raise PermissionError(f"{token.subject} is not linked to a profile")
    return profile_id


def _profile() -> ProfileStore:
    return store().profile(_profile_id())


def _drop_none(fields: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in fields.items() if v is not None}


def _nutrients(calories, protein, carbs, fat, fiber, sodium, sugar) -> dict[str, float]:
    return _drop_none({"calories": calories, "protein": protein, "carbs": carbs, "fat": fat,
                       "fiber": fiber, "sodium": sodium, "sugar": sugar})


def _active_phase(phases: list[dict[str, Any]], date: str) -> Optional[dict[str, Any]]:
    p = phase_rules.phase_on(phases, date)
    if p is None:
        return None
    week, total = phase_rules.week_of(p, date)
    return {"id": p["id"], "kind": p["kind"], "name": p.get("name"), "start": p["start"],
            "end": p.get("end"), "week": week, "total_weeks": total,
            "targets": p.get("targets"), "goal_kg": p.get("goal_kg"),
            "goal_rate_kg_wk": p.get("goal_rate_kg_wk")}


# ── orientation ─────────────────────────────────────────────────────────────
@mcp.tool()
def get_today() -> dict[str, Any]:
    """Return the current date and time in Sydney, whose profile this connector
    acts on, and the phase (or untracked window) covering today. Call this first;
    use `now` as an entry's time unless the user gives a specific time."""
    profile_id = _profile_id()
    today = sydney_today()
    profile = store().get_profile(profile_id) or {}
    return {"today": today, "now": sydney_now(), "profile": profile.get("name") or profile_id,
            "phase": _active_phase(store().profile(profile_id).list_phases(), today)}


# ── food entries ────────────────────────────────────────────────────────────
@mcp.tool()
def add_entry(
    food: str,
    date: Optional[str] = None,
    time: TimeField = None,
    calories: Optional[float] = None,
    protein: Optional[float] = None,
    carbs: Optional[float] = None,
    fat: Optional[float] = None,
    fiber: Optional[float] = None,
    sodium: Optional[float] = None,
    sugar: Optional[float] = None,
    quantity: QuantityField = None,
    source: SourceField = None,
    notes: Optional[str] = None,
) -> dict[str, Any]:
    """Add a food entry when the user reports eating/drinking something. `date`
    and `time` default to now (Sydney) — pass them only to override. Capture
    `quantity` (how much) and `source` (brand/where) when the user mentions them,
    and provide whatever nutrient values are known; omit unknown nutrients.
    Fails inside an untracked window. Returns the new entry id."""
    date = date or sydney_today()
    time = time or sydney_now()
    data = _drop_none({"date": date, "food": food, "time": time, "quantity": quantity,
                       "source": source, "notes": notes,
                       **_nutrients(calories, protein, carbs, fat, fiber, sodium, sugar)})
    entry_id = _profile().add_entry(data)
    return {"id": entry_id, "status": "added", "date": date, "time": time}


@mcp.tool()
def update_entry(
    entry_id: str,
    food: Optional[str] = None,
    date: Optional[str] = None,
    time: TimeField = None,
    calories: Optional[float] = None,
    protein: Optional[float] = None,
    carbs: Optional[float] = None,
    fat: Optional[float] = None,
    fiber: Optional[float] = None,
    sodium: Optional[float] = None,
    sugar: Optional[float] = None,
    quantity: QuantityField = None,
    source: SourceField = None,
    notes: Optional[str] = None,
) -> dict[str, Any]:
    """Edit fields of an existing entry (get its id from list_entries). Only the
    fields you pass are changed."""
    data = _drop_none({"food": food, "date": date, "time": time, "quantity": quantity,
                       "source": source, "notes": notes,
                       **_nutrients(calories, protein, carbs, fat, fiber, sodium, sugar)})
    if not data:
        return {"status": "error", "detail": "no fields provided to update"}
    _profile().update_entry(entry_id, data)
    return {"id": entry_id, "status": "updated"}


@mcp.tool()
def delete_entry(entry_id: str) -> dict[str, str]:
    """Delete an entry by id (get the id from list_entries)."""
    _profile().delete_entry(entry_id)
    return {"id": entry_id, "status": "deleted"}


@mcp.tool()
def list_entries(date: Optional[str] = None) -> dict[str, Any]:
    """List food entries for a day (defaults to today), sorted by time. Each entry
    includes its id for editing/deleting."""
    date = date or sydney_today()
    return {"date": date, "entries": _profile().list_entries(date)}


@mcp.tool()
def get_day_summary(date: Optional[str] = None) -> dict[str, Any]:
    """Per-nutrient totals for a day (defaults to today) alongside the targets in
    force that day (from its phase, else the default targets; none if the day is
    in an untracked window)."""
    profile_id = _profile_id()
    ps = store().profile(profile_id)
    date = date or sydney_today()
    entries = ps.list_entries(date)
    phases = ps.list_phases()
    defaults = (store().get_profile(profile_id) or {}).get("default_targets", {})
    return {
        "date": date,
        "totals": compute.day_total(entries, date),
        "targets": phase_rules.targets_for(phases, date, defaults),
        "phase": _active_phase(phases, date),
        "entry_count": len(entries),
    }


# ── shared pantry ───────────────────────────────────────────────────────────
def _find_food(food: str) -> Optional[dict[str, Any]]:
    """Resolve a pantry item by document id, else by case-insensitive name."""
    by_id = store().get_food(food)
    if by_id:
        return by_id
    key = food.strip().lower()
    return next((f for f in store().list_foods() if (f.get("name") or "").lower() == key), None)


@mcp.tool()
def list_foods() -> dict[str, Any]:
    """List the shared pantry (most-used first). Each item has a name, optional
    unit/source, and `per` = nutrients for one unit. Use its name (or id) with
    add_entry_from_food to log it at a chosen quantity."""
    return {"foods": store().list_foods()}


@mcp.tool()
def save_food(
    name: str,
    unit: Optional[str] = None,
    source: Optional[str] = None,
    calories: Optional[float] = None,
    protein: Optional[float] = None,
    carbs: Optional[float] = None,
    fat: Optional[float] = None,
    fiber: Optional[float] = None,
    sodium: Optional[float] = None,
    sugar: Optional[float] = None,
) -> dict[str, Any]:
    """Save a reusable food to the shared pantry. Nutrients are PER ONE unit (e.g.
    one serving/bowl/100g named by `unit`); logging later multiplies them by
    quantity. Provide whatever nutrients are known; omit the rest."""
    data = _drop_none({"name": name, "unit": unit, "source": source})
    data["per"] = _nutrients(calories, protein, carbs, fat, fiber, sodium, sugar)
    return {"id": store().add_food(data), "status": "saved"}


@mcp.tool()
def add_entry_from_food(
    food: str,
    quantity: float = 1.0,
    date: Optional[str] = None,
    time: TimeField = None,
) -> dict[str, Any]:
    """Log a pantry food at `quantity` units (default 1). `food` is a pantry item's
    name (case-insensitive) or id; its per-unit nutrients are scaled by `quantity`
    and stored as a normal entry. `date` and `time` default to now (Sydney)."""
    item = _find_food(food)
    if item is None:
        return {"status": "error", "detail": f"no pantry item matching {food!r}; see list_foods"}
    date = date or sydney_today()
    time = time or sydney_now()
    data = catalogue.scale(item, quantity, date=date, time=time)
    entry_id = _profile().add_entry(data)
    store().increment_food_use(item["id"])
    return {"id": entry_id, "status": "added", "date": date, "entry": data}


@mcp.tool()
def delete_food(food_id: str) -> dict[str, str]:
    """Delete an item from the shared pantry by id (get it from list_foods). This
    affects everyone's pantry; past entries logged from it are unaffected."""
    store().delete_food(food_id)
    return {"id": food_id, "status": "deleted"}


# ── weight ──────────────────────────────────────────────────────────────────
@mcp.tool()
def log_weight(kg: float, when: Optional[str] = None) -> dict[str, Any]:
    """Log a weigh-in. `when` is an ISO datetime 'YYYY-MM-DDTHH:MM'; defaults to
    today at 08:00."""
    when = when or (sydney_today() + "T08:00")
    weight_id = _profile().add_weight(when, kg)
    return {"id": weight_id, "status": "logged", "datetime": when, "kg": kg}


@mcp.tool()
def list_weights() -> dict[str, Any]:
    """List all weigh-ins (each with its id), oldest first."""
    return {"weights": _profile().list_weights()}


@mcp.tool()
def delete_weight(weight_id: str) -> dict[str, str]:
    """Delete a weigh-in by id (get it from list_weights)."""
    _profile().delete_weight(weight_id)
    return {"id": weight_id, "status": "deleted"}


# ── overview + profile settings ─────────────────────────────────────────────
@mcp.tool()
def get_dashboard() -> dict[str, Any]:
    """Overview: average daily intake across fully-tracked days, default targets,
    the active phase (targets and weight goal), the weight trend (weekly rate,
    latest, estimated maintenance calories) and BMI."""
    profile_id = _profile_id()
    ps = store().profile(profile_id)
    profile = store().get_profile(profile_id) or {}
    today = sydney_today()
    phases = ps.list_phases()
    rollups = ps.list_day_rollups()
    day_totals = {r["date"]: r.get("totals", {}) for r in rollups
                  if not phase_rules.is_untracked(phases, r["date"])}
    completed = [r["date"] for r in rollups if r.get("completed")]
    averages, tracked_count = compute.averages_from_day_totals(day_totals, today, completed)
    weights = ps.list_weights()
    latest = weights[-1]["kg"] if weights else None
    return {
        "today": today,
        "default_targets": profile.get("default_targets", {}),
        "phase": _active_phase(phases, today),
        "averages": averages,
        "tracked_count": tracked_count,
        "weight_stats": compute.weight_stats(weights, averages.get("calories", 0.0)),
        "bmi": compute.bmi(latest, profile.get("height_cm")) if latest is not None else None,
    }


@mcp.tool()
def set_default_targets(
    calories: Optional[float] = None,
    protein: Optional[float] = None,
    carbs: Optional[float] = None,
    fat: Optional[float] = None,
    fiber: Optional[float] = None,
    sodium: Optional[float] = None,
    sugar: Optional[float] = None,
) -> dict[str, str]:
    """Update the default daily targets — those used on days outside any phase.
    Only the values you pass are changed. To change a phase's targets, use
    update_phase instead."""
    targets = _nutrients(calories, protein, carbs, fat, fiber, sodium, sugar)
    if not targets:
        return {"status": "error", "detail": "no target values provided"}
    profile_id = _profile_id()
    current = (store().get_profile(profile_id) or {}).get("default_targets", {})
    store().update_profile(profile_id, {"default_targets": {**current, **targets}})
    return {"status": "updated"}


@mcp.tool()
def set_height(height_cm: float) -> dict[str, str]:
    """Set the height in cm (used for BMI)."""
    if height_cm <= 0:
        return {"status": "error", "detail": "height_cm must be positive"}
    store().update_profile(_profile_id(), {"height_cm": height_cm})
    return {"status": "updated"}


# ── phases ──────────────────────────────────────────────────────────────────
@mcp.tool()
def list_phases() -> dict[str, Any]:
    """List phases and untracked windows (each with its id), oldest first."""
    return {"phases": _profile().list_phases()}


@mcp.tool()
def add_phase(
    start: str,
    kind: Literal["phase", "untracked"] = "phase",
    name: Optional[str] = None,
    end: Optional[str] = None,
    colour: Optional[str] = None,
    calories: Optional[float] = None,
    protein: Optional[float] = None,
    carbs: Optional[float] = None,
    fat: Optional[float] = None,
    fiber: Optional[float] = None,
    sodium: Optional[float] = None,
    sugar: Optional[float] = None,
    goal_kg: Optional[float] = None,
    goal_rate_kg_wk: Optional[float] = None,
    notes: Optional[str] = None,
) -> dict[str, Any]:
    """Create a phase (kind='phase': needs a name; the nutrient arguments are its
    daily targets; optional weight goal and planned weekly rate, negative for a
    cut) or an untracked window (kind='untracked': time off, no targets or goal).
    `end` is inclusive; omit it for an open-ended window. Fails if it would
    overlap an existing window. `colour` is a hex colour like '#c05f3e'."""
    data = _drop_none({"kind": kind, "name": name, "start": start, "end": end,
                       "colour": colour, "goal_kg": goal_kg,
                       "goal_rate_kg_wk": goal_rate_kg_wk, "notes": notes})
    targets = _nutrients(calories, protein, carbs, fat, fiber, sodium, sugar)
    if targets:
        data["targets"] = targets
    return {"id": _profile().add_phase(data), "status": "added"}


@mcp.tool()
def update_phase(
    phase_id: str,
    name: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    open_ended: bool = False,
    colour: Optional[str] = None,
    calories: Optional[float] = None,
    protein: Optional[float] = None,
    carbs: Optional[float] = None,
    fat: Optional[float] = None,
    fiber: Optional[float] = None,
    sodium: Optional[float] = None,
    sugar: Optional[float] = None,
    goal_kg: Optional[float] = None,
    goal_rate_kg_wk: Optional[float] = None,
    notes: Optional[str] = None,
) -> dict[str, Any]:
    """Edit a phase or untracked window (id from list_phases). Only the fields you
    pass change; target values are merged into the existing targets. Pass
    open_ended=true to remove the end date (e.g. 'end the cut whenever')."""
    ps = _profile()
    data = _drop_none({"name": name, "start": start, "end": end, "colour": colour,
                       "goal_kg": goal_kg, "goal_rate_kg_wk": goal_rate_kg_wk, "notes": notes})
    if open_ended:
        data["end"] = None
    targets = _nutrients(calories, protein, carbs, fat, fiber, sodium, sugar)
    if targets:
        current = next((p for p in ps.list_phases() if p["id"] == phase_id), {})
        data["targets"] = {**(current.get("targets") or {}), **targets}
    if not data:
        return {"status": "error", "detail": "no fields provided to update"}
    ps.update_phase(phase_id, data)
    return {"id": phase_id, "status": "updated"}


@mcp.tool()
def delete_phase(phase_id: str) -> dict[str, str]:
    """Delete a phase or untracked window by id (from list_phases). Entries are
    unaffected; those days fall back to the default targets."""
    _profile().delete_phase(phase_id)
    return {"id": phase_id, "status": "deleted"}


# ── exercise catalogue (shared) ─────────────────────────────────────────────
@mcp.tool()
def list_exercises() -> dict[str, Any]:
    """List the shared exercise catalogue: id, name, muscle_group, equipment."""
    return {"exercises": store().list_exercises()}


@mcp.tool()
def add_exercise(
    name: str,
    muscle_group: Literal[workout_rules.MUSCLE_GROUPS],  # type: ignore[valid-type]
    equipment: Literal[workout_rules.EQUIPMENT],  # type: ignore[valid-type]
    bodyweight_factor: Annotated[Optional[float], Field(gt=0, le=1, description=(
        "Bodyweight exercises only: share of bodyweight lifted. 1.0 (default) for "
        "pull-ups, chin-ups and dips; about 0.65 for push-ups, 0.5 for inverted rows."))] = None,
    e1rm_formula: Annotated[Optional[Literal[tuple(workout_rules.FORMULAS)]], Field(description=(
        "1RM estimate formula: 'epley' (default) or 'mayhew', which credits "
        "high-rep sets less."))] = None,
) -> dict[str, Any]:
    """Add an exercise to the shared catalogue. Check list_exercises first so the
    same exercise isn't added twice under a slightly different name."""
    return {"id": store().add_exercise({"name": name, "muscle_group": muscle_group, "equipment": equipment,
                                        "bodyweight_factor": bodyweight_factor,
                                        "e1rm_formula": e1rm_formula}), "status": "added"}


def _find_exercise(ref: str, catalogue_: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    key = ref.strip().lower()
    return next((e for e in catalogue_
                 if e["id"] == ref or (e.get("name") or "").lower() == key), None)


# ── workouts ────────────────────────────────────────────────────────────────
class TopSet(BaseModel):
    exercise: str = Field(description="Catalogue exercise name (case-insensitive) or id.")
    reps: int = Field(ge=1, description="Reps in the top set.")
    kg: Optional[float] = Field(default=None, description=(
        "Weight of the top set. For bodyweight exercises, the ADDED load: omit for "
        "bodyweight only, negative for assisted reps."))


def _resolve_sets(sets: list[TopSet]) -> list[dict[str, Any]]:
    """Map exercise names to catalogue entries; raise listing any unknown ones."""
    catalogue_ = store().list_exercises()
    resolved, unknown = [], []
    for s in sets:
        ex = _find_exercise(s.exercise, catalogue_)
        if ex is None:
            unknown.append(s.exercise)
            continue
        resolved.append(_drop_none({"exercise_id": ex["id"], "name": ex["name"],
                                    "kg": s.kg, "reps": s.reps}))
    if unknown:
        raise ValueError(f"not in the exercise catalogue: {unknown}; "
                         "check list_exercises or add them with add_exercise")
    return resolved


@mcp.tool()
def log_workout(
    sets: list[TopSet],
    name: Optional[str] = None,
    date: Optional[str] = None,
    notes: Optional[str] = None,
    bodyweight_kg: Annotated[Optional[float], Field(gt=0, description=(
        "Bodyweight for this session; only matters for bodyweight exercises. "
        "Defaults to the latest weigh-in."))] = None,
) -> dict[str, Any]:
    """Log a workout: one top set per exercise, in the order performed. `name` is
    the session name (e.g. 'Push day'); `date` defaults to today (Sydney)."""
    date = date or sydney_today()
    data = _drop_none({"date": date, "name": name, "notes": notes, "bodyweight_kg": bodyweight_kg})
    data["exercises"] = _resolve_sets(sets)
    return {"id": _profile().add_workout(data), "status": "logged", "date": date}


@mcp.tool()
def update_workout(
    workout_id: str,
    sets: Optional[list[TopSet]] = None,
    name: Optional[str] = None,
    date: Optional[str] = None,
    notes: Optional[str] = None,
    bodyweight_kg: Annotated[Optional[float], Field(gt=0, description=(
        "Correct the bodyweight recorded for this session."))] = None,
) -> dict[str, Any]:
    """Edit a workout (id from list_workouts). Passing `sets` replaces the whole
    exercise list, so include every exercise, not just the changed one."""
    data = _drop_none({"name": name, "date": date, "notes": notes, "bodyweight_kg": bodyweight_kg})
    if sets is not None:
        data["exercises"] = _resolve_sets(sets)
    if not data:
        return {"status": "error", "detail": "no fields provided to update"}
    _profile().update_workout(workout_id, data)
    return {"id": workout_id, "status": "updated"}


@mcp.tool()
def delete_workout(workout_id: str) -> dict[str, str]:
    """Delete a workout by id (from list_workouts)."""
    _profile().delete_workout(workout_id)
    return {"id": workout_id, "status": "deleted"}


@mcp.tool()
def list_workouts(since: Optional[str] = None) -> dict[str, Any]:
    """List workouts newest first (each with its id and top sets), optionally only
    those on/after `since` ('YYYY-MM-DD')."""
    return {"workouts": _profile().list_workouts(since=since)}


@mcp.tool()
def get_exercise_history(exercise: str) -> dict[str, Any]:
    """Every top set logged for one exercise (catalogue name or id), oldest first,
    with estimated 1RM (Epley), the best set, and the kg change since the previous
    session and since the active phase began. For bodyweight exercises `kg` and
    `e1rm` are added load (e1rm_total includes the bodyweight lifted); `approx`
    marks sets above 12 reps, where the estimate is rough."""
    ex = _find_exercise(exercise, store().list_exercises())
    if ex is None:
        return {"status": "error", "detail": f"no exercise matching {exercise!r}; see list_exercises"}
    ps = _profile()
    history = workout_rules.exercise_history(ps.workouts_with_exercise(ex["id"]), ex["id"],
                                             ps.list_weights(), ex.get("e1rm_formula"))
    active = phase_rules.phase_on(ps.list_phases(), sydney_today())
    phase_start = active["start"] if active and active["kind"] == "phase" else None
    return {
        "exercise": ex["name"],
        "formula": ex.get("e1rm_formula") or workout_rules.DEFAULT_FORMULA,
        "history": history,
        "best": workout_rules.best_set(history),
        "change_vs_previous": workout_rules.kg_change(history),
        "change_this_phase": workout_rules.kg_change(history, since=phase_start) if phase_start else None,
    }


# ── Google login callback (part of the OAuth authorization-server flow) ──────
if AUTH_ENABLED:
    from starlette.requests import Request
    from starlette.responses import PlainTextResponse, RedirectResponse

    @mcp.custom_route("/google/callback", methods=["GET"])
    async def google_callback(request: Request):
        code = request.query_params.get("code")
        state = request.query_params.get("state")
        if not code or not state:
            return PlainTextResponse("missing code or state", status_code=400)
        try:
            target = await _auth_provider.complete_google_login(code, state)
        except PermissionError as e:
            return PlainTextResponse(str(e), status_code=403)
        except Exception as e:  # noqa: BLE001 — surface a readable message to the browser
            return PlainTextResponse(f"login failed: {e}", status_code=400)
        return RedirectResponse(target, status_code=302)
