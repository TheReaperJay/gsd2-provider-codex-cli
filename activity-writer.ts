/**
 * Codex activity writer.
 *
 * Writes JSONL activity entries compatible with GSD session forensics.
 */

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
  private readonly toolMap = new Map<string, string>();
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

  processToolStart(toolCallId: string, command: string): void {
    this.toolMap.set(toolCallId, command);
    this.entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "Bash",
            id: toolCallId,
            arguments: { command },
          },
        ],
      },
    });
  }

  processToolResult(toolCallId: string, aggregatedOutput: string, exitCode: number | null): void {
    const command = this.toolMap.get(toolCallId) ?? "";
    const content: Array<{ type: "text"; text: string }> = [];
    if (command) content.push({ type: "text", text: `$ ${command}` });
    if (typeof exitCode === "number") content.push({ type: "text", text: `exit_code: ${exitCode}` });
    const output = cleanText(aggregatedOutput);
    if (output) content.push({ type: "text", text: output });

    this.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "Bash",
        isError: typeof exitCode === "number" ? exitCode !== 0 : false,
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

