/**
 * Codex CLI provider metadata + JSONL stream translator.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerProviderInfo } from "@thereaperjay/gsd-provider-api";
import { CodexActivityWriter } from "./activity-writer.ts";
import { startCodexToolBridge } from "./mcp-http-tools.ts";
import type {
  GsdProviderInfo,
  GsdModel,
  GsdEvent,
  GsdStreamContext,
  GsdProviderDeps,
  GsdUsage,
  GsdToolResultPayload,
  CliCheckResult,
} from "@thereaperjay/gsd-provider-api";

const CODEX_MODEL_ALIASES: Record<string, string> = {
  "codex-reaper:gpt-5.4": "gpt-5.4",
  "codex-reaper:gpt-5.4-mini": "gpt-5.4-mini",
  "codex-reaper:gpt-5.3-codex": "gpt-5.3-codex",
  "codex-reaper:gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
  "codex-reaper:gpt-5.2-codex": "gpt-5.2-codex",
};

const CODEX_PLAN_LABELS: Record<string, string> = {
  free: "Codex Free",
  plus: "Codex Plus",
  pro: "Codex Pro",
  team: "Codex Team",
  enterprise: "Codex Enterprise",
  max: "Codex Max",
};

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapCodexPlanLabel(rawPlanType: string): string | undefined {
  const normalized = rawPlanType.trim().toLowerCase();
  if (normalized.length === 0) return undefined;

  const compact = normalized.replace(/^chatgpt[\s_-]*/, "");
  if (CODEX_PLAN_LABELS[compact]) return CODEX_PLAN_LABELS[compact];

  const pretty = toTitleCaseWords(compact);
  if (pretty.length === 0) return undefined;
  return "Codex " + pretty;
}

function readCodexAuthMetadata(): { email?: string; subscriptionLabel?: string } {
  try {
    const configuredHome = process.env.CODEX_HOME?.trim() ?? "";
    const authPath = configuredHome.length > 0
      ? join(configuredHome, "auth.json")
      : join(homedir(), ".codex", "auth.json");

    if (!existsSync(authPath)) return {};

    const auth = toRecord(JSON.parse(readFileSync(authPath, "utf-8")));
    const tokens = toRecord(auth.tokens);
    const idToken = asString(tokens.id_token).trim();
    if (idToken.length === 0) return {};

    const segments = idToken.split(".");
    if (segments.length < 2) return {};

    const payload = toRecord(JSON.parse(Buffer.from(segments[1], "base64url").toString("utf-8")));
    const email = asString(payload.email).trim();

    const authClaims = toRecord(payload["https://api.openai.com/auth"]);
    const rawPlanType = asString(authClaims.chatgpt_plan_type || payload.chatgpt_plan_type).trim();
    const subscriptionLabel = mapCodexPlanLabel(rawPlanType);

    return {
      ...(email.length > 0 ? { email } : {}),
      ...(subscriptionLabel ? { subscriptionLabel } : {}),
    };
  } catch {
    return {};
  }
}

function checkCodexCli(spawnFn: typeof spawnSync = spawnSync): CliCheckResult {
  const versionResult = spawnFn("codex", ["--version"], { encoding: "utf-8" });
  if (versionResult.error || versionResult.status !== 0) {
    return {
      ok: false,
      reason: "not-found",
      instruction: "Install Codex CLI and ensure `codex` is available on PATH.",
    };
  }

  const authResult = spawnFn("codex", ["login", "status"], { encoding: "utf-8" });
  if (authResult.error || authResult.status !== 0) {
    return {
      ok: false,
      reason: "not-authenticated",
      instruction: "Run `codex login` in your terminal.",
    };
  }

  const combined = `${authResult.stdout ?? ""}\n${authResult.stderr ?? ""}`.toLowerCase();
  if (!combined.includes("logged in")) {
    return {
      ok: false,
      reason: "not-authenticated",
      instruction: "Run `codex login` in your terminal.",
    };
  }

  const displayInfo = (authResult.stdout ?? "").trim();
  const metadata = readCodexAuthMetadata();

  return {
    ok: true,
    ...(displayInfo.length > 0 ? { displayInfo } : {}),
    ...(metadata.email ? { email: metadata.email } : {}),
    ...(metadata.subscriptionLabel ? { subscriptionLabel: metadata.subscriptionLabel } : {}),
  };
}

function formatCliAuthenticatedSummary(displayName: string, result: Extract<CliCheckResult, { ok: true }>): string {
  const email = typeof result.email === "string" ? result.email.trim() : "";
  const subscriptionLabel = typeof result.subscriptionLabel === "string" ? result.subscriptionLabel.trim() : "";

  if (email.length > 0 && subscriptionLabel.length > 0) {
    return displayName + " authenticated as " + email + " (" + subscriptionLabel + ")";
  }

  if (email.length > 0) {
    return displayName + " authenticated as " + email;
  }

  if (subscriptionLabel.length > 0) {
    return displayName + " authenticated (" + subscriptionLabel + ")";
  }

  return displayName + " authenticated";
}

function resolveCodexModel(modelId: string): string {
  if (CODEX_MODEL_ALIASES[modelId]) return CODEX_MODEL_ALIASES[modelId];
  if (modelId.startsWith("codex-reaper:")) {
    const tail = modelId.slice("codex-reaper:".length).trim();
    if (tail.length > 0) return tail;
  }
  return "gpt-5.4-mini";
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as Record<string, unknown>;
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
}

function buildPromptFromHistory(context: GsdStreamContext): string {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const transcript: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractMessageText(msg.content);
    if (!text) continue;
    transcript.push(`${msg.role === "user" ? "User" : "Assistant"}:\n${text}`);
  }

  const body = transcript.length > 0
    ? [
      "Continue this conversation and respond to the final User message.",
      "",
      transcript.join("\n\n"),
    ].join("\n")
    : context.userPrompt;

  const system = context.systemPrompt?.trim() ?? "";
  if (!system) return body;

  return [
    "System instructions:",
    system,
    "",
    body,
  ].join("\n");
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asMaybeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function makeToolCallId(seed: string): string {
  const trimmed = seed.trim();
  if (trimmed.length > 0) return trimmed;
  return `codex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function trimDetail(text: string, max = 100): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}...`;
}

function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function buildCommandToolResult(aggregatedOutput: string, exitCode: number | null): GsdToolResultPayload {
  const fallback = exitCode !== null && exitCode !== 0 ? `(command failed with exit code ${exitCode})` : "";
  const text = aggregatedOutput.length > 0 ? aggregatedOutput : fallback;
  return {
    content: text.length > 0 ? [{ type: "text", text }] : [],
    isError: exitCode !== null && exitCode !== 0,
    details: { exitCode },
  };
}

function isToolLikeItem(item: Record<string, unknown>): boolean {
  const itemType = asString(item.type);
  if (!itemType) return false;
  if (itemType === "agent_message" || itemType === "error" || itemType === "command_execution") return false;
  if (itemType.includes("reason") || itemType.includes("thinking")) return false;
  if (itemType === "file_change") return false;

  const command = asString(item.command).trim();
  if (command.length > 0) return true;

  const toolName = asString(item.tool_name).trim() || asString(item.name).trim();
  if (toolName.length > 0) return true;

  return /tool|mcp/i.test(itemType);
}

function buildGenericToolName(itemType: string, item: Record<string, unknown>): string {
  const explicit = asString(item.tool_name) || asString(item.name);
  if (explicit) return explicit;
  return itemType.replace(/_/g, " ");
}

function buildGenericToolDetail(item: Record<string, unknown>): string | undefined {
  const command = asString(item.command).trim();
  if (command.length > 0) return trimDetail(command);
  const name = asString(item.name).trim();
  if (name.length > 0) return trimDetail(name);
  return undefined;
}

type EventQueueResolver = (value: IteratorResult<GsdEvent>) => void;

interface EventQueue {
  events: GsdEvent[];
  resolver: EventQueueResolver | null;
  done: boolean;
  push(event: GsdEvent): void;
  finish(): void;
  next(): Promise<IteratorResult<GsdEvent>>;
}

function createEventQueue(): EventQueue {
  const q: EventQueue = {
    events: [],
    resolver: null,
    done: false,
    push(event: GsdEvent) {
      if (q.done) return;
      if (q.resolver) {
        const resolve = q.resolver;
        q.resolver = null;
        resolve({ value: event, done: false });
      } else {
        q.events.push(event);
      }
    },
    finish() {
      if (q.done) return;
      q.done = true;
      if (q.resolver) {
        const resolve = q.resolver;
        q.resolver = null;
        resolve({ value: undefined as unknown as GsdEvent, done: true });
      }
    },
    next(): Promise<IteratorResult<GsdEvent>> {
      if (q.events.length > 0) {
        return Promise.resolve({ value: q.events.shift()!, done: false });
      }
      if (q.done) {
        return Promise.resolve({ value: undefined as unknown as GsdEvent, done: true });
      }
      return new Promise<IteratorResult<GsdEvent>>((resolve) => {
        q.resolver = resolve;
      });
    },
  };

  return q;
}

function categorizeError(message: string): "rate_limit" | "auth" | "timeout" | "unknown" {
  const text = message.toLowerCase();
  if (text.includes("rate limit") || text.includes("429")) return "rate_limit";
  if (text.includes("auth") || text.includes("login") || text.includes("not logged")) return "auth";
  if (text.includes("timeout") || text.includes("timed out") || text.includes("idle timeout") || text.includes("hard timeout")) {
    return "timeout";
  }
  return "unknown";
}

function isTransientCodexError(message: string): boolean {
  const text = message.toLowerCase();
  if (text.startsWith("reconnecting...")) return true;
  if (text.includes("falling back from websockets")) return true;
  if (text.includes("under-development features enabled")) return true;
  return false;
}

function isPoisonAgentLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower === "[compaction]") return true;
  if (/^compacted from [\d,]+ tokens\b/i.test(trimmed)) return true;
  if (/ctrl\+\w+\s+to\s+expand/i.test(trimmed)) return true;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(trimmed)) return true;
  if (/^\$\s+\/bin\/bash\b/i.test(trimmed)) return true;
  if (/^exit_code:\s*-?\d+\b/i.test(trimmed)) return true;
  return false;
}

function sanitizeAgentMessage(raw: string): string {
  const kept = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !isPoisonAgentLine(line));

  while (kept.length > 0 && kept[0]!.trim().length === 0) kept.shift();
  while (kept.length > 0 && kept[kept.length - 1]!.trim().length === 0) kept.pop();

  return kept.join("\n");
}

function normalizeUsage(raw: unknown): GsdUsage {
  const usage = toRecord(raw);
  return {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asMaybeNumber(usage.cached_input_tokens),
    cacheWriteTokens: asMaybeNumber(usage.cached_output_tokens),
  };
}

function extractWriteTargetFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const redirectionMatch = trimmed.match(/(?:^|\s)(?:>|>>)\s*([^\s]+)/);
  if (redirectionMatch?.[1]) return redirectionMatch[1];

  const teeMatch = trimmed.match(/\btee\b(?:\s+-a)?\s+([^\s]+)/);
  if (teeMatch?.[1]) return teeMatch[1];

  const sedInPlaceMatch = trimmed.match(/\bsed\b\s+-i(?:\s+[^\s]+)?\s+([^\s]+)/);
  if (sedInPlaceMatch?.[1]) return sedInPlaceMatch[1];

  return null;
}

function extractWriteTargetFromToolArgs(args: Record<string, unknown>): string | null {
  const keys = ["file_path", "path", "target_path", "output_path", "destination", "filepath"];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function resolveActivityDir(basePath: string): string {
  let dir = basePath;
  while (dir !== "/") {
    const gsdRoot = join(dir, ".gsd");
    if (existsSync(gsdRoot)) return join(gsdRoot, "activity");
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(basePath, ".gsd", "activity");
}

function codexCliCreateStream(context: GsdStreamContext, deps: GsdProviderDeps): AsyncIterable<GsdEvent> {
  const queue = createEventQueue();

  (async () => {
    const basePath = deps.getBasePath();
    const model = resolveCodexModel(context.modelId);
    const prompt = buildPromptFromHistory(context);
    const supervisorConfig = context.supervisorConfig;
    const { unitType, unitId } = deps.getUnitInfo();
    const activityWriter = new CodexActivityWriter(resolveActivityDir(basePath), unitType, unitId);

    const softTimeoutMs = (supervisorConfig.soft_timeout_minutes ?? 0) * 60 * 1000;
    const idleTimeoutMs = (supervisorConfig.idle_timeout_minutes ?? 0) * 60 * 1000;
    const hardTimeoutMs = (supervisorConfig.hard_timeout_minutes ?? 0) * 60 * 1000;

    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-m",
      model,
      "-",
    ];
    let toolBridge: { close: () => Promise<void> } | null = null;

    let child: ChildProcessWithoutNullStreams | null = null;
    let stdoutBuffer = "";
    let lastActivityAt = Date.now();
    let completionEmitted = false;
    let errorEmitted = false;
    let terminalReason: "none" | "cancel" | "soft_timeout" | "idle_timeout" | "hard_timeout" = "none";
    let lastCodexError: string | null = null;
    let pendingAgentMessage: string | null = null;

    const activeToolCalls = new Set<string>();

    let softHandle: ReturnType<typeof setTimeout> | null = null;
    let idleHandle: ReturnType<typeof setInterval> | null = null;
    let hardHandle: ReturnType<typeof setTimeout> | null = null;
    let killEscalationHandle: ReturnType<typeof setTimeout> | null = null;
    let detachAbort: (() => void) | null = null;

    function clearTimers(): void {
      if (softHandle) clearTimeout(softHandle);
      if (idleHandle) clearInterval(idleHandle);
      if (hardHandle) clearTimeout(hardHandle);
      if (killEscalationHandle) clearTimeout(killEscalationHandle);
      softHandle = null;
      idleHandle = null;
      hardHandle = null;
      killEscalationHandle = null;
    }

    function closeOutstandingTools(): void {
      for (const toolCallId of activeToolCalls) {
        deps.onToolEnd(toolCallId);
        queue.push({ type: "tool_call_end", toolCallId });
      }
      activeToolCalls.clear();
    }

    function emitError(message: string): void {
      if (errorEmitted || completionEmitted) return;
      errorEmitted = true;
      closeOutstandingTools();
      queue.push({
        type: "error",
        message,
        category: categorizeError(message),
      });
    }

    function emitCompletion(usage: GsdUsage, stopReason: string): void {
      if (completionEmitted || errorEmitted) return;
      completionEmitted = true;
      closeOutstandingTools();
      queue.push({ type: "completion", usage, stopReason });
    }

    function terminateChild(reason: typeof terminalReason): void {
      if (!child || child.killed) return;
      if (terminalReason === "none") terminalReason = reason;
      child.kill("SIGTERM");
      killEscalationHandle = setTimeout(() => {
        if (!child || child.killed) return;
        child.kill("SIGKILL");
      }, 5000);
    }

    function startToolCall(item: Record<string, unknown>): void {
      const itemType = asString(item.type);
      if (itemType !== "command_execution") return;

      const toolCallId = makeToolCallId(asString(item.id));
      if (activeToolCalls.has(toolCallId)) return;

      const command = asString(item.command);
      const writeTarget = extractWriteTargetFromCommand(command);
      if (writeTarget) {
        const blockResult = deps.shouldBlockContextWrite(
          "bash",
          writeTarget,
          deps.getMilestoneId(),
          deps.isDepthVerified(),
        );
        if (blockResult.block) {
          const reason = blockResult.reason ?? `Blocked protected write target: ${writeTarget}`;
          lastCodexError = reason;
          emitError(reason);
          terminateChild("cancel");
          return;
        }
      }

      activeToolCalls.add(toolCallId);
      flushPendingAgentMessage(false);
      deps.onToolStart(toolCallId);
      activityWriter.processToolStart(toolCallId, command);
      queue.push({
        type: "tool_call_start",
        toolCallId,
        toolName: "Bash",
        detail: trimDetail(command),
      });
      queue.push({ type: "tool_call_delta", toolCallId, delta: safeJson({ command }) });
    }

    function startGenericToolCall(item: Record<string, unknown>): void {
      const itemType = asString(item.type);
      if (!isToolLikeItem(item)) return;
      if (itemType === "command_execution") return;

      const toolCallId = makeToolCallId(asString(item.id));
      if (activeToolCalls.has(toolCallId)) return;

      activeToolCalls.add(toolCallId);
      flushPendingAgentMessage(false);
      deps.onToolStart(toolCallId);
      const toolName = buildGenericToolName(itemType, item);
      const detail = buildGenericToolDetail(item);
      queue.push({
        type: "tool_call_start",
        toolCallId,
        toolName,
        detail,
      });
      const genericArgs: Record<string, unknown> = {};
      const command = asString(item.command).trim();
      const name = asString(item.name).trim();
      if (command.length > 0) genericArgs.command = command;
      if (name.length > 0) genericArgs.name = name;
      if (detail) genericArgs.detail = detail;
      if (Object.keys(genericArgs).length > 0) {
        queue.push({ type: "tool_call_delta", toolCallId, delta: safeJson(genericArgs) });
      }
    }

    function endToolCall(item: Record<string, unknown>): void {
      const itemType = asString(item.type);
      if (itemType !== "command_execution") return;

      const toolCallId = makeToolCallId(asString(item.id));
      const aggregatedOutput = asString(item.aggregated_output);
      const exitCodeRaw = item.exit_code;
      const exitCode = typeof exitCodeRaw === "number" && Number.isFinite(exitCodeRaw) ? exitCodeRaw : null;
      if (!activeToolCalls.has(toolCallId)) {
        startToolCall(item);
      }
      if (activeToolCalls.has(toolCallId)) {
        activeToolCalls.delete(toolCallId);
        deps.onToolEnd(toolCallId);
        activityWriter.processToolResult(toolCallId, aggregatedOutput, exitCode);
        queue.push({ type: "tool_call_end", toolCallId });
        queue.push({
          type: "tool_result",
          toolCallId,
          toolName: "Bash",
          result: buildCommandToolResult(aggregatedOutput, exitCode),
        });
      }
    }

    function endGenericToolCall(item: Record<string, unknown>): void {
      const itemType = asString(item.type);
      if (!isToolLikeItem(item)) return;
      if (itemType === "command_execution") return;

      const toolCallId = makeToolCallId(asString(item.id));
      const toolName = buildGenericToolName(itemType, item);
      if (!activeToolCalls.has(toolCallId)) {
        startGenericToolCall(item);
      }
      if (activeToolCalls.has(toolCallId)) {
        activeToolCalls.delete(toolCallId);
        deps.onToolEnd(toolCallId);
        queue.push({ type: "tool_call_end", toolCallId });
        const outputText = asString(item.text).trim() || asString(item.message).trim();
        queue.push({
          type: "tool_result",
          toolCallId,
          toolName,
          result: {
            content: outputText.length > 0 ? [{ type: "text", text: outputText }] : [],
            isError: false,
            details: { itemType },
          },
        });
      }
    }

    function pushThinkingText(text: string): void {
      const normalized = text.trim();
      if (!normalized) return;
      const chunk = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
      queue.push({ type: "thinking_delta", thinking: chunk });
    }

    function flushPendingAgentMessage(finalAsText: boolean): void {
      if (!pendingAgentMessage) return;
      const trimmed = pendingAgentMessage.trim();
      pendingAgentMessage = null;
      if (!trimmed) return;
      if (finalAsText) queue.push({ type: "text_delta", text: `${trimmed}\n` });
      else pushThinkingText(trimmed);
    }

    function onAgentMessage(text: string): void {
      if (pendingAgentMessage) {
        const interim = pendingAgentMessage.trim();
        if (interim.length > 0) {
          pushThinkingText(interim);
        }
      }
      pendingAgentMessage = text;
    }

    function handleJsonEvent(event: Record<string, unknown>): void {
      lastActivityAt = Date.now();

      const type = asString(event.type);

      if (type === "item.started") {
        const item = toRecord(event.item);
        const itemType = asString(item.type);
        if (itemType === "command_execution") startToolCall(item);
        else startGenericToolCall(item);
        return;
      }

      if (type === "item.completed") {
        const item = toRecord(event.item);
        const itemType = asString(item.type);

        if (itemType === "command_execution") {
          endToolCall(item);
          return;
        }

        if (itemType === "agent_message") {
          const raw = asString(item.text);
          if (raw.trim().length > 0) {
            const text = sanitizeAgentMessage(raw);
            if (text.trim().length === 0) return;
            activityWriter.processAssistantText(text);
            onAgentMessage(text);
          }
          return;
        }

        if (itemType.includes("reason") || itemType.includes("thinking")) {
          const thought = asString(item.text).trim();
          if (thought.length > 0) {
            pushThinkingText(thought);
          }
          return;
        }

        if (itemType === "error") {
          const message = asString(item.message);
          if (!isTransientCodexError(message) && message.length > 0) {
            lastCodexError = message;
          }
          return;
        }

        endGenericToolCall(item);

        return;
      }

      if (type === "turn.completed") {
        flushPendingAgentMessage(true);
        const usage = normalizeUsage(event.usage);
        activityWriter.processUsage(usage);
        emitCompletion(usage, "stop");
        return;
      }

      if (type === "turn.failed") {
        flushPendingAgentMessage(false);
        const failedMessage = asString(toRecord(event.error).message) || lastCodexError || "Codex turn failed";
        emitError(failedMessage);
        return;
      }

      if (type === "error") {
        const message = asString(event.message);
        if (!isTransientCodexError(message) && message.length > 0) {
          lastCodexError = message;
        }
      }
    }

    function processStdoutChunk(chunk: Buffer): void {
      lastActivityAt = Date.now();
      stdoutBuffer += chunk.toString("utf-8");

      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          handleJsonEvent(parsed);
        } catch {
          // Ignore non-JSON lines from the CLI transport.
        }
      }
    }

    try {
      const bridge = await startCodexToolBridge(context.tools, {
        shouldBlockContextWrite: (toolName, args) => {
          const inputPath = extractWriteTargetFromToolArgs(args);
          if (!inputPath) return null;
          const result = deps.shouldBlockContextWrite(
            toolName,
            inputPath,
            deps.getMilestoneId(),
            deps.isDepthVerified(),
          );
          return result.block ? (result.reason ?? `Blocked protected write target: ${inputPath}`) : null;
        },
      });
      if (bridge) {
        toolBridge = bridge;
        args.push("-c", `mcp_servers.gsd_tools.url=${JSON.stringify(bridge.url)}`);
      }

      child = spawn("codex", args, {
        cwd: basePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      if (context.signal) {
        if (context.signal.aborted) {
          terminalReason = "cancel";
          terminateChild("cancel");
        } else {
          const onAbort = () => terminateChild("cancel");
          context.signal.addEventListener("abort", onAbort, { once: true });
          detachAbort = () => context.signal?.removeEventListener("abort", onAbort);
        }
      }

      if (softTimeoutMs > 0) {
        softHandle = setTimeout(() => terminateChild("soft_timeout"), softTimeoutMs);
      }

      if (idleTimeoutMs > 0) {
        idleHandle = setInterval(() => {
          if (Date.now() - lastActivityAt < idleTimeoutMs) return;
          terminateChild("idle_timeout");
        }, 15000);
      }

      if (hardTimeoutMs > 0) {
        hardHandle = setTimeout(() => terminateChild("hard_timeout"), hardTimeoutMs);
      }

      child.stdout.on("data", processStdoutChunk);

      child.stderr.on("data", (chunk: Buffer) => {
        lastActivityAt = Date.now();
        const line = chunk.toString("utf-8").trim();
        if (!line) return;
        if (!isTransientCodexError(line)) {
          lastCodexError = line;
        }
      });

      child.stdin.write(prompt);
      child.stdin.end();

      const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child?.once("close", (code, signal) => resolve({ code, signal }));
      });

      // Process trailing JSON if stdout ended without newline.
      const trailing = stdoutBuffer.trim();
      if (trailing.length > 0) {
        try {
          handleJsonEvent(JSON.parse(trailing) as Record<string, unknown>);
        } catch {
          // Ignore trailing non-JSON line.
        }
      }

      if (!completionEmitted && !errorEmitted) {
        const exitedCleanly = terminalReason === null && (exitResult.code ?? 0) === 0 && exitResult.signal === null;
        flushPendingAgentMessage(exitedCleanly);
        if (terminalReason === "cancel") {
          emitCompletion({ inputTokens: 0, outputTokens: 0 }, "cancel");
        } else if (terminalReason === "soft_timeout") {
          emitError("Codex execution reached soft timeout");
        } else if (terminalReason === "idle_timeout") {
          emitError("Codex execution reached idle timeout");
        } else if (terminalReason === "hard_timeout") {
          emitError("Codex execution reached hard timeout");
        } else if ((exitResult.code ?? 0) !== 0 || exitResult.signal !== null) {
          emitError(lastCodexError ?? `Codex process exited unexpectedly (code=${String(exitResult.code)}, signal=${String(exitResult.signal)})`);
        } else {
          emitCompletion({ inputTokens: 0, outputTokens: 0 }, "stop");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitError(message);
    } finally {
      if (detachAbort) detachAbort();
      clearTimers();
      if (toolBridge) {
        try { await toolBridge.close(); } catch {}
      }
      activityWriter.flush();
      queue.finish();
    }
  })();

  return {
    [Symbol.asyncIterator]() {
      return { next: () => queue.next() };
    },
  };
}

const codexModels: GsdModel[] = [
  { id: "codex-reaper:gpt-5.4", displayName: "GPT-5.4 (Codex CLI)", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
  { id: "codex-reaper:gpt-5.4-mini", displayName: "GPT-5.4 Mini (Codex CLI)", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
  { id: "codex-reaper:gpt-5.3-codex", displayName: "GPT-5.3 Codex (Codex CLI)", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
  { id: "codex-reaper:gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark (Codex CLI)", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
  { id: "codex-reaper:gpt-5.2-codex", displayName: "GPT-5.2 Codex (Codex CLI)", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
];

export const codexProviderInfo: GsdProviderInfo = {
  id: "codex-reaper",
  pluginDir: dirname(fileURLToPath(import.meta.url)),
  displayName: "Codex CLI (Subscription)",
  authMode: "externalCli",
  onboarding: {
    kind: "externalCli",
    hint: "requires codex CLI installed and logged in",
    check: checkCodexCli,
  },
  isReady: () => checkCodexCli().ok,
  afterInstall: (ctx) => {
    const result = checkCodexCli();
    if (result.ok === false) {
      ctx.warn(result.instruction);
      return;
    }

    ctx.log(formatCliAuthenticatedSummary("Codex CLI", result));
  },
  models: codexModels,
  createStream: codexCliCreateStream,
};

registerProviderInfo(codexProviderInfo);
