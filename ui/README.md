# ui — web app

FastAPI JSON API (`app.py`) plus the static front-end (`static/`, plain ES
modules, no build step), served together on Cloud Run behind IAP. Callers are
admitted only if their email is listed on a profile; per-profile routes live
under `/api/p/{profile}/…`, the pantry and exercise catalogue are shared.
Imports `core` for all derived-value computation.
