# 📊 OpenCode Ledger

[![OpenCode Engine](https://img.shields.io/badge/OpenCode-2026.5-6366f1?style=for-the-badge&logo=openai&logoColor=white)](https://opencode.ai)
[![Build Status](https://img.shields.io/badge/Build-Passing-10b981?style=for-the-badge)](#)
[![License](https://img.shields.io/badge/License-MIT-f59e0b?style=for-the-badge)](LICENSE)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/notfixingit)

An ultra-precise, real-time multi-agent token and cost ledger built for **OpenCode 2026**. Designed specifically for parallel agent workflows (e.g. `oh-my-openagent`) where specialized subagents execute model calls dynamically across multiple API providers.

---

## ⚡ Core Features

* **Multi-Agent Isolation**: Tracks precise prompt/completion tokens and API calls isolated by agent, provider, and model.
* **Streaming De-duplication**: Features active token delta tracking to prevent the double/triple-counting common in streaming update hooks.
* **Real-time Valuation**: Dynamically calculates and formats dollar-costs based on an extensible, case-insensitive provider-to-model pricing map.
* **Zero-config Toast Summaries**: Displays a sleek, transient status toast upon session idle.
* **Inline Slash Command**: Return complete, beautifully formatted tables directly inside your chat panel using `/ledger`.

---

## 📦 Installation & Automated Setup

To copy the plugin and safely register it in your `opencode.json` / `opencode.jsonc` configs without breaking existing plugins:

### One-Click Installer (Recommended)
You can install and configure the plugin directly from the terminal without manual cloning.

#### Stable Release (Main)
```bash
curl -fsSL https://raw.githubusercontent.com/notfixingit3/ledger/main/install.sh | sh
```

#### Development Release (Dev)
```bash
curl -fsSL https://raw.githubusercontent.com/notfixingit3/ledger/dev/install.sh | sh
```

> [!TIP]
> The automated installer safely handles JSON and JSONC files (retaining formatting and comments) and will gracefully add the plugin without overriding existing active plugins.

### Manual Configuration
1. Copy [index.ts](file:///Users/house/Documents/gitlab/ledger/index.ts) to `~/.config/opencode/plugins/ledger.ts` (global) or `.opencode/plugins/ledger.ts` (project-local).
2. Add `"./plugins/ledger.ts"` to your `"plugin"` array inside `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "plugin": [
    "oh-my-openagent@latest",
    "./plugins/ledger.ts" // Added locally
  ]
}
```

---

## 🛠️ Configuration & Pricing Customization

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

---

> [!NOTE]
> For integration guidelines for specialized subagents, see [AGENTS.md](file:///Users/house/Documents/gitlab/ledger/AGENTS.md).
