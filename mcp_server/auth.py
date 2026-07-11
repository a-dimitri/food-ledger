"""OAuth 2.1 authorization server for the MCP service, with login delegated to Google.

Claude's custom connector speaks OAuth 2.1 + PKCE and registers itself via Dynamic
Client Registration. The MCP SDK wires up the protocol endpoints (RFC 8414/9728
metadata, /register, /authorize, /token, PKCE verification); this provider supplies
the storage and the identity step:

  authorize()  -> redirect the user to Google sign-in
  /google/callback -> verify the Google identity, enforce the single-user allowlist,
                      mint our own authorization code, redirect back to Claude
  exchange_*   -> issue/refresh our own bearer tokens

All client/code/token state lives in Firestore so it survives Cloud Run's
scale-to-zero and multiple instances. Tokens are opaque random strings.
"""

from __future__ import annotations

import secrets
import time
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    OAuthAuthorizationServerProvider,
    RefreshToken,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

ACCESS_TTL = 3600      # 1 hour
CODE_TTL = 300         # 5 minutes
PENDING_TTL = 600      # 10 minutes to complete Google sign-in

CLIENTS = "oauth_clients"
CODES = "oauth_codes"
TOKENS = "oauth_tokens"
REFRESH = "oauth_refresh"
PENDING = "oauth_pending"


class FirestoreOAuthProvider(OAuthAuthorizationServerProvider):
    def __init__(self, db, issuer_url: str, google_client_id: str,
                 google_client_secret: str, allowed_email: Optional[str]):
        self.db = db
        self.issuer_url = issuer_url.rstrip("/")
        self.google_client_id = google_client_id
        self.google_client_secret = google_client_secret
        self.allowed_email = allowed_email
        self.callback_url = self.issuer_url + "/google/callback"

    def _doc(self, col: str, key: str):
        return self.db.collection(col).document(key)

    # ── DCR: clients registered by Claude ───────────────────────────────
    async def get_client(self, client_id: str) -> Optional[OAuthClientInformationFull]:
        snap = self._doc(CLIENTS, client_id).get()
        return OAuthClientInformationFull.model_validate(snap.to_dict()) if snap.exists else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        self._doc(CLIENTS, client_info.client_id).set(client_info.model_dump(mode="json"))

    # ── authorize: hand off to Google for the actual login ──────────────
    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        txn = secrets.token_urlsafe(24)
        self._doc(PENDING, txn).set({
            "client_id": client.client_id,
            "params": params.model_dump(mode="json"),
            "expires_at": time.time() + PENDING_TTL,
        })
        query = urlencode({
            "client_id": self.google_client_id,
            "redirect_uri": self.callback_url,
            "response_type": "code",
            "scope": "openid email",
            "state": txn,
            "prompt": "select_account",
        })
        return f"{GOOGLE_AUTH_URL}?{query}"

    async def complete_google_login(self, code: str, state: str) -> str:
        """Called by the /google/callback route. Returns the Claude redirect URL."""
        pend = self._doc(PENDING, state).get()
        if not pend.exists:
            raise ValueError("unknown or expired login state")
        pdata = pend.to_dict()
        if pdata.get("expires_at", 0) < time.time():
            self._doc(PENDING, state).delete()
            raise ValueError("login state expired")

        email = await self._google_email(code)
        if self.allowed_email and email != self.allowed_email:
            raise PermissionError(f"{email} is not authorized")

        params = AuthorizationParams.model_validate(pdata["params"])
        our_code = secrets.token_urlsafe(24)
        ac = AuthorizationCode(
            code=our_code,
            scopes=params.scopes or [],
            expires_at=time.time() + CODE_TTL,
            client_id=pdata["client_id"],
            code_challenge=params.code_challenge,
            redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=params.resource,
            subject=email,
        )
        self._doc(CODES, our_code).set(ac.model_dump(mode="json"))
        self._doc(PENDING, state).delete()
        return construct_redirect_uri(str(params.redirect_uri), code=our_code, state=params.state)

    async def _google_email(self, code: str) -> str:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(GOOGLE_TOKEN_URL, data={
                "code": code,
                "client_id": self.google_client_id,
                "client_secret": self.google_client_secret,
                "redirect_uri": self.callback_url,
                "grant_type": "authorization_code",
            })
            r.raise_for_status()
            id_tok = r.json()["id_token"]
        from google.auth.transport import requests as g_requests
        from google.oauth2 import id_token as gid
        info = gid.verify_oauth2_token(id_tok, g_requests.Request(), self.google_client_id)
        email = info.get("email")
        if not email:
            raise ValueError("Google token had no email")
        return email

    # ── authorization codes → tokens ────────────────────────────────────
    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> Optional[AuthorizationCode]:
        snap = self._doc(CODES, authorization_code).get()
        if not snap.exists:
            return None
        ac = AuthorizationCode.model_validate(snap.to_dict())
        if ac.expires_at < time.time():
            self._doc(CODES, authorization_code).delete()
            return None
        return ac

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        self._doc(CODES, authorization_code.code).delete()  # single use
        return self._issue(client.client_id, authorization_code.scopes,
                           authorization_code.subject, with_refresh=True)

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> Optional[RefreshToken]:
        snap = self._doc(REFRESH, refresh_token).get()
        return RefreshToken.model_validate(snap.to_dict()) if snap.exists else None

    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]
    ) -> OAuthToken:
        return self._issue(client.client_id, scopes or refresh_token.scopes,
                           refresh_token.subject, existing_refresh=refresh_token.token)

    async def load_access_token(self, token: str) -> Optional[AccessToken]:
        snap = self._doc(TOKENS, token).get()
        if not snap.exists:
            return None
        at = AccessToken.model_validate(snap.to_dict())
        if at.expires_at and at.expires_at < time.time():
            self._doc(TOKENS, token).delete()
            return None
        return at

    async def revoke_token(self, token) -> None:
        tok = getattr(token, "token", None)
        if tok:
            self._doc(TOKENS, tok).delete()
            self._doc(REFRESH, tok).delete()

    def _issue(self, client_id: str, scopes: list[str], subject: Optional[str],
               with_refresh: bool = False, existing_refresh: Optional[str] = None) -> OAuthToken:
        access = secrets.token_urlsafe(32)
        at = AccessToken(
            token=access, client_id=client_id, scopes=scopes,
            expires_at=int(time.time() + ACCESS_TTL), subject=subject,
        )
        self._doc(TOKENS, access).set(at.model_dump(mode="json"))

        refresh = existing_refresh
        if with_refresh:
            refresh = secrets.token_urlsafe(32)
            rt = RefreshToken(token=refresh, client_id=client_id, scopes=scopes,
                              expires_at=None, subject=subject)
            self._doc(REFRESH, refresh).set(rt.model_dump(mode="json"))

        return OAuthToken(
            access_token=access, token_type="Bearer", expires_in=ACCESS_TTL,
            scope=" ".join(scopes) if scopes else None, refresh_token=refresh,
        )
