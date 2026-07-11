# Ledger — a personal diet tracker on Google Cloud

A single-user food and weight tracker you deploy to **your own** Google Cloud
project. It's a small, installable web app (browse by day, log entries and
weigh-ins, dashboard with averages and a weight trend), plus an optional
authenticated MCP server so **Claude** can read and write your tracker directly.

It's designed to sit inside the **GCP free tier** — both services scale to zero,
so an idle tracker costs nothing.

- **Web UI** — a FastAPI app on Cloud Run, gated by Identity-Aware Proxy (Google
  sign-in). Only your account can reach it.
- **MCP server** (optional) — a second Cloud Run service that runs its own OAuth
  and delegates login to Google, so Claude can add entries, log weights, and read
  your dashboard on your behalf.
- **Firestore** — one small database shared by both, holding only source data;
  every total, average, and trend is computed on read.

---

## What you need

- A **Google account** and the ability to enable billing on a Google Cloud
  project. (A billing account is required even though the target cost is $0 — the
  free tier still needs one attached.)
- The **Google Cloud CLI** (`gcloud`): https://cloud.google.com/sdk/docs/install
- **Bash** (macOS/Linux, or WSL on Windows).

The web app needs no domain — it's served on a free `*.run.app` URL.

---

## Deploy the web app

### 1. Create a project and attach billing

```sh
gcloud auth login
gcloud projects create my-diet-tracker            # pick your own globally-unique id
```

Then, in the [Cloud console](https://console.cloud.google.com/):

- **Billing → Link a billing account** to the project.
- **(Recommended) Billing → Budgets & alerts → Create budget**, set to about
  **$1**, as a tripwire. The architecture is built to stay free; the alert just
  tells you if something ever isn't.

### 2. Configure the deploy

Clone this repo, then:

```sh
cp deploy.env.example deploy.env
```

Edit `deploy.env` and set at least:

- `PROJECT_ID` — the id you created above.
- `ALLOWED_EMAIL` — your Google account. Only this address will be allowed in.

`deploy.env` is gitignored so your settings and secrets stay local.

### 3. Run the deploy script

```sh
./deploy.sh
```

It enables the required APIs, creates the Firestore database, deploys the UI
behind IAP, and grants your account access. First run takes a few minutes
(mostly the container build). It's safe to re-run — services update in place.

When it finishes it prints the web URL, e.g.
`https://tracker-ui-xxxxxxxx.<region>.run.app`.

### 4. Open it

Visit the URL and sign in with your Google account. You'll land on an empty
tracker — add entries, log a weigh-in, and set your targets under **Settings**.
On a phone you can "Add to Home Screen" to install it as an app.

> **First sign-in:** if you get a **403** from IAP right after deploying, the
> access grant can take a minute to propagate, or you may need the **OAuth
> consent screen** configured once (Console → APIs & Services → OAuth consent
> screen → External → add your email as a test user). Then retry.

---

## Optional: let Claude use your tracker (MCP server)

This deploys a second service so you can add a **custom connector** in Claude and
log food or ask about your dashboard in chat. Skip it if you only want the web app.

It needs a Google OAuth client, which can't be scripted — so it's a deploy, a bit
of console setup, and a second deploy.

### 1. First pass — deploy and get the callback URL

In `deploy.env` set:

```sh
DEPLOY_MCP=yes
```

Run `./deploy.sh` again. It deploys the MCP service (locked, not yet public) and
prints a **redirect URI** like:

```
https://tracker-mcp-xxxxxxxx.<region>.run.app/google/callback
```

### 2. Create the OAuth client

In the Cloud console:

1. **APIs & Services → OAuth consent screen** — if you haven't already: choose
   **External**, fill in the basics, and add your `ALLOWED_EMAIL` as a **test
   user**.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized redirect URIs**: add the `…/google/callback` URL from step 1,
     exactly.
3. Copy the **client ID** and **client secret**.

### 3. Second pass — deploy with OAuth

Put the credentials in `deploy.env`:

```sh
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxx
```

Run `./deploy.sh` once more. It redeploys the MCP service with OAuth enabled and
prints the MCP endpoint, e.g. `https://tracker-mcp-xxxxxxxx.<region>.run.app/mcp`.

### 4. Add the connector in Claude

In Claude, add a **custom connector** pointing at the `/mcp` URL. You'll be sent
to Google to sign in once (only your allow-listed email is accepted); after that
the connector re-attaches silently. Ask Claude to "log 2 eggs and toast for
breakfast" and it'll appear in the web app immediately.

> If you redeploy the MCP service to a **new URL**, update the OAuth client's
> redirect URI to match and reconnect the connector in Claude.

---

## Local development

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev,ui,mcp]"
.venv/bin/python -m pytest            # run the test suite
```

Run the web app locally against your deployed Firestore, bypassing IAP:

```sh
GOOGLE_CLOUD_PROJECT=my-diet-tracker DEV_AUTH_BYPASS=1 \
  .venv/bin/python -m uvicorn ui.app:app --reload --port 8000
```

`DEV_AUTH_BYPASS=1` skips the IAP check for local use only — never set it in a
deployed service. (Firestore access uses your `gcloud auth application-default
login` credentials.)

---

## Cost

The target is **$0/month**. Both Cloud Run services run with `min-instances=0`,
so they cost nothing while idle (a cold start adds ~1–2 s to the first request
after a quiet spell). Firestore's free tier (1 GiB, tens of thousands of
reads/writes per day) dwarfs a personal tracker. There's no load balancer and no
always-on instance. Keep the $1 budget alert as a safety net.

---

## How it's put together

| Path | What it is |
|---|---|
| `core/` | Shared domain logic — Firestore access and all derived-value computation (totals, averages, weight regression). Imported by both services. |
| `ui/` | The web app: FastAPI + the static front-end in `ui/static/`. |
| `mcp_server/` | The MCP server: its own OAuth 2.1 layer + the record tools. |
| `tools/` | Small dev utilities (e.g. PWA icon generation). |
| `tests/` | Unit tests for the compute logic. |
| `Dockerfile` | One image for both services; `APP_MODULE` selects which. |
| `deploy.sh` | The deploy script described above. |

Both services import the same `core` module and differ only in entrypoint and
auth model. Firestore stores source data only; nothing derived is ever persisted.

---

## Tear it down

To stop everything (and avoid any chance of cost):

```sh
gcloud run services delete tracker-ui  --region <your-region>
gcloud run services delete tracker-mcp --region <your-region>   # if you deployed it
```

To remove everything, delete the project: **Console → IAM & Admin → Settings →
Shut down**, or `gcloud projects delete <project-id>`.
