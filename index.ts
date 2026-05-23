import type { Plugin } from "@opencode-ai/plugin";

interface UsageEntry {
  agent: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  calls: number;
}

export const AgentLedger: Plugin = async ({ client }) => {
  let sessionUsage = new Map<string, UsageEntry>(); // key: "agent::provider:model"
  let messageUsage = new Map<string, { prompt: number; completion: number }>();

  // ── Pricing map (edit these prices whenever you want) ──
  const defaultPrice = { input: 0.000005, output: 0.000015 };
  const pricing: Record<string, Record<string, { input: number; output: number }>> = {
    anthropic: {
      "claude-4-opus": { input: 0.000015, output: 0.000075 },
      "claude-4-sonnet": { input: 0.000003, output: 0.000015 },
    },
    openai: {
      "gpt-4.5": { input: 0.0000025, output: 0.000010 },
      "o3": { input: 0.000010, output: 0.000040 },
    },
  };

  function getPrice(provider: string, model: string) {
    const p = pricing[provider.toLowerCase()];
    if (!p) return defaultPrice;
    return p[model.toLowerCase()] || defaultPrice;
  }

  function getKey(agent: string, provider: string, model: string) {
    return `${agent}::${provider}:${model}`;
  }

  function updateUsage(agent: string, provider: string, model: string, prompt: number, completion: number, isNewCall: boolean) {
    const key = getKey(agent, provider, model);
    let entry = sessionUsage.get(key);
    if (!entry) {
      entry = { agent, provider, model, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, calls: 0 };
      sessionUsage.set(key, entry);
    }

    const price = getPrice(provider, model);
    const cost = prompt * price.input + completion * price.output;

    entry.promptTokens += prompt;
    entry.completionTokens += completion;
    entry.totalTokens += prompt + completion;
    entry.estimatedCost += cost;
    if (isNewCall) {
      entry.calls += 1;
    }
  }

  async function showCompactToast() {
    if (sessionUsage.size === 0) return;
    let totalTokens = 0;
    let totalCost = 0;
    const agents = new Set<string>();

    for (const entry of sessionUsage.values()) {
      totalTokens += entry.totalTokens;
      totalCost += entry.estimatedCost;
      agents.add(entry.agent);
    }

    const summary = `Ledger: ${agents.size} agents • ${Math.round(totalTokens / 1000)}k tokens • $${totalCost.toFixed(3)}`;
    await client.tui?.showToast?.({
      body: {
        message: summary,
        variant: "info",
      },
    });
  }

  async function showFullLedger(): Promise<string> {
    if (sessionUsage.size === 0) {
      const msg = "No usage recorded yet.";
      await client.app.log?.({ body: { service: "ledger", level: "info", message: msg } });
      return msg;
    }

    let totalTokens = 0;
    let totalCost = 0;
    let output = "=== Agent Ledger (this session) ===\n\n";

    const byAgent = new Map<string, UsageEntry[]>();
    for (const entry of sessionUsage.values()) {
      if (!byAgent.has(entry.agent)) byAgent.set(entry.agent, []);
      byAgent.get(entry.agent)!.push(entry);
      totalTokens += entry.totalTokens;
      totalCost += entry.estimatedCost;
    }

    for (const [agent, entries] of byAgent) {
      output += `Agent: ${agent}\n`;
      for (const e of entries) {
        output += `  ${e.provider}/${e.model}: ${e.calls} calls, ${e.totalTokens} tokens ($${e.estimatedCost.toFixed(4)})\n`;
      }
      output += "\n";
    }

    output += `Total: ${totalTokens} tokens • ~$${totalCost.toFixed(4)}`;
    
    await client.app.log?.({ body: { service: "ledger", level: "info", message: output } });
    await client.tui?.showToast?.({
      body: {
        message: `Full ledger logged • Total ~$${totalCost.toFixed(3)}`,
        variant: "success",
      },
    });

    return output;
  }

  return {
    "session.created": async () => {
      sessionUsage.clear();
      messageUsage.clear();
      await client.app.log?.({ body: { service: "ledger", level: "info", message: "New session started → Ledger reset" } });
    },

    "message.updated": async ({ message }: { message: any }) => {
      if (message?.role !== "assistant") return;

      const agent = message.metadata?.agent || message.agentName || message.agent || message.source?.agent || "Unknown-Agent";
      
      let provider = "unknown";
      if (typeof message.provider === "string") {
        provider = message.provider;
      } else if (message.model && typeof message.model === "object" && typeof message.model.provider === "string") {
        provider = message.model.provider;
      }

      let model = "unknown";
      if (typeof message.model === "string") {
        model = message.model;
      } else if (message.model && typeof message.model === "object") {
        model = message.model.name || message.model.id || JSON.stringify(message.model);
      }

      const usage = message.usage || message.tokenUsage || message._usage;
      const prompt = usage?.prompt_tokens ?? usage?.promptTokens;
      const completion = usage?.completion_tokens ?? usage?.completionTokens;

      if (prompt != null && completion != null && message.id) {
        const lastUsage = messageUsage.get(message.id);

        if (!lastUsage) {
          updateUsage(agent, provider, model, prompt, completion, true);
          messageUsage.set(message.id, { prompt, completion });
        } else {
          const diffPrompt = prompt - lastUsage.prompt;
          const diffCompletion = completion - lastUsage.completion;
          if (diffPrompt > 0 || diffCompletion > 0) {
            updateUsage(agent, provider, model, diffPrompt, diffCompletion, false);
            messageUsage.set(message.id, { prompt, completion });
          }
        }
      }
    },

    "session.idle": async () => {
      await showCompactToast();
    },

    tool: {
      ledger: {
        description: "Show full multi-agent usage ledger (by agent/provider/model + cost)",
        args: {},
        async execute() {
          return await showFullLedger();
        },
      },
    },
  };
};

