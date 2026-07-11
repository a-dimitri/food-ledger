"""ASGI entrypoint for the MCP service (run with: uvicorn mcp_server.app:app).

Builds the streamable-HTTP app from the FastMCP server in server.py. When the
OAuth/Google env is configured, the app also serves the OAuth authorization-server
and protected-resource metadata, the /register (DCR), /authorize, /token routes,
and the /google/callback login route — everything Claude's custom connector needs.
"""

from __future__ import annotations

from mcp_server.server import mcp

app = mcp.streamable_http_app()
