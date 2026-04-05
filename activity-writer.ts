/**
 * Codex activity writer.
 *
 * Writes JSONL activity entries compatible with GSD session forensics.
 */

import type { GsdToolResultPayload } from "@thereaperjay/gsd-provider-api";
import { closeSync, constants, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface CodexUnitMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const SEQ_PREFIX_RE = /^(\d+)-/;

function scanNextSequence(activityDir: string): number {
  let maxSeq = 0;
  try {
    for (const f of readdirSync(activityDir)) {
      const match = f.match(SEQ_PREFIX_RE);
      if (match) maxSeq = Math.max(maxSeq, Number.parseInt(match[1]!, 10));
    }
  } catch {
    return 1;
  }
  return maxSeq + 1;
}

function claimNextFilePath(activityDir: string, unitType: string, safeUnitId: string): string {
  let seq = scanNextSequence(activityDir);
  for (let attempts = 0; attempts < 1000; attempts += 1) {
    const seqStr = String(seq).padStart(3, "0");
    const filePath = join(activityDir, `${seqStr}-${unitType}-${safeUnitId}.jsonl`);
    try {
      const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      closeSync(fd);
      return filePath;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        seq += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to claim activity log sequence in ${activityDir}`);
}

function cleanText(text: string): string {
  return text.replace(/\u0000/g, "").trimEnd();
}

export class CodexActivityWriter {
  private readonly entries: unknown[] = [];
  private readonly toolMap = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  private readonly metrics: CodexUnitMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  constructor(
    private readonly activityDir: string,
    private readonly unitType: string,
    private readonly unitId: string,
  ) {}

  processAssistantText(text: string): void {
    const cleaned = cleanText(text);
    if (!cleaned) return;
    this.entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: cleaned }],
      },
    });
  }

  processToolStart(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    this.toolMap.set(toolCallId, {
      name: toolName,
      arguments: { ...args },
    });
    this.entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: toolName,
            id: toolCallId,
            arguments: { ...args },
          },
        ],
      },
    });
  }

  updateToolArguments(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    this.toolMap.set(toolCallId, {
      name: toolName,
      arguments: { ...args },
    });
  }

  processToolResult(toolCallId: string, toolName: string, result: GsdToolResultPayload): void {
    const stored = this.toolMap.get(toolCallId);
    const content = result.content
      .map((part) => {
        if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
          return { type: "text" as const, text: cleanText(part.text) };
        }
        return null;
      })
      .filter((part): part is { type: "text"; text: string } => Boolean(part && part.text.length > 0));

    this.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: stored?.name ?? toolName,
        isError: result.isError === true,
        content,
      },
    });
  }

  processUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    this.metrics.inputTokens += usage.inputTokens;
    this.metrics.outputTokens += usage.outputTokens;
    this.metrics.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.metrics.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  }

  flush(): string | null {
    if (this.entries.length === 0) return null;
    try {
      mkdirSync(this.activityDir, { recursive: true });
      const safeUnitId = this.unitId.replace(/\//g, "-");
      const filePath = claimNextFilePath(this.activityDir, this.unitType, safeUnitId);
      const fd = openSync(filePath, "w");
      try {
        for (const entry of this.entries) {
          writeSync(fd, `${JSON.stringify(entry)}\n`);
        }
      } finally {
        closeSync(fd);
      }
      return filePath;
    } catch {
      return null;
    }
  }
}
