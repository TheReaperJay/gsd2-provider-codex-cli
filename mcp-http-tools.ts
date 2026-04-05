/**
 * Codex MCP HTTP bridge — exposes GSD tools to Codex via Streamable HTTP.
 *
 * This mirrors Claude provider MCP behavior, but uses an in-process HTTP MCP
 * endpoint so Codex CLI can consume tools through `mcp_servers.<name>.url`.
 */

import { getGsdTools } from "@thereaperjay/gsd-provider-api";
import type { GsdToolDef } from "@thereaperjay/gsd-provider-api";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { ZodRawShape, ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface CodexBridgeToolStartEvent {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface CodexBridgeToolResultEvent {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  };
}

function normalizeMcpResult(raw: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const content = obj.content;
    if (Array.isArray(content)) {
      const normalized = content.map((part) => {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") {
            return { type: "text" as const, text: p.text };
          }
        }
        return { type: "text" as const, text: String(part ?? "") };
      });
      return { content: normalized, isError: obj.isError === true };
    }
  }
  return {
    content: [{ type: "text", text: typeof raw === "string" ? raw : JSON.stringify(raw) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isZodType(value: unknown): value is ZodTypeAny {
  return isRecord(value) && typeof (value as { parse?: unknown }).parse === "function";
}

function withDescription(schema: ZodTypeAny, source: Record<string, unknown>): ZodTypeAny {
  const description = source.description;
  if (typeof description !== "string" || description.trim().length === 0) return schema;
  return schema.describe(description);
}

function literalUnion(values: unknown[]): ZodTypeAny {
  if (values.length === 0) return z.any();
  const literals = values.map((v) => z.literal(v as never));
  if (literals.length === 1) return literals[0]!;
  return z.union(literals as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

function schemaToZod(schema: unknown): ZodTypeAny {
  if (isZodType(schema)) return schema;
  if (!isRecord(schema)) return z.any();

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const items = schema.anyOf.map(schemaToZod);
    if (items.length === 1) return items[0]!;
    return withDescription(z.union(items as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]), schema);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const items = schema.oneOf.map(schemaToZod);
    if (items.length === 1) return items[0]!;
    return withDescription(z.union(items as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]), schema);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return withDescription(literalUnion(schema.enum), schema);
  }

  if ("const" in schema) {
    return withDescription(z.literal(schema.const as never), schema);
  }

  const rawType = schema.type;
  const typeValues = Array.isArray(rawType) ? rawType : [rawType];
  const nonNullTypes = typeValues.filter((t): t is string => typeof t === "string" && t !== "null");
  const nullable = typeValues.includes("null");
  const selectedType = nonNullTypes[0];

  let output: ZodTypeAny;
  switch (selectedType) {
    case "string":
      output = z.string();
      break;
    case "integer":
      output = z.number().int();
      break;
    case "number":
      output = z.number();
      break;
    case "boolean":
      output = z.boolean();
      break;
    case "array": {
      const itemSchema = "items" in schema ? schemaToZod(schema.items) : z.any();
      output = z.array(itemSchema);
      break;
    }
    case "object": {
      const shape = schemaToZodRawShape(schema);
      output = z.object(shape);
      break;
    }
    default:
      output = z.any();
      break;
  }

  output = withDescription(output, schema);
  return nullable ? output.nullable() : output;
}

function schemaToZodRawShape(schema: unknown): ZodRawShape {
  if (!isRecord(schema)) return {};

  if (isRecord(schema.properties)) {
    const requiredSet = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((r): r is string => typeof r === "string")
        : [],
    );

    const shape: ZodRawShape = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      let propSchema = schemaToZod(value);
      if (!requiredSet.has(key)) propSchema = propSchema.optional();
      shape[key] = propSchema;
    }
    return shape;
  }

  const keys = Object.keys(schema);
  const reserved = new Set(["$id", "$schema", "type", "description", "title", "additionalProperties", "required", "properties"]);
  const shape: ZodRawShape = {};
  for (const key of keys) {
    if (reserved.has(key)) continue;
    const value = schema[key];
    if (value === undefined) continue;
    shape[key] = isZodType(value) ? value : schemaToZod(value);
  }
  return shape;
}

function resolveToolSet(contextTools?: readonly GsdToolDef[]): readonly GsdToolDef[] {
  const merged = new Map<string, GsdToolDef>();
  for (const tool of contextTools ?? []) {
    merged.set(tool.name, tool);
  }
  for (const tool of getGsdTools()) {
    if (!merged.has(tool.name)) merged.set(tool.name, tool);
  }
  return Array.from(merged.values());
}

function schemaToJsonSchema(schema: unknown): Record<string, unknown> {
  if (isRecord(schema)) {
    const hasJsonSchemaShape = (
      typeof schema.type === "string"
      || isRecord(schema.properties)
      || Array.isArray(schema.required)
      || Array.isArray(schema.oneOf)
      || Array.isArray(schema.anyOf)
      || Array.isArray(schema.enum)
      || typeof schema.$schema === "string"
    );
    if (hasJsonSchemaShape) return schema;
  }

  try {
    const rawShape = schemaToZodRawShape(schema);
    const converted = zodToJsonSchema(z.object(rawShape), { target: "jsonSchema7" });
    return converted && typeof converted === "object"
      ? (converted as Record<string, unknown>)
      : { type: "object", additionalProperties: true };
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

export interface CodexToolBridge {
  url: string;
  close: () => Promise<void>;
}

export interface CodexToolBridgeOptions {
  shouldBlockContextWrite?: (toolName: string, args: Record<string, unknown>) => string | null;
  onToolStart?: (event: CodexBridgeToolStartEvent) => void;
  onToolResult?: (event: CodexBridgeToolResultEvent) => void;
}

export async function startCodexToolBridge(
  contextTools?: readonly GsdToolDef[],
  options: CodexToolBridgeOptions = {},
): Promise<CodexToolBridge | null> {
  const gsdTools = resolveToolSet(contextTools);
  if (gsdTools.length === 0) return null;

  const [{ Server }, { StreamableHTTPServerTransport }, { createMcpExpressApp }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server"),
    import("@modelcontextprotocol/sdk/server/streamableHttp"),
    import("@modelcontextprotocol/sdk/server/express"),
    import("@modelcontextprotocol/sdk/types"),
  ]);

  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const activeClosers = new Set<() => Promise<void>>();
  let requestSequence = 0;

  const createServer = () => {
    const server = new Server(
      { name: "gsd-tools", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: gsdTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: schemaToJsonSchema(tool.schema),
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request: unknown) => {
      const req = request as { params?: { name?: unknown; arguments?: unknown } };
      const name = typeof req?.params?.name === "string" ? req.params.name : "";
      const args = isRecord(req?.params?.arguments) ? req.params.arguments : {};
      const requestId = `bridge_${(++requestSequence).toString(36)}`;

      const tool = gsdTools.find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unknown tool: ${name || "(empty)"}` }],
        };
      }

      options.onToolStart?.({
        requestId,
        toolName: name,
        args,
      });

      const blockedReason = options.shouldBlockContextWrite?.(name, args);
      if (blockedReason) {
        const blockedResult = {
          content: [{ type: "text" as const, text: blockedReason }],
          isError: true,
        };
        options.onToolResult?.({
          requestId,
          toolName: name,
          args,
          result: blockedResult,
        });
        return {
          isError: blockedResult.isError,
          content: blockedResult.content,
        };
      }

      try {
        const raw = await tool.execute(args, undefined);
        const result = normalizeMcpResult(raw);
        options.onToolResult?.({
          requestId,
          toolName: name,
          args,
          result,
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = { isError: true, content: [{ type: "text" as const, text: message }] };
        options.onToolResult?.({
          requestId,
          toolName: name,
          args,
          result,
        });
        return result;
      }
    });

    return server;
  };

  app.post("/mcp", async (req: unknown, res: unknown) => {
    const request = req as Record<string, unknown>;
    const response = res as {
      headersSent?: boolean;
      status: (code: number) => { json: (body: unknown) => void };
      on: (event: string, listener: () => void) => void;
    };

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer();

    let closed = false;
    const closeOnce = async () => {
      if (closed) return;
      closed = true;
      activeClosers.delete(closeOnce);
      try { await transport.close(); } catch {}
      try { await server.close(); } catch {}
    };

    activeClosers.add(closeOnce);
    response.on("close", () => { void closeOnce(); });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, request.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: `MCP bridge error: ${message}` },
          id: null,
        });
      }
      await closeOnce();
    }
  });

  app.get("/mcp", (_req: unknown, res: unknown) => {
    const response = res as { status: (code: number) => { json: (body: unknown) => void } };
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req: unknown, res: unknown) => {
    const response = res as { status: (code: number) => { json: (body: unknown) => void } };
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", () => resolve());
    listener.once("error", reject);
  });

  const address = listener.address() as AddressInfo | null;
  if (!address || typeof address.port !== "number") {
    listener.close();
    throw new Error("Failed to determine MCP bridge port");
  }

  const url = `http://127.0.0.1:${address.port}/mcp`;

  return {
    url,
    close: async () => {
      for (const closer of Array.from(activeClosers)) {
        await closer();
      }
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
      });
    },
  };
}
