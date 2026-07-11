# mcp_server — MCP server (Stage 2)

Streamable-HTTP MCP server exposing per-record tools (add/edit/delete entries,
log weight, dashboard). Runs its own OAuth 2.1 authorization server with login
delegated to Google. Imports `core`. See REQUIREMENTS.md §5 Stage 2.

Named `mcp_server` (not `mcp`) to avoid shadowing the `mcp` PyPI package.
