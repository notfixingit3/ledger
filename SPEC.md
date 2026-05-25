# Ledger Plugin - Technical Specification

## Overview
**Agent Ledger** is an OpenCode plugin that provides detailed, multi-agent token and cost tracking. It was built for durable OpenCode sessions that may spawn child/background agent sessions, where `/ledger` should report the active session tree by agent, provider, and model.

## Core Features
- Tracks usage **by individual agent + provider + model**
- Reads persisted OpenCode session history
- Per-session-tree reporting for the active session and descendant background sessions
- Agent/model/session token percentage reporting
- Real-time cost estimation with editable pricing map
- Compact toast summary on session idle
- Summary/detail Markdown exports via `/ledger`
- Machine-readable JSON exports via `ledger_json`
- Command output includes totals by agent and totals by agent/model
- Total-token displays include exact and compact values, such as `200,000 (200k)`
- Clean grouping by agent in output

## Architecture

### Data Structure
- Uses OpenCode's own persisted session messages as the source of truth
- Resolves the active session tree from `client.session.children(...)`, with in-memory parent links as a fallback while OpenCode is running
- Builds user-message contexts by message ID so assistant responses can inherit the originating agent/provider/model
- Prefers `step-finish` part usage over assistant message usage when parts are present
- `UsageEntry` totals are derived at report time instead of stored as the source of truth
- Builds a `LedgerReport` object and formats Markdown/JSON exports from the same report data
- Writes timestamped report files to the active project directory, defaulting to `ledger-reports/ledger-<timestamp>.<ext>`

### Lifecycle Hooks Used
- `session.created` → Remember parent relationship fallback
- `session.updated` → Track parent relationship updates
- `session.idle` → Show compact toast summary

### Custom Tool
- `ledger` → Slash command `/ledger` that saves `summary` or `detail` Markdown reports and returns compact totals/path output
- `ledger_json` → Tool that saves the machine-readable JSON report and returns compact totals/path output
- The tool itself is deterministic and does not call an LLM, but OpenCode command templates may route `/ledger` through the assistant before tool execution.

### Pricing
- Configurable pricing map via plugin options, with built-in defaults inside `index.ts`
- Falls back to sensible defaults
- Easy to extend for new providers/models

## Message Data Extraction Strategy
The plugin attempts to extract data from common locations in the `message` object (in priority order):
1. `message.metadata?.agent`
2. `message.agentName`
3. `message.agent`
4. `message.source?.agent`
5. Falls back to `"Unknown-Agent"`

Same flexible approach is used for provider and model.

## Limitations (Current)
- TUI header integration (showing live summary below context counter) is not possible with current OpenCode plugin API
- The sample `/ledger` slash command is command-template based, so argument handling and fully native non-LLM command execution depend on OpenCode command routing.

## Future Improvements (Roadmap)
- JSON export at session end
- Per-agent subtotals in compact toast
- Better TUI status integration when OpenCode adds status bar hooks
