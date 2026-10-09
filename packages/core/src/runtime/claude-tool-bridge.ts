import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { NativeToolDef } from "./types.js";

/** MCP server name the bridge registers under; Claude sees `mcp__zero__<tool>`. */
export const CLAUDE_TOOL_BRIDGE_SERVER = "zero";

/** One tool invocation Claude made through the bridge, waiting for 0 to run it. */
export interface BridgedToolCall {
  /** Bridge-assigned id; becomes the `tool_use` id the turn engine sees. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface BridgedToolResult {
  content: string;
  isError?: boolean;
}

interface PendingCall {
  call: BridgedToolCall;
  settle: (result: BridgedToolResult) => void;
}

/**
 * Session-scoped, loopback-only MCP endpoint that exposes 0's tool list to a
 * `claude -p` subprocess WITHOUT executing anything itself.
 *
 * A `tools/call` request is parked: the bridge assigns it an id, reports it
 * through `onCall`, and holds the HTTP response open until the owner hands
 * back the result via {@link ClaudeToolBridge.resolve}. The owner (the
 * `CliNativeRuntime`) surfaces parked calls to the turn engine as ordinary
 * `tool_use` blocks, so they run through the engine's own approval, scope,
 * recon and budget gates exactly like an API-runtime tool call.
 *
 * Exposure is limited to 127.0.0.1 on an ephemeral port, a per-bridge random
 * bearer token, and a Host-header check against DNS rebinding.
 */
export class ClaudeToolBridge {
  readonly token = randomBytes(32).toString("hex");
  private http: HttpServer | undefined;
  private transport: StreamableHTTPServerTransport | undefined;
  private mcp: Server | undefined;
  private port = 0;
  private readonly pending = new Map<string, PendingCall>();
  private closed = false;

  constructor(
    private readonly tools: readonly NativeToolDef[],
    private readonly onCall: (call: BridgedToolCall) => void,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** Ids of calls Claude is still waiting on. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  async start(): Promise<void> {
    const mcp = new Server({ name: CLAUDE_TOOL_BRIDGE_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
    const toolNames = new Set(this.tools.map((tool) => tool.name));
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      const name = request.params.name;
      // Only the tools offered for this turn are routable; anything else is
      // refused here and never reaches the engine.
      if (this.closed || !toolNames.has(name)) {
        return Promise.resolve({ content: [{ type: "text" as const, text: `Tool "${name}" is not available in this session.` }], isError: true });
      }
      const args = request.params.arguments;
      const call: BridgedToolCall = {
        id: `toolu_zero_${randomUUID().replace(/-/g, "")}`,
        name,
        input: args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {},
      };
      return new Promise((resolve) => {
        const settle = (result: BridgedToolResult) => {
          this.pending.delete(call.id);
          resolve({ content: [{ type: "text" as const, text: result.content }], ...(result.isError ? { isError: true } : {}) });
        };
        this.pending.set(call.id, { call, settle });
        // Claude cancelled the request (e.g. it was interrupted): forget it so
        // a late engine result cannot be delivered twice.
        extra.signal.addEventListener("abort", () => this.pending.delete(call.id), { once: true });
        this.onCall(call);
      });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await mcp.connect(transport);
    this.mcp = mcp;
    this.transport = transport;

    const http = createServer((req, res) => { void this.handle(req, res); });
    // Tool calls can legitimately wait a long time (operator approval in
    // standard mode, long scans); the SSE keep-alive keeps the stream warm.
    http.requestTimeout = 0;
    http.headersTimeout = 60_000;
    http.timeout = 0;
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); });
    });
    http.unref();
    this.http = http;
    this.port = (http.address() as AddressInfo).port;
  }

  /** Deliver 0's result for a parked call. Returns false when it is no longer pending. */
  resolve(id: string, result: BridgedToolResult): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle(result);
    return true;
  }

  /** Answer every parked call with an error (used when the turn is abandoned). */
  rejectAll(message: string): void {
    for (const entry of [...this.pending.values()]) entry.settle({ content: message, isError: true });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll("The 0 session ended before this tool call completed.");
    await this.transport?.close().catch(() => undefined);
    await this.mcp?.close().catch(() => undefined);
    const http = this.http;
    if (http) {
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/mcp" || !this.transport) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    try {
      await this.transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end();
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return false;
    const header = req.headers.authorization ?? "";
    const expected = Buffer.from(`Bearer ${this.token}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** MCP config JSON for `claude --mcp-config`, pointing at this bridge. */
  mcpConfig(): string {
    return JSON.stringify({
      mcpServers: {
        [CLAUDE_TOOL_BRIDGE_SERVER]: {
          type: "http",
          url: this.url,
          headers: { Authorization: `Bearer ${this.token}` },
        },
      },
    });
  }
}
