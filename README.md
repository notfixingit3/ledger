<p align="center"><img src="./assets/logo.png" width="240" alt="OpenCode Ledger" /></p>

<h1 align="center">OpenCode Ledger</h1>

<p align="center">
  <a href="https://opencode.ai"><img src="https://img.shields.io/badge/OpenCode-2026.5-111315?style=for-the-badge&logo=openai&logoColor=white" alt="OpenCode Engine" /></a>
  <a href="#"><img src="https://img.shields.io/badge/Build-Passing-8CFF5E?style=for-the-badge&labelColor=111315&color=8CFF5E" alt="Build Status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-FFB020?style=for-the-badge&labelColor=111315&color=FFB020" alt="License" /></a>
  <a href="https://buymeacoffee.com/notfixingit"><img src="https://img.shields.io/badge/Support-Coffee-00E5FF?style=for-the-badge&labelColor=111315&color=00E5FF" alt="Support" /></a>
</p>

OpenCode Ledger tracks token usage and estimated cost across multi-agent OpenCode sessions. It is built for parallel workflows where specialized agents make model calls across providers, and session-level accounting needs to stay readable, deduplicated, and fast.

## Core Features

* **Multi-Agent Isolation**: Tracks precise prompt/completion tokens and API calls isolated by agent, provider, and model.
* **Streaming-Safe Accounting**: Uses token delta tracking to avoid the double-counting common in streaming update hooks.
* **Realtime Cost Modeling**: Calculates estimated spend from an extensible, case-insensitive provider/model pricing map.
* **Session Summary Toasts**: Shows a compact usage summary when the session becomes idle.
* **Inline Ledger Command**: Returns a complete provider/model breakdown directly in chat with `/ledger`.

## Installation

To copy the plugin and safely register it in your `opencode.json` / `opencode.jsonc` configs without breaking existing plugins:

### Automated Setup
You can install and configure the plugin directly from the terminal without manual cloning.

#### Stable Release
```bash
curl -fsSL https://raw.githubusercontent.com/notfixingit3/ledger/main/install.sh | sh
```

#### Development Release
```bash
curl -fsSL https://raw.githubusercontent.com/notfixingit3/ledger/dev/install.sh | sh
```

> [!TIP]
> The automated installer safely handles JSON and JSONC files (retaining formatting and comments) and will gracefully add the plugin without overriding existing active plugins.

### Manual Configuration
1. Copy [index.ts](./index.ts) to `~/.config/opencode/plugins/ledger.ts` (global) or `.opencode/plugins/ledger.ts` (project-local).
2. Add `"./plugins/ledger.ts"` to your `"plugin"` array inside `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "plugin": [
    "oh-my-openagent@latest",
    "./plugins/ledger.ts" // Added locally
  ]
}
```

## Configuration

The core pricing map in `index.ts` is fully extensible. You can define custom models and prices (quoted as per-token costs) directly:

```typescript
const pricing = {
  anthropic: {
    "claude-4-opus": { input: 0.000015, output: 0.000075 },
    "claude-4-sonnet": { input: 0.000003, output: 0.000015 },
  },
  openai: {
    "gpt-4.5": { input: 0.0000025, output: 0.000010 },
  }
};
```

> [!NOTE]
> For integration guidelines for specialized subagents, see [AGENTS.md](./AGENTS.md).
