"""MCP server exposing the diet tracker as tools for Claude.

Per-record tools over the shared core.store (the same Firestore the web UI uses),
so a record Claude writes is immediately visible in the UI and vice-versa. This
module defines the tools and the FastMCP app; auth is layered on in app.py.
"""

from __future__ import annotations

import os
from typing import Annotated, Any, Optional
from urllib.parse import urlparse

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field

from core import catalogue, compute
from core.store import Store, get_client
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
Diet tracker for a single user (Sydney timezone). Log food entries and weigh-ins,
and read daily tallies, averages, and weight trend. Dates are 'YYYY-MM-DD', times
are 'HH:MM' (24h). Nutrient units: calories (kcal), protein/carbs/fat/fiber/sugar
(grams), sodium (mg). When the user reports eating something, add an entry; when
they report a weight, log a weigh-in.

Call get_today first to resolve the current date AND time (Sydney), then set an
entry's `time` to that current time unless the user gives a specific one. Capture
`quantity` (how much) and `source` (brand/where) whenever the user mentions them —
don't leave them blank when the information was given.

Frequently-eaten items can be saved to a catalogue (save_food) with nutrients
per one unit/serving, then logged by name at any quantity via add_entry_from_food
(e.g. '2 bowls of my usual oats') without re-supplying the full breakdown. Prefer
that over add_entry when a matching saved food already exists (see list_foods)."""

# Auth is enabled when the OAuth/Google config is present (prod); without it the
# server runs unauthenticated for local tool testing.
ISSUER_URL = os.environ.get("ISSUER_URL")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
ALLOWED_EMAIL = os.environ.get("ALLOWED_EMAIL")
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
AUTH_ENABLED = bool(ISSUER_URL and GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)

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

_auth_provider = None
if AUTH_ENABLED:
    from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions

    from mcp_server.auth import FirestoreOAuthProvider

    _issuer = ISSUER_URL.rstrip("/")
    _auth_provider = FirestoreOAuthProvider(
        get_client(project=PROJECT), _issuer,
        GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAIL,
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

_store: Optional[Store] = None


def store() -> Store:
    global _store
    if _store is None:
        _store = Store(project=os.environ.get("GOOGLE_CLOUD_PROJECT"))
    return _store


def _entry_data(
    date: str, food: str, time: Optional[str], quantity: Optional[str],
    source: Optional[str], notes: Optional[str],
    calories: Optional[float], protein: Optional[float], carbs: Optional[float],
    fat: Optional[float], fiber: Optional[float], sodium: Optional[float], sugar: Optional[float],
) -> dict[str, Any]:
    fields = {
        "date": date, "food": food, "time": time, "quantity": quantity,
        "source": source, "notes": notes, "calories": calories, "protein": protein,
        "carbs": carbs, "fat": fat, "fiber": fiber, "sodium": sodium, "sugar": sugar,
    }
    return {k: v for k, v in fields.items() if v is not None}


@mcp.tool()
def get_today() -> dict[str, str]:
    """Return the current date and time in Sydney: {'today': 'YYYY-MM-DD',
    'now': 'HH:MM'}. Resolve 'today'/'now' from this before logging; use `now`
    as an entry's time unless the user gives a specific time."""
    return {"today": sydney_today(), "now": sydney_now()}


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
    Returns the new entry id."""
    date = date or sydney_today()
    time = time or sydney_now()
    data = _entry_data(date, food, time, quantity, source, notes,
                       calories, protein, carbs, fat, fiber, sodium, sugar)
    entry_id = store().add_entry(data)
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
    fields = {
        "food": food, "date": date, "time": time, "quantity": quantity,
        "source": source, "notes": notes, "calories": calories, "protein": protein,
        "carbs": carbs, "fat": fat, "fiber": fiber, "sodium": sodium, "sugar": sugar,
    }
    data = {k: v for k, v in fields.items() if v is not None}
    if not data:
        return {"status": "error", "detail": "no fields provided to update"}
    store().update_entry(entry_id, data)
    return {"id": entry_id, "status": "updated"}


@mcp.tool()
def delete_entry(entry_id: str) -> dict[str, str]:
    """Delete an entry by id (get the id from list_entries)."""
    store().delete_entry(entry_id)
    return {"id": entry_id, "status": "deleted"}


# ── catalogue (saved foods) ─────────────────────────────────────────────────
def _find_food(store_: Store, food: str) -> Optional[dict[str, Any]]:
    """Resolve a catalogue item by document id, else by case-insensitive name."""
    by_id = store_.get_food(food)
    if by_id:
        return by_id
    key = food.strip().lower()
    return next((f for f in store_.list_foods() if (f.get("name") or "").lower() == key), None)


@mcp.tool()
def list_foods() -> dict[str, Any]:
    """List saved foods in the catalogue (most-used first). Each item has a name,
    optional unit/source, and `per` = nutrients for one unit. Use its name (or id)
    with add_entry_from_food to log it at a chosen quantity."""
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
    """Save a reusable food to the catalogue. Nutrients are PER ONE unit (e.g. one
    serving/bowl/100g named by `unit`); logging later multiplies them by quantity.
    Provide whatever nutrients are known; omit the rest."""
    per = {k: v for k, v in {
        "calories": calories, "protein": protein, "carbs": carbs, "fat": fat,
        "fiber": fiber, "sodium": sodium, "sugar": sugar,
    }.items() if v is not None}
    data = {"name": name, "per": per}
    if unit is not None:
        data["unit"] = unit
    if source is not None:
        data["source"] = source
    food_id = store().add_food(data)
    return {"id": food_id, "status": "saved"}


@mcp.tool()
def add_entry_from_food(
    food: str,
    quantity: float = 1.0,
    date: Optional[str] = None,
    time: TimeField = None,
) -> dict[str, Any]:
    """Log a food from the catalogue at `quantity` units (default 1). `food` is a
    saved food's name (case-insensitive) or id; its per-unit nutrients are scaled
    by `quantity` and stored as a normal entry. `date` and `time` default to now
    (Sydney)."""
    item = _find_food(store(), food)
    if item is None:
        return {"status": "error", "detail": f"no saved food matching {food!r}; see list_foods"}
    date = date or sydney_today()
    time = time or sydney_now()
    data = catalogue.scale(item, quantity, date=date, time=time)
    entry_id = store().add_entry(data)
    store().increment_food_use(item["id"])
    return {"id": entry_id, "status": "added", "date": date, "entry": data}


@mcp.tool()
def delete_food(food_id: str) -> dict[str, str]:
    """Delete a saved food from the catalogue by id (get it from list_foods).
    Past entries logged from it are unaffected."""
    store().delete_food(food_id)
    return {"id": food_id, "status": "deleted"}


@mcp.tool()
def list_entries(date: Optional[str] = None) -> dict[str, Any]:
    """List food entries for a day (defaults to today), sorted by time. Each entry
    includes its id for editing/deleting."""
    date = date or sydney_today()
    return {"date": date, "entries": store().list_entries(date)}


@mcp.tool()
def get_day_summary(date: Optional[str] = None) -> dict[str, Any]:
    """Per-nutrient totals for a day (defaults to today) alongside the targets."""
    date = date or sydney_today()
    entries = store().list_entries(date)
    cfg = store().get_config()
    return {
        "date": date,
        "totals": compute.day_total(entries, date),
        "targets": cfg.get("targets", {}),
        "entry_count": len(entries),
    }


@mcp.tool()
def get_dashboard() -> dict[str, Any]:
    """Overview: average daily intake across fully-tracked days, targets, goals,
    and the weight trend (rate, latest, estimated maintenance calories)."""
    today = sydney_today()
    cfg = store().get_config()
    rollups = store().list_day_rollups()
    day_totals = {r["date"]: r.get("totals", {}) for r in rollups}
    completed = [r["date"] for r in rollups if r.get("completed")]
    averages, tracked_count = compute.averages_from_day_totals(day_totals, today, completed)
    weights = store().list_weights()
    return {
        "today": today,
        "targets": cfg.get("targets", {}),
        "goal_weight": cfg.get("goal_weight"),
        "goal_date": cfg.get("goal_date"),
        "averages": averages,
        "tracked_count": tracked_count,
        "weight_stats": compute.weight_stats(weights, averages.get("calories", 0.0)),
    }


@mcp.tool()
def log_weight(kg: float, when: Optional[str] = None) -> dict[str, Any]:
    """Log a weigh-in. `when` is an ISO datetime 'YYYY-MM-DDTHH:MM'; defaults to
    today at 08:00."""
    when = when or (sydney_today() + "T08:00")
    weight_id = store().add_weight(when, kg)
    return {"id": weight_id, "status": "logged", "datetime": when, "kg": kg}


@mcp.tool()
def list_weights() -> dict[str, Any]:
    """List all weigh-ins (each with its id), oldest first."""
    return {"weights": store().list_weights()}


@mcp.tool()
def set_targets(
    calories: Optional[float] = None,
    protein: Optional[float] = None,
    carbs: Optional[float] = None,
    fat: Optional[float] = None,
    fiber: Optional[float] = None,
    sodium: Optional[float] = None,
    sugar: Optional[float] = None,
) -> dict[str, str]:
    """Update daily nutrient targets. Only the values you pass are changed."""
    fields = {"calories": calories, "protein": protein, "carbs": carbs, "fat": fat,
              "fiber": fiber, "sodium": sodium, "sugar": sugar}
    targets = {k: v for k, v in fields.items() if v is not None}
    if not targets:
        return {"status": "error", "detail": "no target values provided"}
    cfg = store().get_config()
    merged = {**cfg.get("targets", {}), **targets}
    store().set_config({"targets": merged})
    return {"status": "updated"}


@mcp.tool()
def set_goal(goal_weight: Optional[float] = None, goal_date: Optional[str] = None) -> dict[str, str]:
    """Set the weight goal and/or goal date ('YYYY-MM-DD')."""
    data: dict[str, Any] = {}
    if goal_weight is not None:
        data["goal_weight"] = goal_weight
    if goal_date is not None:
        data["goal_date"] = goal_date
    if not data:
        return {"status": "error", "detail": "provide goal_weight and/or goal_date"}
    store().set_config(data)
    return {"status": "updated"}


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
