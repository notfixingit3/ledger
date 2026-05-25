import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tool, type Plugin, type ToolContext, type ToolResult } from "@opencode-ai/plugin";

const LEDGER_VERSION = "0.0.7";

type LedgerMode = "summary" | "detail";

interface Price {
  input: number;
  output: number;
}

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

interface SessionBreakdown {
  sessionID: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  calls: number;
  percentOfTotalTokens: number;
}

interface ModelBreakdown {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  calls: number;
  percentOfTotalTokens: number;
  sessions: SessionBreakdown[];
}

interface AgentBreakdown {
  agent: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  calls: number;
  percentOfTotalTokens: number;
  models: ModelBreakdown[];
}

interface LedgerReport {
  version: string;
  mode: LedgerMode;
  rootSessionID?: string;
  sessionIDs: string[];
  totals: {
    agents: number;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  agents: AgentBreakdown[];
  warnings: string[];
}

interface AgentLedgerOptions {
  defaultPrice?: Price;
  exportDirectory?: string;
  pricing?: Record<string, Record<string, Price>>;
}

interface SavedReport {
  format: "markdown" | "json";
  filePath: string;
  fileURL: string;
  filename: string;
  relativePath: string;
  mime: string;
}

export const AgentLedger: Plugin = async ({ client, directory, worktree }, options) => {
  const sessionParents = new Map<string, string | undefined>();

  const builtInDefaultPrice: Price = { input: 0.000005, output: 0.000015 };
  const builtInPricing: Record<string, Record<string, Price>> = {
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

  function normalizePrice(value: unknown): Price | undefined {
    const record = asRecord(value);
    if (!record) return undefined;

    const input = toNumber(record.input);
    const output = toNumber(record.output);
    if (input === undefined || output === undefined) return undefined;

    return { input, output };
  }

  function normalizePricing(value: unknown): Record<string, Record<string, Price>> {
    const normalized: Record<string, Record<string, Price>> = {};
    const providers = asRecord(value);
    if (!providers) return normalized;

    for (const [provider, models] of Object.entries(providers)) {
      const modelMap = asRecord(models);
      if (!modelMap) continue;

      const providerKey = provider.toLowerCase();
      normalized[providerKey] ||= {};

      for (const [model, priceLike] of Object.entries(modelMap)) {
        const price = normalizePrice(priceLike);
        if (price) normalized[providerKey][model.toLowerCase()] = price;
      }
    }

    return normalized;
  }

  function mergePricing(...maps: Record<string, Record<string, Price>>[]) {
    const merged: Record<string, Record<string, Price>> = {};

    for (const map of maps) {
      for (const [provider, models] of Object.entries(map)) {
        const providerKey = provider.toLowerCase();
        merged[providerKey] ||= {};

        for (const [model, price] of Object.entries(models)) {
          merged[providerKey][model.toLowerCase()] = price;
        }
      }
    }

    return merged;
  }

  const pluginOptions = asRecord(options) as AgentLedgerOptions | undefined;
  const defaultPrice = normalizePrice(pluginOptions?.defaultPrice) || builtInDefaultPrice;
  const pricing = mergePricing(builtInPricing, normalizePricing(pluginOptions?.pricing));

  function getPrice(provider: string, model: string) {
    const providerPrices = pricing[provider.toLowerCase()];
    if (!providerPrices) return { price: defaultPrice, isDefault: true };

    const price = providerPrices[model.toLowerCase()];
    return price ? { price, isDefault: false } : { price: defaultPrice, isDefault: true };
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
    warnings: Set<string>,
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

    const { price, isDefault } = getPrice(context.provider, context.model);
    const cost = actualCost ?? (promptTokens * price.input + completionTokens * price.output);

    if (context.agent === "Unknown-Agent") {
      warnings.add("Some usage could not be mapped to an agent and is grouped under Unknown-Agent.");
    }
    if (context.provider === "unknown" || context.model === "unknown") {
      warnings.add("Some usage is missing provider or model metadata and is grouped under unknown.");
    }
    if (actualCost === undefined && isDefault) {
      warnings.add(`Default pricing was used to estimate ${context.provider}/${context.model}. Configure pricing for more accurate costs.`);
    }

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

  function percent(value: number, total: number) {
    return total > 0 ? (value / total) * 100 : 0;
  }

  function roundPercent(value: number) {
    return Math.round(value * 10) / 10;
  }

  function compactSessionID(sessionID: string) {
    return sessionID.length > 12 ? `${sessionID.slice(0, 8)}...` : sessionID;
  }

  async function buildUsageEntries(rootSessionID?: string) {
    const entries = new Map<string, UsageEntry>();
    const warnings = new Set<string>();
    if (!rootSessionID) return { entries: [], sessionIDs: [], warnings: [] };

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
            addUsage(entries, warnings, sessionID, context, tokenUsage.prompt, tokenUsage.completion, tokenUsage.cost);
          }
          continue;
        }

        const tokenUsage = extractTokenUsage(info);
        if (!tokenUsage) continue;
        addUsage(entries, warnings, sessionID, context, tokenUsage.prompt, tokenUsage.completion, tokenUsage.cost);
      }
    }

    return { entries: [...entries.values()], sessionIDs: [...sessionIDs], warnings: [...warnings] };
  }

  function buildReportFromEntries(rootSessionID: string | undefined, mode: LedgerMode, entries: UsageEntry[], sessionIDs: string[], warnings: string[]): LedgerReport {
    const totals = {
      agents: 0,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };

    const byAgent = new Map<string, UsageEntry[]>();
    for (const entry of entries) {
      if (!byAgent.has(entry.agent)) byAgent.set(entry.agent, []);
      byAgent.get(entry.agent)!.push(entry);

      totals.calls += entry.calls;
      totals.promptTokens += entry.promptTokens;
      totals.completionTokens += entry.completionTokens;
      totals.totalTokens += entry.totalTokens;
      totals.estimatedCost += entry.estimatedCost;
    }

    totals.agents = byAgent.size;

    const agents: AgentBreakdown[] = [...byAgent.entries()].map(([agent, agentEntries]) => {
      const agentTotals = agentEntries.reduce((acc, entry) => {
        acc.promptTokens += entry.promptTokens;
        acc.completionTokens += entry.completionTokens;
        acc.totalTokens += entry.totalTokens;
        acc.estimatedCost += entry.estimatedCost;
        acc.calls += entry.calls;
        return acc;
      }, { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, calls: 0 });

      const byModel = new Map<string, UsageEntry[]>();
      for (const entry of agentEntries) {
        const key = `${entry.provider}/${entry.model}`;
        if (!byModel.has(key)) byModel.set(key, []);
        byModel.get(key)!.push(entry);
      }

      const models = [...byModel.values()].map((modelEntries) => {
        const first = modelEntries[0];
        const modelTotals = modelEntries.reduce((acc, entry) => {
          acc.promptTokens += entry.promptTokens;
          acc.completionTokens += entry.completionTokens;
          acc.totalTokens += entry.totalTokens;
          acc.estimatedCost += entry.estimatedCost;
          acc.calls += entry.calls;
          return acc;
        }, { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, calls: 0 });

        const sessions = modelEntries
          .map((entry) => ({
            sessionID: entry.sessionID,
            promptTokens: entry.promptTokens,
            completionTokens: entry.completionTokens,
            totalTokens: entry.totalTokens,
            estimatedCost: entry.estimatedCost,
            calls: entry.calls,
            percentOfTotalTokens: roundPercent(percent(entry.totalTokens, totals.totalTokens)),
          }))
          .sort((a, b) => b.totalTokens - a.totalTokens);

        return {
          provider: first.provider,
          model: first.model,
          promptTokens: modelTotals.promptTokens,
          completionTokens: modelTotals.completionTokens,
          totalTokens: modelTotals.totalTokens,
          estimatedCost: modelTotals.estimatedCost,
          calls: modelTotals.calls,
          percentOfTotalTokens: roundPercent(percent(modelTotals.totalTokens, totals.totalTokens)),
          sessions,
        };
      }).sort((a, b) => b.totalTokens - a.totalTokens);

      return {
        agent,
        promptTokens: agentTotals.promptTokens,
        completionTokens: agentTotals.completionTokens,
        totalTokens: agentTotals.totalTokens,
        estimatedCost: agentTotals.estimatedCost,
        calls: agentTotals.calls,
        percentOfTotalTokens: roundPercent(percent(agentTotals.totalTokens, totals.totalTokens)),
        models,
      };
    }).sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      version: LEDGER_VERSION,
      mode,
      rootSessionID,
      sessionIDs,
      totals: {
        ...totals,
        estimatedCost: Number(totals.estimatedCost.toFixed(8)),
      },
      agents,
      warnings,
    };
  }

  async function buildReport(rootSessionID: string | undefined, mode: LedgerMode): Promise<LedgerReport> {
    const { entries, sessionIDs, warnings } = await buildUsageEntries(rootSessionID);
    return buildReportFromEntries(rootSessionID, mode, entries, sessionIDs, warnings);
  }

  function formatTokens(tokens: number) {
    return tokens.toLocaleString();
  }

  function formatCompactTokens(tokens: number) {
    const units = [
      { threshold: 1_000_000_000, suffix: "B" },
      { threshold: 1_000_000, suffix: "M" },
      { threshold: 1_000, suffix: "k" },
    ];

    const unit = units.find((item) => Math.abs(tokens) >= item.threshold);
    if (!unit) return String(tokens);

    const scaled = tokens / unit.threshold;
    const rounded = scaled >= 100 || Number.isInteger(scaled)
      ? Math.round(scaled).toString()
      : scaled >= 10
        ? scaled.toFixed(1).replace(/\.0$/, "")
        : scaled.toFixed(2).replace(/\.?0+$/, "");

    return `${rounded}${unit.suffix}`;
  }

  function formatTotalTokens(tokens: number) {
    const exact = formatTokens(tokens);
    const compact = formatCompactTokens(tokens);
    return compact === String(tokens) ? exact : `${exact} (${compact})`;
  }

  function formatCost(cost: number) {
    return `$${cost.toFixed(4)}`;
  }

  function formatPercent(value: number) {
    return `${value.toFixed(1)}%`;
  }

  function formatSummary(report: LedgerReport) {
    if (report.totals.totalTokens === 0) return "No usage recorded yet.";

    let output = "=== Agent Ledger Summary ===\n\n";
    output += `Sessions: ${report.sessionIDs.length}\n`;
    output += `Total: ${formatTotalTokens(report.totals.totalTokens)} tokens • ${report.totals.calls} calls • ~${formatCost(report.totals.estimatedCost)}\n\n`;

    output += "Totals by Agent:\n";
    for (const agent of report.agents) {
      output += `- ${agent.agent}: ${formatTotalTokens(agent.totalTokens)} tokens (${formatPercent(agent.percentOfTotalTokens)}), ${agent.calls} calls, ~${formatCost(agent.estimatedCost)}\n`;
      const topModel = agent.models[0];
      if (topModel) {
        output += `  top model: ${topModel.provider}/${topModel.model} (${formatTotalTokens(topModel.totalTokens)} tokens, ${formatPercent(topModel.percentOfTotalTokens)} of total)\n`;
      }
    }

    output += "\nTotals by Agent by Model:\n";
    for (const agent of report.agents) {
      for (const model of agent.models) {
        output += `- ${agent.agent} / ${model.provider}/${model.model}: ${formatTotalTokens(model.totalTokens)} tokens (${formatPercent(model.percentOfTotalTokens)}), ${model.calls} calls, ~${formatCost(model.estimatedCost)}\n`;
      }
    }

    if (report.warnings.length > 0) {
      output += "\nWarnings:\n";
      for (const warning of report.warnings) output += `- ${warning}\n`;
    }

    return output.trimEnd();
  }

  function formatDetail(report: LedgerReport) {
    if (report.totals.totalTokens === 0) return "No usage recorded yet.";

    let output = "=== Agent Ledger (active session tree) ===\n\n";
    output += `Sessions: ${report.sessionIDs.length}\n`;
    output += `Total: ${formatTotalTokens(report.totals.totalTokens)} tokens • ${report.totals.calls} calls • ~${formatCost(report.totals.estimatedCost)}\n\n`;

    output += "Totals by Agent:\n";
    for (const agent of report.agents) {
      output += `- ${agent.agent}: ${formatTotalTokens(agent.totalTokens)} tokens (${formatPercent(agent.percentOfTotalTokens)}), ${agent.calls} calls, ~${formatCost(agent.estimatedCost)}\n`;
    }

    output += "\nTotals by Agent by Model:\n";
    for (const agent of report.agents) {
      for (const model of agent.models) {
        output += `- ${agent.agent} / ${model.provider}/${model.model}: ${formatTotalTokens(model.totalTokens)} tokens (${formatPercent(model.percentOfTotalTokens)}), ${model.calls} calls, ~${formatCost(model.estimatedCost)}\n`;
      }
    }

    output += "\nDetail:\n\n";

    for (const agent of report.agents) {
      output += `Agent: ${agent.agent} - ${formatTotalTokens(agent.totalTokens)} tokens (${formatPercent(agent.percentOfTotalTokens)}), ${agent.calls} calls, ~${formatCost(agent.estimatedCost)}\n`;

      for (const model of agent.models) {
        output += `  ${model.provider}/${model.model}: ${model.calls} calls, ${formatTotalTokens(model.totalTokens)} tokens (${formatPercent(model.percentOfTotalTokens)}), ~${formatCost(model.estimatedCost)}\n`;

        for (const session of model.sessions) {
          output += `    session ${compactSessionID(session.sessionID)}: ${session.calls} calls, ${formatTotalTokens(session.totalTokens)} tokens (${formatPercent(session.percentOfTotalTokens)}), ~${formatCost(session.estimatedCost)}\n`;
        }
      }

      output += "\n";
    }

    if (report.warnings.length > 0) {
      output += "Warnings:\n";
      for (const warning of report.warnings) output += `- ${warning}\n`;
    }

    return output.trimEnd();
  }

  function formatReport(report: LedgerReport) {
    return report.mode === "summary" ? formatSummary(report) : formatDetail(report);
  }

  function escapeMarkdownCell(value: string) {
    return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
  }

  function markdownRow(values: Array<string | number>) {
    return `| ${values.map((value) => escapeMarkdownCell(String(value))).join(" | ")} |`;
  }

  function formatMarkdownReport(report: LedgerReport) {
    let output = `# Agent Ledger ${report.mode === "summary" ? "Summary" : "Detail"}\n\n`;

    if (report.totals.totalTokens === 0) {
      output += "No usage recorded yet.\n";
      return output;
    }

    output += markdownRow(["Metric", "Value"]) + "\n";
    output += markdownRow(["---", "---"]) + "\n";
    output += markdownRow(["Version", report.version]) + "\n";
    output += markdownRow(["Root session", report.rootSessionID || "unknown"]) + "\n";
    output += markdownRow(["Sessions", report.sessionIDs.length]) + "\n";
    output += markdownRow(["Agents", report.totals.agents]) + "\n";
    output += markdownRow(["Calls", report.totals.calls]) + "\n";
    output += markdownRow(["Prompt tokens", formatTokens(report.totals.promptTokens)]) + "\n";
    output += markdownRow(["Completion tokens", formatTokens(report.totals.completionTokens)]) + "\n";
    output += markdownRow(["Total tokens", formatTotalTokens(report.totals.totalTokens)]) + "\n";
    output += markdownRow(["Estimated cost", `~${formatCost(report.totals.estimatedCost)}`]) + "\n\n";

    output += "## Totals by Agent\n\n";
    output += markdownRow(["Agent", "Calls", "Prompt", "Completion", "Total", "% total", "Est. cost"]) + "\n";
    output += markdownRow(["---", "---:", "---:", "---:", "---:", "---:", "---:"]) + "\n";
    for (const agent of report.agents) {
      output += markdownRow([
        agent.agent,
        agent.calls,
        formatTokens(agent.promptTokens),
        formatTokens(agent.completionTokens),
        formatTotalTokens(agent.totalTokens),
        formatPercent(agent.percentOfTotalTokens),
        `~${formatCost(agent.estimatedCost)}`,
      ]) + "\n";
    }

    output += "\n## Totals by Agent by Model\n\n";
    output += markdownRow(["Agent", "Provider/model", "Calls", "Prompt", "Completion", "Total", "% total", "Est. cost"]) + "\n";
    output += markdownRow(["---", "---", "---:", "---:", "---:", "---:", "---:", "---:"]) + "\n";
    for (const agent of report.agents) {
      for (const model of agent.models) {
        output += markdownRow([
          agent.agent,
          `${model.provider}/${model.model}`,
          model.calls,
          formatTokens(model.promptTokens),
          formatTokens(model.completionTokens),
          formatTotalTokens(model.totalTokens),
          formatPercent(model.percentOfTotalTokens),
          `~${formatCost(model.estimatedCost)}`,
        ]) + "\n";
      }
    }

    if (report.mode === "detail") {
      output += "\n## Detail\n";

      for (const agent of report.agents) {
        output += `\n### ${agent.agent}\n\n`;
        output += markdownRow(["Provider/model", "Calls", "Prompt", "Completion", "Total", "% total", "Est. cost"]) + "\n";
        output += markdownRow(["---", "---:", "---:", "---:", "---:", "---:", "---:"]) + "\n";

        for (const model of agent.models) {
          output += markdownRow([
            `${model.provider}/${model.model}`,
            model.calls,
            formatTokens(model.promptTokens),
            formatTokens(model.completionTokens),
            formatTotalTokens(model.totalTokens),
            formatPercent(model.percentOfTotalTokens),
            `~${formatCost(model.estimatedCost)}`,
          ]) + "\n";
        }

        for (const model of agent.models) {
          output += `\n#### ${model.provider}/${model.model}\n\n`;
          output += markdownRow(["Session", "Calls", "Prompt", "Completion", "Total", "% total", "Est. cost"]) + "\n";
          output += markdownRow(["---", "---:", "---:", "---:", "---:", "---:", "---:"]) + "\n";

          for (const session of model.sessions) {
            output += markdownRow([
              session.sessionID,
              session.calls,
              formatTokens(session.promptTokens),
              formatTokens(session.completionTokens),
              formatTotalTokens(session.totalTokens),
              formatPercent(session.percentOfTotalTokens),
              `~${formatCost(session.estimatedCost)}`,
            ]) + "\n";
          }
        }
      }
    }

    if (report.warnings.length > 0) {
      output += "\n## Warnings\n\n";
      for (const warning of report.warnings) output += `- ${warning}\n`;
    }

    return output.trimEnd() + "\n";
  }

  function timestampForFilename() {
    return new Date().toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .replace("Z", "")
      .replace(".", "-");
  }

  function resolveExportDirectory(context: ToolContext) {
    const configured = firstString(pluginOptions?.exportDirectory);
    const baseDir = context.directory || context.worktree || directory || worktree || ".";
    if (!configured) return resolve(baseDir, "ledger-reports");
    return isAbsolute(configured) ? configured : resolve(baseDir, configured);
  }

  async function saveReport(context: ToolContext, extension: "md" | "json", contents: string): Promise<SavedReport> {
    const exportDirectory = resolveExportDirectory(context);
    const filename = `ledger-${timestampForFilename()}.${extension}`;
    const filePath = resolve(exportDirectory, filename);
    const mime = extension === "json" ? "application/json" : "text/markdown";

    await mkdir(exportDirectory, { recursive: true });
    await writeFile(filePath, contents, "utf8");

    return {
      format: extension === "json" ? "json" : "markdown",
      filePath,
      fileURL: pathToFileURL(filePath).href,
      filename,
      relativePath: relative(context.directory || directory || exportDirectory, filePath) || basename(filePath),
      mime,
    };
  }

  function formatSavedSummary(report: LedgerReport, saved: SavedReport) {
    let output = `Ledger ${saved.format} saved: ${saved.relativePath}\nPath: ${saved.filePath}\n`;

    if (report.totals.totalTokens === 0) {
      output += "\nNo usage recorded yet.";
      return output;
    }

    output += `\nSessions: ${report.sessionIDs.length}`;
    output += `\nTotal: ${formatTotalTokens(report.totals.totalTokens)} tokens • ${report.totals.calls} calls • ~${formatCost(report.totals.estimatedCost)}`;

    if (report.agents.length > 0) {
      output += "\n\nTotals by Agent:";
      for (const agent of report.agents) {
        output += `\n- ${agent.agent}: ${formatTotalTokens(agent.totalTokens)} tokens (${formatPercent(agent.percentOfTotalTokens)}), ${agent.calls} calls, ~${formatCost(agent.estimatedCost)}`;
      }

      output += "\n\nTotals by Agent by Model:";
      for (const agent of report.agents) {
        for (const model of agent.models) {
          output += `\n- ${agent.agent} / ${model.provider}/${model.model}: ${formatTotalTokens(model.totalTokens)} tokens (${formatPercent(model.percentOfTotalTokens)}), ${model.calls} calls, ~${formatCost(model.estimatedCost)}`;
        }
      }
    }

    if (report.warnings.length > 0) {
      output += `\n\nWarnings: ${report.warnings.length} in saved report`;
    }

    return output;
  }

  function savedReportResult(report: LedgerReport, saved: SavedReport): ToolResult {
    return {
      title: `Ledger ${saved.format} saved`,
      output: formatSavedSummary(report, saved),
      metadata: {
        path: saved.filePath,
        url: saved.fileURL,
        format: saved.format,
        mode: report.mode,
        totalTokens: report.totals.totalTokens,
        estimatedCost: report.totals.estimatedCost,
      },
      attachments: [
        {
          type: "file",
          mime: saved.mime,
          url: saved.fileURL,
          filename: saved.filename,
        },
      ],
    };
  }

  async function showCompactToast(sessionID?: string) {
    const report = await buildReport(sessionID, "summary");
    if (report.totals.totalTokens === 0) return;

    const topAgent = report.agents[0];
    const suffix = topAgent ? ` • ${topAgent.agent} ${formatPercent(topAgent.percentOfTotalTokens)}` : "";
    const summary = `Ledger: ${report.totals.agents} agents • ${formatCompactTokens(report.totals.totalTokens)} tokens • $${report.totals.estimatedCost.toFixed(3)}${suffix}`;
    await client.tui?.showToast?.({
      body: {
        message: summary,
        variant: "info",
      },
    });
  }

  async function showLedger(context: ToolContext, mode: LedgerMode): Promise<ToolResult> {
    const report = await buildReport(context.sessionID, mode);
    const output = formatReport(report);
    const saved = await saveReport(context, "md", formatMarkdownReport(report));

    await client.app.log?.({ body: { service: "ledger", level: "info", message: output } });
    context.metadata({
      title: "Ledger report saved",
      metadata: { path: saved.filePath, format: saved.format },
    });

    if (report.totals.totalTokens > 0) {
      await client.tui?.showToast?.({
        body: {
          message: `Ledger ${mode} saved • Total ~$${report.totals.estimatedCost.toFixed(3)}`,
          variant: "success",
        },
      });
    }

    return savedReportResult(report, saved);
  }

  async function showLedgerJSON(context: ToolContext, mode: LedgerMode): Promise<ToolResult> {
    const report = await buildReport(context.sessionID, mode);
    const saved = await saveReport(context, "json", JSON.stringify(report, null, 2) + "\n");
    context.metadata({
      title: "Ledger JSON saved",
      metadata: { path: saved.filePath, format: saved.format },
    });
    return savedReportResult(report, saved);
  }

  const modeArg = tool.schema.enum(["summary", "detail"]).optional().describe("Report mode. Use summary for compact totals or detail for per-session breakdowns.");

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
      ledger: tool({
        description: "Save a multi-agent usage ledger Markdown report for the active OpenCode session tree",
        args: {
          mode: modeArg,
        },
        async execute(args: { mode?: LedgerMode }, context: ToolContext) {
          return await showLedger(context, args.mode || "detail");
        },
      }),
      ledger_json: tool({
        description: "Save a machine-readable multi-agent usage ledger JSON report for the active OpenCode session tree",
        args: {
          mode: modeArg,
        },
        async execute(args: { mode?: LedgerMode }, context: ToolContext) {
          return await showLedgerJSON(context, args.mode || "detail");
        },
      }),
    },
  };
};
