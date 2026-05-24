<p align="center"><img src="./assets/logo.png" width="240" alt="OpenCode Ledger" /></p>

<h1 align="center">OpenCode Ledger</h1>

<p align="center">
  <a href="https://opencode.ai"><img src="https://img.shields.io/badge/OpenCode-2026.5-111315?style=for-the-badge&logo=openai&logoColor=white" alt="OpenCode Engine" /></a>
  <a href="#"><img src="https://img.shields.io/badge/Build-Passing-8CFF5E?style=for-the-badge&labelColor=111315&color=8CFF5E" alt="Build Status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-FFB020?style=for-the-badge&labelColor=111315&color=FFB020" alt="License" /></a>
  <a href="https://buymeacoffee.com/notfixingit"><img src="https://img.shields.io/badge/Support-Coffee-00E5FF?style=for-the-badge&labelColor=111315&color=00E5FF" alt="Support" /></a>
</p>

OpenCode Ledger tracks token usage and estimated cost across durable OpenCode session trees. It is built for workflows where a resumed session may spawn background agent sessions, and the user-facing ledger should include the root session plus its children while staying readable, deduplicated, and fast.

## Core Features

* **Multi-Agent Isolation**: Tracks precise prompt/completion tokens and API calls isolated by agent, provider, and model.
* **Durable Session Tree Accounting**: Reads OpenCode's saved session history for the active session plus child background sessions, while excluding unrelated sessions.
* **Streaming-Safe Accounting**: Prefers recorded `step-finish` parts over message-level usage so repeated update hooks do not double-count.
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
> The automated installer handles JSON and JSONC configs, creates a backup before editing, and adds the plugin without overriding existing active plugins.

### Upgrading
Existing installs can upgrade by rerunning the installer for the channel they want:

```bash
curl -fsSL https://raw.githubusercontent.com/notfixingit3/ledger/main/install.sh | sh
```

or, for the development channel:

```bash
curl -fsSL https://raw.githubusercontent.com/notfixingit3/ledger/dev/install.sh | sh
```

The installer overwrites `~/.config/opencode/plugins/ledger.ts` with the latest plugin file and can refresh the `/ledger` command in your OpenCode config. When prompted, answer `y` if you want it to normalize the config entry, including removing older command fields such as `subtask`.

Before replacing an existing plugin file, the installer writes a timestamped backup next to it, such as `~/.config/opencode/plugins/ledger.ts.bak.20260524143000`. Before modifying an existing OpenCode config, it also writes a timestamped config backup next to that file.

After upgrading, restart OpenCode. Ledger reads OpenCode's saved session history, so there is no separate Ledger data store to migrate.

### Manual Configuration
1. Copy [index.ts](./index.ts) to `~/.config/opencode/plugins/ledger.ts`.
2. Add the installed file URL and `/ledger` command to `~/.config/opencode/config.json` or `config.jsonc`:

```jsonc
{
  "plugin": [
    "oh-my-openagent@latest",
    "file:///Users/you/.config/opencode/plugins/ledger.ts"
  ],
  "command": {
    "ledger": {
      "template": "Use ledger tool. Return only output.",
      "description": "Show multi-agent token and cost ledger"
    }
  }
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

The `ledger` tool itself is deterministic and reads OpenCode's saved session messages and child-session list. The sample `/ledger` command is still an OpenCode command template, so OpenCode may route that slash command through the assistant before the tool is called.

> [!NOTE]
> For integration guidelines for specialized subagents, see [AGENTS.md](./AGENTS.md).
