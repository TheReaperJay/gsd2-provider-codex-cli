# Codex CLI Provider for GSD2

`gsd2-provider-codex-cli` adds a Codex CLI-backed provider plugin for GSD using `@thereaperjay/gsd-provider-api`.

## What it does

- Registers provider `codex-reaper` with model IDs in `codex-reaper:*` namespace
- Uses `codex exec --json` for request execution (CLI-authenticated runtime)
- Translates Codex JSONL events into GSD provider events (`text_delta`, `tool_call_*`, `tool_result`, `completion`, `error`)
- Injects GSD tool registry into Codex per-run through a local Streamable HTTP MCP bridge (`mcp_servers.gsd_tools.url=...`)
- Runs onboarding/readiness checks via `codex --version` and `codex login status`
- Enforces soft/idle/hard timeout handling from supervisor config
- Applies context-write blocking checks to shell write commands and MCP tool arguments before execution
- Writes JSONL activity logs for assistant/tool events in `.gsd/activity`

## Tool Use Behavior

This provider treats Codex tool-like item events as tool activity:

- `item.started` (`command_execution`) -> `tool_call_start` + `tool_call_delta`
- `item.completed` (`command_execution`) -> `tool_call_end` + `tool_result`
- other non-message item types -> generic `tool_call_*` + `tool_result`

Tool details are derived from the command string and surfaced to GSD status UI.

To keep tool output cleanly separated from assistant chat content, command/tool result payloads are not forwarded as `text_delta`.

## Token / Usage Mapping

On `turn.completed`, usage fields map as:

- `input_tokens` -> `usage.inputTokens`
- `output_tokens` -> `usage.outputTokens`
- `cached_input_tokens` -> `usage.cacheReadTokens`

If usage is unavailable, the provider emits completion with `0` token counts.

## Auth Check

Onboarding and readiness checks require:

1. `codex` binary available on PATH
2. `codex login status` indicates logged in

If either check fails, GSD onboarding reports the corrective instruction.

## MCP Tool Bridge

This provider starts an in-process MCP server bound to `127.0.0.1` on an ephemeral port and injects it into Codex with per-run config overrides:

- `-c mcp_servers.gsd_tools.url="http://127.0.0.1:<port>/mcp"`

The bridge merges:

- tools passed in `context.tools` from GSD
- globally registered tools from `@thereaperjay/gsd-provider-api` tool registry

## Files

- `index.ts` - extension entrypoint wiring
- `info.ts` - provider metadata, auth checks, stream translation runtime
- `activity-writer.ts` - activity JSONL writer for Codex stream events
- `mcp-http-tools.ts` - local Streamable HTTP MCP bridge for GSD tools
- `extension-manifest.json` - extension metadata for GSD
