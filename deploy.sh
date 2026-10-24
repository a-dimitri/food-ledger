#!/usr/bin/env bash
#
# deploy.sh — deploy the Diet Tracker to your own Google Cloud project.
#
# Deploys the IAP-gated web UI, and (optionally) the OAuth-gated MCP server that
# lets Claude read and write your tracker. Both run on Cloud Run, scale to zero,
# and share one Firestore database. Safe to re-run: existing services are
# updated in place.
#
# Configure by copying deploy.env.example to deploy.env and editing it, or by
# exporting the same variables. Required: PROJECT_ID, ALLOWED_EMAILS.
#
#   ./deploy.sh
#
# See README.md for the full walkthrough, including the one-time console steps
# (billing, and — only if you want the MCP server — the Google OAuth client).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# ── config ──────────────────────────────────────────────────────────────────
if [ -f deploy.env ]; then
  echo "Loading configuration from deploy.env"
  set -a; . ./deploy.env; set +a
fi

PROJECT_ID="${PROJECT_ID:-}"
# Space-separated Google accounts granted IAP access (one per profile). The app
# itself admits an email only if it is listed on a profile in Firestore.
# ALLOWED_EMAIL (singular, v1) is still accepted.
ALLOWED_EMAILS="${ALLOWED_EMAILS:-${ALLOWED_EMAIL:-}}"
REGION="${REGION:-australia-southeast1}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-$REGION}"
UI_SERVICE="${UI_SERVICE:-tracker-ui}"
MCP_SERVICE="${MCP_SERVICE:-tracker-mcp}"
DEPLOY_MCP="${DEPLOY_MCP:-no}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
# Preferred over GOOGLE_CLIENT_SECRET: the name of a Secret Manager secret that
# holds it. The service then reads the secret at runtime and its value never
# appears in deploy.env or the service's plain environment.
GOOGLE_CLIENT_SECRET_NAME="${GOOGLE_CLIENT_SECRET_NAME:-}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── preflight ───────────────────────────────────────────────────────────────
command -v gcloud >/dev/null || die "gcloud not found — install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install)."
[ -n "$PROJECT_ID" ]    || die "PROJECT_ID is not set. Copy deploy.env.example to deploy.env and fill it in."
[ -n "$ALLOWED_EMAILS" ] || die "ALLOWED_EMAILS is not set. These are the Google accounts allowed to use the app."
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || die "No active gcloud login — run: gcloud auth login"

step "Target: project=$PROJECT_ID  region=$REGION  users=$ALLOWED_EMAILS"
gcloud config set project "$PROJECT_ID" >/dev/null

# ── APIs ────────────────────────────────────────────────────────────────────
step "Enabling required APIs (the first run can take a minute)"
gcloud services enable \
  run.googleapis.com firestore.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com iap.googleapis.com

# ── Firestore ───────────────────────────────────────────────────────────────
step "Ensuring a Firestore (Native) database exists"
if gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  echo "Firestore already provisioned."
else
  gcloud firestore databases create --location="$FIRESTORE_LOCATION" --type=firestore-native
fi

# ── runtime service account → Firestore ─────────────────────────────────────
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
step "Granting Firestore access to the Cloud Run runtime service account"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/datastore.user \
  --condition=None >/dev/null

# ── web UI ──────────────────────────────────────────────────────────────────
step "Deploying the web UI ($UI_SERVICE) behind IAP"
# --iap fronts the service with Identity-Aware Proxy (Google login). The app
# also validates IAP's injected identity header, and admits only emails listed
# on a profile (profiles/<id>.emails in Firestore).
gcloud run deploy "$UI_SERVICE" \
  --source . --region "$REGION" \
  --min-instances=0 --no-allow-unauthenticated --iap \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"

for email in $ALLOWED_EMAILS; do
  step "Granting $email access through IAP"
  # Cloud Run's direct IAP keeps its own policy: the accessor role is granted
  # there, not on the Cloud Run service (which rejects this role).
  gcloud iap web add-iam-policy-binding --resource-type=cloud-run \
    --service="$UI_SERVICE" --region="$REGION" \
    --member="user:${email}" --role=roles/iap.httpsResourceAccessor >/dev/null \
    || echo "WARN: could not add the IAP accessor binding automatically. Grant '$email' the 'IAP-secured Web App User' role on $UI_SERVICE in the console."
done
# The IAP service agent must be able to invoke the service. gcloud --iap usually
# wires this up; add it best-effort in case it did not.
gcloud run services add-iam-policy-binding "$UI_SERVICE" --region "$REGION" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role=roles/run.invoker >/dev/null 2>&1 || true

# A service's public URL. Cloud Run gives each service two permanent URLs; use
# the readable https://<service>-<project number>.<region>.run.app one, so the
# MCP server's ISSUER_URL (and the OAuth redirect URI derived from it) stays the
# address people bookmark and connect Claude to. Falls back to status.url.
# Prints nothing if the service doesn't exist yet.
service_url() {
  local info readable
  info="$(gcloud run services describe "$1" --region "$REGION" \
    --format='value(metadata.annotations["run.googleapis.com/urls"],status.url)' 2>/dev/null)" || return 0
  readable="$(printf '%s' "$info" | grep -oE "https://${1}-${PROJECT_NUMBER}\.${REGION}\.run\.app" | head -1 || true)"
  if [ -n "$readable" ]; then
    echo "$readable"
  else
    printf '%s' "$info" | grep -oE 'https://[^",; ]+\.run\.app' | tail -1 || true
  fi
}

UI_URL="$(service_url "$UI_SERVICE")"

# ── MCP server (optional) ───────────────────────────────────────────────────
MCP_URL=""
if [ "$DEPLOY_MCP" = "yes" ]; then
  MCP_URL="$(service_url "$MCP_SERVICE")"

  if [ -z "$GOOGLE_CLIENT_ID" ] || { [ -z "$GOOGLE_CLIENT_SECRET" ] && [ -z "$GOOGLE_CLIENT_SECRET_NAME" ]; }; then
    # We need the service URL first so we can tell you which redirect URI to
    # register on the OAuth client. Deploy it locked (no public access), then stop.
    if [ -z "$MCP_URL" ]; then
      step "Deploying $MCP_SERVICE (locked) to obtain its URL"
      gcloud run deploy "$MCP_SERVICE" --source . --region "$REGION" \
        --min-instances=0 --no-allow-unauthenticated \
        --set-env-vars "APP_MODULE=mcp_server.app:app,GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
      MCP_URL="$(service_url "$MCP_SERVICE")"
    fi
    cat <<EOF

$(bold "MCP server is deployed but not yet usable — it needs a Google OAuth client.")
  1. Console → APIs & Services → Credentials → "Create credentials" →
     "OAuth client ID" → Application type "Web application".
  2. Under "Authorized redirect URIs" add exactly:
         ${MCP_URL}/google/callback
  3. Copy the client ID into deploy.env as GOOGLE_CLIENT_ID, and either the
     secret as GOOGLE_CLIENT_SECRET or (better) the name of a Secret Manager
     secret holding it as GOOGLE_CLIENT_SECRET_NAME (see README). Keep
     DEPLOY_MCP=yes, then re-run ./deploy.sh.
EOF
    echo
    bold "Web UI is live: ${UI_URL}"
    exit 0
  fi

  step "Deploying the MCP server ($MCP_SERVICE) with OAuth"
  # First deploy (if brand new) to mint the URL so ISSUER_URL can point at itself.
  if [ -z "$MCP_URL" ]; then
    gcloud run deploy "$MCP_SERVICE" --source . --region "$REGION" \
      --min-instances=0 --no-allow-unauthenticated \
      --set-env-vars "APP_MODULE=mcp_server.app:app,GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
    MCP_URL="$(service_url "$MCP_SERVICE")"
  fi
  # Public at the network layer (Claude reaches it without Google IAM); the app's
  # own OAuth bearer gates every /mcp call, and unauthenticated requests get 401.
  # Login is admitted only for emails listed on a profile, and each person's
  # tools act on their own profile.
  MCP_ENV="APP_MODULE=mcp_server.app:app,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},ISSUER_URL=${MCP_URL},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}"
  if [ -n "$GOOGLE_CLIENT_SECRET_NAME" ]; then
    # The secret stays in Secret Manager; the runtime service account needs the
    # Secret Manager Secret Accessor role on it (see README).
    gcloud run deploy "$MCP_SERVICE" --source . --region "$REGION" \
      --min-instances=0 --allow-unauthenticated \
      --set-env-vars "$MCP_ENV" \
      --set-secrets "GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET_NAME}:latest"
  else
    gcloud run deploy "$MCP_SERVICE" --source . --region "$REGION" \
      --min-instances=0 --allow-unauthenticated \
      --set-env-vars "${MCP_ENV},GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}"
  fi
fi

# ── summary ─────────────────────────────────────────────────────────────────
step "Done"
bold "Web UI:  ${UI_URL}"
echo "         Open it and sign in as one of: ${ALLOWED_EMAILS}."
if [ "$DEPLOY_MCP" = "yes" ] && [ -n "$MCP_URL" ]; then
  bold "MCP:     ${MCP_URL}/mcp"
  echo "         Add this as a custom connector in Claude (see README)."
  echo "         Redirect URI on your OAuth client must be: ${MCP_URL}/google/callback"
fi
