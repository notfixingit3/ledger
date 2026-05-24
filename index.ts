import type { Plugin, ToolContext } from "@opencode-ai/plugin";

interface UsageEntry {
  sessionID: string;
  agent: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  calls: number;
}

interface MessageContext {
  agent: string;
  provider: string;
  model: string;
}

export const AgentLedger: Plugin = async ({ client }) => {
  const sessionParents = new Map<string, string | undefined>();

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

  function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  }

  function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) return value;
      if (typeof value === "number") return String(value);
    }
    return undefined;
  }

  function toNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  function getPrice(provider: string, model: string) {
    const providerPrices = pricing[provider.toLowerCase()];
    if (!providerPrices) return defaultPrice;
    return providerPrices[model.toLowerCase()] || defaultPrice;
  }

  function extractContext(message: Record<string, unknown>): MessageContext {
    const metadata = asRecord(message.metadata);
    const source = asRecord(message.source);
    const modelObject = asRecord(message.model);
    const providerObject = asRecord(message.provider);

    const agent = firstString(
      metadata?.agent,
      metadata?.agentName,
      metadata?.name,
      message.agentName,
      message.agent,
      message.mode,
      source?.agent,
      source?.agentName,
      "Unknown-Agent",
    )!;

    const provider = firstString(
      message.providerID,
      message.provider,
      providerObject?.providerID,
      providerObject?.id,
      providerObject?.name,
      modelObject?.providerID,
      modelObject?.provider,
      "unknown",
    )!;

    const model = firstString(
      message.modelID,
      message.model,
      modelObject?.modelID,
      modelObject?.id,
      modelObject?.name,
      "unknown",
    )!;

    return { agent, provider, model };
  }

  function extractTokenUsage(source: Record<string, unknown>): { prompt: number; completion: number; cost?: number } | undefined {
    const usage = asRecord(source.usage) || asRecord(source.tokenUsage) || asRecord(source._usage);
    const tokens = asRecord(source.tokens);
    const cache = asRecord(tokens?.cache);

    const prompt = usage
      ? toNumber(
        usage.prompt_tokens ??
        usage.promptTokens ??
        usage.input_tokens ??
        usage.inputTokens ??
        usage.input,
      )
      : toNumber(tokens?.input ?? source.inputTokens ?? source.input_tokens);

    const completion = usage
      ? toNumber(
        usage.completion_tokens ??
        usage.completionTokens ??
        usage.output_tokens ??
        usage.outputTokens ??
        usage.output,
      )
      : toNumber(tokens?.output ?? source.outputTokens ?? source.output_tokens);

    const cacheRead = toNumber(cache?.read) ?? toNumber(source.cacheReadTokens) ?? 0;
    const cacheWrite = toNumber(cache?.write) ?? toNumber(source.cacheWriteTokens) ?? 0;
    const reasoning = toNumber(tokens?.reasoning ?? source.reasoningTokens ?? source.reasoning_tokens) ?? 0;
    const total = usage ? toNumber(usage.total_tokens ?? usage.totalTokens ?? usage.total) : toNumber(source.totalTokens ?? source.total_tokens);

    const promptWithCache = prompt === undefined ? undefined : prompt + cacheRead + cacheWrite;
    let completionWithReasoning = completion === undefined ? undefined : completion + reasoning;

    if (completionWithReasoning === undefined && total !== undefined && promptWithCache !== undefined) {
      completionWithReasoning = Math.max(total - promptWithCache, 0);
    }

    if (promptWithCache === undefined || completionWithReasoning === undefined) return undefined;

    return {
      prompt: promptWithCache,
      completion: completionWithReasoning,
      cost: toNumber(source.cost),
    };
  }

  function getSessionID(event: Record<string, unknown>, properties?: Record<string, unknown>) {
    const info = asRecord(properties?.info);
    return firstString(
      event.sessionID,
      properties?.sessionID,
      info?.id,
    );
  }

  function recordSession(event: Record<string, unknown>, properties?: Record<string, unknown>) {
    const info = asRecord(properties?.info);
    const sessionID = getSessionID(event, properties);
    if (!sessionID) return;

    const parentID = firstString(
      info?.parentID,
      properties?.parentID,
      event.parentID,
    );
    sessionParents.set(sessionID, parentID);
  }

  async function readData<T>(request: Promise<unknown>): Promise<T | undefined> {
    const result = await request as { data?: T; error?: unknown } | T | undefined;
    if (result && typeof result === "object" && "data" in result) return result.data;
    return result as T | undefined;
  }

  async function getSessionChildren(sessionID: string): Promise<Record<string, unknown>[]> {
    try {
      return await readData<Record<string, unknown>[]>(
        client.session.children({ path: { id: sessionID } }),
      ) || [];
    } catch {
      return [];
    }
  }

  async function getSessionTreeIDs(sessionID: string) {
    const sessionIDs = new Set<string>([sessionID]);
    const queue = [sessionID];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await getSessionChildren(current);

      for (const child of children) {
        const childID = firstString(child.id);
        if (!childID || sessionIDs.has(childID)) continue;

        sessionIDs.add(childID);
        queue.push(childID);
        sessionParents.set(childID, firstString(child.parentID, current));
      }
    }

    let changed = true;
    while (changed) {
      changed = false;

      for (const [childID, parentID] of sessionParents) {
        if (parentID && sessionIDs.has(parentID) && !sessionIDs.has(childID)) {
          sessionIDs.add(childID);
          changed = true;
        }
      }
    }

    return sessionIDs;
  }

  function addUsage(
    entries: Map<string, UsageEntry>,
    sessionID: string,
    context: MessageContext,
    promptTokens: number,
    completionTokens: number,
    actualCost?: number,
  ) {
    const key = `${sessionID}::${context.agent}::${context.provider}:${context.model}`;
    let entry = entries.get(key);

    if (!entry) {
      entry = {
        sessionID,
        agent: context.agent,
        provider: context.provider,
        model: context.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
        calls: 0,
      };
      entries.set(key, entry);
    }

    const price = getPrice(context.provider, context.model);
    const cost = actualCost ?? (promptTokens * price.input + completionTokens * price.output);

    entry.promptTokens += promptTokens;
    entry.completionTokens += completionTokens;
    entry.totalTokens += promptTokens + completionTokens;
    entry.estimatedCost += cost;
    entry.calls += 1;
  }

  async function getSessionMessages(sessionID: string) {
    try {
      return await readData<Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>>(
        client.session.messages({ path: { id: sessionID } }),
      ) || [];
    } catch {
      return [];
    }
  }

  async function buildUsageEntries(rootSessionID?: string) {
    const entries = new Map<string, UsageEntry>();
    if (!rootSessionID) return [];

    const sessionIDs = await getSessionTreeIDs(rootSessionID);

    for (const sessionID of sessionIDs) {
      const messages = await getSessionMessages(sessionID);
      const userContexts = new Map<string, MessageContext>();

      for (const message of messages) {
        const info = asRecord(message.info);
        if (info?.role !== "user") continue;

        const messageID = firstString(info.id);
        if (messageID) userContexts.set(messageID, extractContext(info));
      }

      for (const message of messages) {
        const info = asRecord(message.info);
        if (info?.role !== "assistant") continue;

        const parentID = firstString(info.parentID);
        const context = parentID ? userContexts.get(parentID) || extractContext(info) : extractContext(info);
        const stepFinishParts = (message.parts || []).filter((part) => part.type === "step-finish");

        if (stepFinishParts.length > 0) {
          for (const part of stepFinishParts) {
            const tokenUsage = extractTokenUsage(part);
            if (!tokenUsage) continue;
            addUsage(entries, sessionID, context, tokenUsage.prompt, tokenUsage.completion, tokenUsage.cost);
          }
          continue;
        }

        const tokenUsage = extractTokenUsage(info);
        if (!tokenUsage) continue;
        addUsage(entries, sessionID, context, tokenUsage.prompt, tokenUsage.completion, tokenUsage.cost);
      }
    }

    return [...entries.values()];
  }

  async function showCompactToast(sessionID?: string) {
    const entries = await buildUsageEntries(sessionID);
    if (entries.length === 0) return;

    let totalTokens = 0;
    let totalCost = 0;
    const agents = new Set<string>();

    for (const entry of entries) {
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

  async function showFullLedger(sessionID?: string): Promise<string> {
    const entries = await buildUsageEntries(sessionID);

    if (entries.length === 0) {
      const msg = "No usage recorded yet.";
      await client.app.log?.({ body: { service: "ledger", level: "info", message: msg } });
      return msg;
    }

    let totalTokens = 0;
    let totalCost = 0;
    let output = "=== Agent Ledger (active session tree) ===\n\n";

    const byAgent = new Map<string, UsageEntry[]>();
    for (const entry of entries) {
      if (!byAgent.has(entry.agent)) byAgent.set(entry.agent, []);
      byAgent.get(entry.agent)!.push(entry);
      totalTokens += entry.totalTokens;
      totalCost += entry.estimatedCost;
    }

    for (const [agent, entries] of byAgent) {
      output += `Agent: ${agent}\n`;
      for (const entry of entries) {
        output += `  ${entry.provider}/${entry.model}: ${entry.calls} calls, ${entry.totalTokens} tokens ($${entry.estimatedCost.toFixed(4)})\n`;
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
    event: async ({ event }: { event: Record<string, unknown> }) => {
      const properties = asRecord(event.properties) || event;

      if (event.type === "session.created" || event.type === "session.updated") {
        recordSession(event, properties);
      } else if (event.type === "session.idle") {
        await showCompactToast(getSessionID(event, properties));
      }
    },

    tool: {
      ledger: {
        description: "Show multi-agent usage ledger for the active OpenCode session tree",
        args: {},
        async execute(_args: Record<string, never>, context: ToolContext) {
          return await showFullLedger(context.sessionID);
        },
      },
    },
  };
};
