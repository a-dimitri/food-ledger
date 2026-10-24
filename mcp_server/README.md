# mcp_server — MCP server

Streamable-HTTP MCP server exposing per-record tools (food entries, pantry,
weigh-ins, phases, workouts, exercise history, dashboard). Runs its own OAuth 2.1
authorization server with login delegated to Google; every tool acts on the
profile of the signed-in Google account, and no tool takes a profile argument.
Imports `core`.

Named `mcp_server` (not `mcp`) to avoid shadowing the `mcp` PyPI package.
