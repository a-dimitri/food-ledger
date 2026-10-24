# Ledger — a personal diet and training tracker on Google Cloud

A small food, weight and training tracker for a household, deployed to **your
own** Google Cloud project. Each person gets their own **profile** (food log,
weigh-ins, phases, workouts, routines); the food **pantry** and the **exercise
catalogue** are shared. It's an installable web app, plus an optional
authenticated MCP server so **Claude** can read and write each person's
tracker directly.

- **Food** — log from the shared pantry (scaled by quantity) or manually; daily
  totals against that day's targets.
- **Phases** — date windows (a cut, a bulk, …) with their own daily targets and
  weight goal. **Untracked** windows mark time off (e.g. a holiday): no targets,
  no food logging, and charts don't draw across them. Days outside any phase
  use the profile's default targets.
- **Training** — one top set (kg × reps) per exercise per workout, routines to
  prefill from, and per-exercise history with estimated 1RM.
- **Insights** — calories vs target, per-phase averages and adherence, weight
  trend (or BMI) with a maintenance estimate, and lifts — all with phase bands.

It's designed to sit inside the **GCP free tier** — both services scale to zero,
so an idle tracker costs nothing.

- **Web UI** — a FastAPI app on Cloud Run, gated by Identity-Aware Proxy (Google
  sign-in). Only the Google accounts linked to a profile get in.
- **MCP server** (optional) — a second Cloud Run service that runs its own OAuth
  and delegates login to Google. Each person connects their own Claude, and
  Claude can only ever act on the profile of whoever signed in.
- **Firestore** — one small database shared by both, holding only source data;
  every total, average, and trend is computed on read.

---

## What you need

- A **Google account** for each person, and the ability to enable billing on a
  Google Cloud project. (A billing account is required even though the target
  cost is $0 — the free tier still needs one attached.)
- The **Google Cloud CLI** (`gcloud`): https://cloud.google.com/sdk/docs/install
- **Bash** (macOS/Linux, or WSL on Windows), and **Python 3.12+** for the setup
  scripts.

The web app needs no domain — it's served on a free `*.run.app` URL.

---

## Deploy the web app

### 1. Create a project and attach billing

```sh
gcloud auth login
gcloud auth application-default login             # lets the setup scripts reach Firestore
gcloud projects create my-diet-tracker            # pick your own globally-unique id
```

Then, in the [Cloud console](https://console.cloud.google.com/):

- **Billing → Link a billing account** to the project.
- **(Recommended) Billing → Budgets & alerts → Create budget**, set to about
  **$1**, as a tripwire. The architecture is built to stay free; the alert just
  tells you if something ever isn't.

### 2. Configure the deploy

`deploy.sh` reads its settings from the environment, or from a `deploy.env` file
if you'd rather keep them in one place (`cp deploy.env.example deploy.env`; it's
gitignored). The required settings:

- `PROJECT_ID` — the id you created above.
- `ALLOWED_EMAILS` — the Google accounts that will use the app, space-separated
  (one per profile). Each is granted access through IAP.

### 3. Run the deploy script

```sh
PROJECT_ID=my-diet-tracker \
ALLOWED_EMAILS="you@gmail.com partner@gmail.com" \
  ./deploy.sh
```

It enables the required APIs, creates the Firestore database, deploys the UI
behind IAP, and grants each account access. First run takes a few minutes
(mostly the container build). It's safe to re-run — services update in place.

When it finishes it prints the web URL, e.g.
`https://tracker-ui-xxxxxxxx.<region>.run.app`.

### 4. Create the profiles

IAP decides who can reach the app; the app then admits an account only if its
email is linked to a profile. Create one profile per person:

```sh
python3 -m venv .venv && .venv/bin/python -m pip install -e ".[ui]"
.venv/bin/python tools/add_profile.py --project my-diet-tracker --id alex --name Alex --email you@gmail.com
.venv/bin/python tools/add_profile.py --project my-diet-tracker --id sam  --name Sam  --email partner@gmail.com
.venv/bin/python tools/add_profile.py --project my-diet-tracker --list
```

Who can sign in is deliberately only changeable here, never from inside the
app. To add someone later: create their profile, add their email to
`ALLOWED_EMAILS`, and re-run `./deploy.sh`.

### 5. Open it

Visit the URL and sign in with one of the linked Google accounts — you land on
your own profile. Set your default targets under **Settings** (⚙), your height
under **Profiles** (the avatar), and add a phase under **Nutrition → Phases**.
Anyone can view and edit the other profile via the avatar → **Switch**; there are
no per-profile permissions. On a phone you can "Add to Home Screen" to install
it as an app.

> **First sign-in:** if you get a **403** from IAP right after deploying, the
> access grant can take a minute to propagate, or you may need the **OAuth
> consent screen** configured once (Console → APIs & Services → OAuth consent
> screen → External → add **each** person's email as a test user). Then retry.
> A page saying the account "isn't linked to a profile" means step 4 is missing
> for that email.

---

## Optional: let Claude use your tracker (MCP server)

This deploys a second service so each person can add a **custom connector** in
their own Claude and log food, weigh-ins or workouts, or ask about their
dashboard, in chat. Skip it if you only want the web app.

It needs a Google OAuth client, which can't be scripted — so it's a deploy, a bit
of console setup, and a second deploy.

### 1. First pass — deploy and get the callback URL

Run `./deploy.sh` again with `DEPLOY_MCP=yes` added. It deploys the MCP service
(locked, not yet public) and prints a **redirect URI** like:

```
https://tracker-mcp-xxxxxxxx.<region>.run.app/google/callback
```

### 2. Create the OAuth client

In the Cloud console:

1. **APIs & Services → OAuth consent screen** — if you haven't already: choose
   **External**, fill in the basics, and add each person's email as a **test
   user**.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs**: add the `…/google/callback` URL from step 1,
     exactly.
3. Copy the **client ID** and **client secret**.

### 3. Second pass — deploy with OAuth

Run `./deploy.sh` once more with `DEPLOY_MCP=yes`, `GOOGLE_CLIENT_ID`, and the
client secret set. It redeploys the MCP service with OAuth enabled and prints
the MCP endpoint, e.g. `https://tracker-mcp-xxxxxxxx.<region>.run.app/mcp`.

For the secret, either set `GOOGLE_CLIENT_SECRET` to its value (simplest — it
becomes a plain environment variable on the service), or keep it in **Secret
Manager** and set `GOOGLE_CLIENT_SECRET_NAME` to the secret's name instead
(recommended — the value never appears in `deploy.env` or the service config):

```sh
gcloud services enable secretmanager.googleapis.com
printf '%s' 'THE-CLIENT-SECRET' | gcloud secrets create tracker-mcp-google-client-secret --data-file=-
gcloud secrets add-iam-policy-binding tracker-mcp-google-client-secret \
  --member="serviceAccount:$(gcloud projects describe my-diet-tracker --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

Once a service uses Secret Manager, keep using `GOOGLE_CLIENT_SECRET_NAME`:
Cloud Run won't switch a secret-backed variable back to a plain one.

### 4. Add the connector in Claude

Each person adds a **custom connector** in their own Claude pointing at the
`/mcp` URL, and signs in with their own Google account. Only verified Google
accounts linked to a profile are accepted, and every tool acts on the signed-in
person's profile — there is no way for one person's Claude to read or write the
other's. (The pantry and exercise catalogue are shared, as in the app.) Ask
Claude to "log 2 eggs and toast for breakfast" and it appears in the web app
immediately.

> **After a redeploy** the connector's session is dropped; reconnect it in
> Claude. If the MCP service moves to a **new URL**, also update the OAuth
> client's redirect URI to match.

---

## Upgrading from v1 (single user)

v2 moves the single user's data under a profile. `tools/migrate_v2.py` does it
in three separate steps:

```sh
# 1. Read-only: dump every collection to backups/<timestamp>/ (gitignored)
.venv/bin/python tools/migrate_v2.py backup --project my-diet-tracker

# 2. Copy the v1 entries / weights / day rollups into the owner's profile and
#    create the second profile. The v1 collections are left untouched, and
#    re-running it brings the copy back in line with v1.
.venv/bin/python tools/migrate_v2.py migrate --project my-diet-tracker \
  --owner-email you@gmail.com --other-email partner@gmail.com
```

The `migrate` step creates the profiles `antoni` and `emy` (edit `OWNER` /
`OTHER` at the top of the script for your own). The v1 targets become the
owner's default targets; the v1 goal weight/date isn't carried over, as goals
now live on phases. Then deploy as above with `ALLOWED_EMAILS` (the old
`ALLOWED_EMAIL` still works for a single account) and reconnect the Claude
connector. Once v2 is live and checked:

```sh
# 3. Delete the v1 top-level collections (after re-verifying the copy)
.venv/bin/python tools/migrate_v2.py cleanup --project my-diet-tracker --yes
```

---

## Local development

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev,ui,mcp]"
.venv/bin/python -m pytest            # run the test suite
```

Run the web app locally against your deployed Firestore, bypassing IAP:

```sh
GOOGLE_CLOUD_PROJECT=my-diet-tracker DEV_AUTH_BYPASS=1 DEV_PROFILE=alex \
  .venv/bin/python -m uvicorn ui.app:app --reload --port 8000
```

`DEV_AUTH_BYPASS=1` skips the IAP check for local use only — never set it in a
deployed service. `DEV_PROFILE` picks the profile you land on. Firestore access
uses your `gcloud auth application-default login` credentials, and writes go to
the real database.

The MCP server runs the same way with `uvicorn mcp_server.app:app --port 8001`;
without the OAuth settings it is unauthenticated and acts as `MCP_DEV_PROFILE`.

The front-end is plain ES modules under `ui/static/js/` — no build step.

---

## Cost

The target is **$0/month**. Both Cloud Run services run with `min-instances=0`,
so they cost nothing while idle (a cold start adds ~1–2 s to the first request
after a quiet spell). Firestore's free tier (1 GiB, tens of thousands of
reads/writes per day) dwarfs a household tracker. There's no load balancer and
no always-on instance. Keep the $1 budget alert as a safety net.

---

## How it's put together

| Path | What it is |
|---|---|
| `core/` | Shared domain logic — Firestore access (`store.py`) and all derived values: totals, averages, weight regression (`compute.py`), phase rules (`phases.py`), top sets and 1RM (`workouts.py`). Imported by both services. |
| `ui/` | The web app: FastAPI JSON API (`app.py`) + the static front-end in `ui/static/`. |
| `mcp_server/` | The MCP server: its own OAuth 2.1 layer + the tools, each bound to the caller's profile. |
| `tools/` | Setup scripts (`add_profile.py`, `migrate_v2.py`) and dev utilities (PWA icon generation). |
| `tests/` | Unit tests for compute, phases, workouts, and the API/MCP access rules. |
| `Dockerfile` | One image for both services; `APP_MODULE` selects which. |
| `deploy.sh` | The deploy script described above. |

Firestore holds `profiles/<id>` (with each person's entries, weights, day
rollups, phases, workouts and routines underneath) plus the shared `foods`
(pantry) and `exercises` collections. Nothing derived is persisted except the
per-day rollups, which are rebuilt on every food write.

---

## Tear it down

To stop everything (and avoid any chance of cost):

```sh
gcloud run services delete tracker-ui  --region <your-region>
gcloud run services delete tracker-mcp --region <your-region>   # if you deployed it
```

To remove everything, delete the project: **Console → IAM & Admin → Settings →
Shut down**, or `gcloud projects delete <project-id>`.
