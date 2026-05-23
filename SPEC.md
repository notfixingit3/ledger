# Ledger Plugin - Technical Specification

## Overview
**Agent Ledger** is an OpenCode plugin that provides detailed, multi-agent token and cost tracking. It was built specifically for users running complex multi-agent workflows (such as `oh-my-openagent`) where multiple agents may use different (or the same) providers and models.

## Core Features
- Tracks usage **by individual agent + provider + model**
- Per-session tracking (automatically resets on new session)
- Real-time cost estimation with editable pricing map
- Compact toast summary on session idle
- Full detailed ledger via `/ledger` command
- Clean grouping by agent in output

## Architecture

### Data Structure
- Uses `Map<string, UsageEntry>` where key = `agent::provider:model`
- `UsageEntry` contains: agent, provider, model, promptTokens, completionTokens, totalTokens, estimatedCost, calls

### Lifecycle Hooks Used
- `session.created` → Clear usage map and log reset
- `message.updated` → Detect assistant messages and extract agent/provider/model + usage data
- `session.idle` → Show compact toast summary

### Custom Tool
- `ledger` → Slash command `/ledger` that displays the full grouped report

### Pricing
- Configurable pricing map inside `index.ts`
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
- Does not yet persist usage across OpenCode restarts
- TUI header integration (showing live summary below context counter) is not possible with current OpenCode plugin API
- Pricing must be manually updated in code

## Future Improvements (Roadmap)
- Configurable pricing via `opencode.json`
- JSON export at session end
- Persistent storage option
- Per-agent subtotals in compact toast
- Better TUI status integration when OpenCode adds status bar hooks

