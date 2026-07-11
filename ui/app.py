"""FastAPI app for the human web UI.

Scoped JSON API — no monolithic "load everything" endpoint. Reads are decomposed
so each scales with what it needs (see REQUIREMENTS.md §5 Stage 1):

    GET  /api/dates              date list for navigation (from `days` rollups)
    GET  /api/day/{date}         one day's entries + totals + targets
    GET  /api/dashboard          averages (from rollups) + weight stats + goals
    POST /api/entries            add an entry
    PATCH  /api/entries/{id}     edit an entry
    DELETE /api/entries/{id}     delete an entry
    GET  /api/foods              list saved foods (the catalogue)
    POST /api/foods              save a food; PATCH/DELETE /api/foods/{id}
    POST /api/weights            log a weigh-in
    DELETE /api/weights/{id}     delete a weigh-in
    PUT  /api/config             update targets / goals
    POST /api/days/{date}/complete   mark an in-progress day as tracked

Auth: in production the service sits behind IAP; this app validates the injected
assertion as defence-in-depth. Locally, set DEV_AUTH_BYPASS=1 to skip it.
The HTML front-end (the "Ledger" view) is served on top of this API and is added
next, once we can run it against imported data.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core import compute
from core.store import Store
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


# ── auth ──────────────────────────────────────────────────────────────────
IAP_AUDIENCE = os.environ.get("IAP_AUDIENCE")           # set in prod
ALLOWED_EMAIL = os.environ.get("ALLOWED_EMAIL")          # single-user allowlist
DEV_BYPASS = os.environ.get("DEV_AUTH_BYPASS") == "1"


def current_user(
    x_goog_iap_jwt_assertion: Optional[str] = Header(default=None),
    x_goog_authenticated_user_email: Optional[str] = Header(default=None),
) -> str:
    """Return the authorized caller email, or 401/403.

    IAP is the platform gate. This resolves the caller identity from IAP's
    injected headers and enforces the single-user allowlist:
      - If IAP_AUDIENCE is set, cryptographically verify the signed JWT
        assertion (strongest — defence in depth).
      - Otherwise trust the X-Goog-Authenticated-User-Email header, which is
        safe because IAP rejects ingress that doesn't pass through it.
    DEV_AUTH_BYPASS=1 short-circuits for local development.
    """
    if DEV_BYPASS:
        return ALLOWED_EMAIL or "dev@localhost"

    email: Optional[str] = None
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

    if not email or (ALLOWED_EMAIL and email != ALLOWED_EMAIL):
        raise HTTPException(status_code=403, detail="not authorized")
    return email


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


class ConfigIn(BaseModel):
    targets: Optional[dict[str, float]] = None
    goal_weight: Optional[float] = None
    goal_date: Optional[str] = None


class CompleteIn(BaseModel):
    completed: bool = True


# ── read endpoints ──────────────────────────────────────────────────────────
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


@app.get("/api/today")
def get_today(user: str = Depends(current_user)) -> dict[str, str]:
    return {"today": sydney_today()}


@app.get("/api/dates")
def get_dates(user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, Any]:
    today = sydney_today()
    rollups = store.list_day_rollups()
    dates = [
        {"date": r["date"], "entry_count": r.get("entry_count", 0), "completed": r.get("completed", False)}
        for r in rollups
    ]
    if not any(d["date"] == today for d in dates):
        dates.append({"date": today, "entry_count": 0, "completed": False})
    dates.sort(key=lambda d: d["date"], reverse=True)
    return {"today": today, "dates": dates}


@app.get("/api/day/{date}")
def get_day(date: str, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, Any]:
    entries = store.list_entries(date)
    cfg = store.get_config()
    return {
        "date": date,
        "entries": entries,
        "totals": compute.day_total(entries, date),
        "targets": cfg.get("targets", {}),
    }


@app.get("/api/dashboard")
def get_dashboard(user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, Any]:
    today = sydney_today()
    cfg = store.get_config()
    rollups = store.list_day_rollups()
    day_totals = {r["date"]: r.get("totals", {}) for r in rollups}
    completed = [r["date"] for r in rollups if r.get("completed")]
    averages, tracked_count = compute.averages_from_day_totals(day_totals, today, completed)
    weights = store.list_weights()
    # Per-day series for the dashboard charts. Ordered oldest-first; the client
    # windows it to the selected 7/30/90-day range.
    days = [
        {"date": r["date"], "totals": r.get("totals", {}), "completed": r.get("completed", False)}
        for r in rollups
        if r.get("date")
    ]
    return {
        "today": today,
        "targets": cfg.get("targets", {}),
        "goal_weight": cfg.get("goal_weight"),
        "goal_date": cfg.get("goal_date"),
        "averages": averages,
        "tracked_count": tracked_count,
        "days": days,
        "weights": weights,
        "weight_stats": compute.weight_stats(weights, averages.get("calories", 0.0)),
    }


# ── write endpoints ─────────────────────────────────────────────────────────
@app.post("/api/entries")
def create_entry(body: EntryIn, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    entry_id = store.add_entry(body.model_dump(exclude_none=True))
    return {"id": entry_id}


@app.patch("/api/entries/{entry_id}")
def edit_entry(entry_id: str, body: EntryPatch, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="no fields to update")
    store.update_entry(entry_id, data)
    return {"id": entry_id}


@app.delete("/api/entries/{entry_id}")
def remove_entry(entry_id: str, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    store.delete_entry(entry_id)
    return {"id": entry_id}


# ── catalogue (saved foods) ─────────────────────────────────────────────────
# CRUD only. Scaling a food into an entry happens client-side (multiply `per`
# by the quantity) and posts through the normal /api/entries path, so entries
# stay self-contained snapshots and this endpoint has no scaling logic.
@app.get("/api/foods")
def get_foods(user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, Any]:
    return {"foods": store.list_foods()}


@app.post("/api/foods")
def create_food(body: FoodIn, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    food_id = store.add_food(body.model_dump(exclude_none=True))
    return {"id": food_id}


@app.patch("/api/foods/{food_id}")
def edit_food(food_id: str, body: FoodPatch, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="no fields to update")
    store.update_food(food_id, data)
    return {"id": food_id}


@app.delete("/api/foods/{food_id}")
def remove_food(food_id: str, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    store.delete_food(food_id)
    return {"id": food_id}


@app.post("/api/weights")
def create_weight(body: WeightIn, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    weight_id = store.add_weight(body.datetime, body.kg)
    return {"id": weight_id}


@app.delete("/api/weights/{weight_id}")
def remove_weight(weight_id: str, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    store.delete_weight(weight_id)
    return {"id": weight_id}


@app.put("/api/config")
def put_config(body: ConfigIn, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="no fields to update")
    store.set_config(data)
    return {"status": "ok"}


@app.post("/api/days/{date}/complete")
def complete_day(date: str, body: CompleteIn, user: str = Depends(current_user), store: Store = Depends(get_store)) -> dict[str, str]:
    store.set_day_completed(date, body.completed)
    return {"status": "ok"}
