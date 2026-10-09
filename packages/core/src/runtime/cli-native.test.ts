import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Mock child_process.spawn before importing the module under test. Only the
// `claude` binary is faked — any other spawn (e.g. the console's bash tool in
// the engine integration tests) goes to the real implementation. The real
// `claude` CLI is never started.
const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      args[0] === FAKE_CLAUDE ? spawnMock(...args) : actual.spawn(...args),
  };
});

import {
  CliNativeRuntime,
  buildClaudeArgs,
  mapClaudeStopReason,
  renderClaudeSeedPrompt,
} from "./cli-native.js";
import { ClaudeSubscriptionRuntime, CLAUDE_CODE_PROVIDER_ID } from "./claude-subscription.js";
import { createConsoleRuntime, createConsoleSession } from "../console/turn-engine.js";
import type { ConsoleAutonomyMode } from "../console/turn-engine.js";
import type { NativeMessage, NativeStreamCallbacks, NativeToolDef } from "./types.js";
import { estimateCost } from "@0/shared";

const FAKE_CLAUDE = "fake-claude-bin";
const resolveCommand = () => ({ command: FAKE_CLAUDE, prefixArgs: [] });
const runtimeOptions = { resolveCommand, toolBatchWindowMs: 0 };

// ── Fake `claude -p` process ────────────────────────────────────────────────

interface FakeClaudeContext {
  args: string[];
  prompt: Promise<string>;
  killed: Promise<void>;
  emit(event: Record<string, unknown>): void;
  /** Call a tool through the bridge the runtime started, as Claude Code would. */
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  listTools(): Promise<string[]>;
  exit(code?: number): void;
  stderr(text: string): void;
}
type FakeClaudeScript = (ctx: FakeClaudeContext) => Promise<void>;

function makeFakeClaude(args: string[], script: FakeClaudeScript) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { on: () => void; end: (data?: string) => void };
    kill: (sig?: string) => boolean;
    exitCode: number | null;
    signalCode: string | null;
    pid: undefined;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = undefined;
  let resolvePrompt!: (value: string) => void;
  const prompt = new Promise<string>((resolve) => { resolvePrompt = resolve; });
  child.stdin = { on: () => undefined, end: (data?: string) => resolvePrompt(String(data ?? "")) };
  let resolveKilled!: () => void;
  const killed = new Promise<void>((resolve) => { resolveKilled = resolve; });
  let client: Client | undefined;
  const finish = (code: number | null, signal: string | null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    void client?.close().catch(() => undefined);
    setImmediate(() => child.emit("close", code));
  };
  child.kill = (sig?: string) => {
    resolveKilled();
    finish(null, sig ?? "SIGTERM");
    return true;
  };
  const connect = async (): Promise<Client> => {
    if (client) return client;
    const index = args.indexOf("--mcp-config");
    if (index < 0) throw new Error("no --mcp-config passed");
    const config = JSON.parse(readFileSync(args[index + 1]!, "utf-8")) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    const server = Object.values(config.mcpServers)[0]!;
    const next = new Client({ name: "fake-claude", version: "0.0.0" });
    await next.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
    client = next;
    return next;
  };
  const ctx: FakeClaudeContext = {
    args,
    prompt,
    killed,
    emit: (event) => {
      if (child.exitCode === null && child.signalCode === null) child.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n", "utf-8"));
    },
    stderr: (text) => child.stderr.emit("data", Buffer.from(text, "utf-8")),
    callTool: async (name, toolArgs) => {
      const result = await (await connect()).callTool({ name, arguments: toolArgs }, undefined, { timeout: 60_000 });
      const text = (result.content as Array<{ text?: string }>).map((block) => block.text ?? "").join("");
      return { text, isError: result.isError === true };
    },
    listTools: async () => (await (await connect()).listTools()).tools.map((tool) => tool.name),
    exit: (code = 0) => finish(code, null),
  };
  queueMicrotask(() => {
    script(ctx).catch((error: unknown) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      ctx.stderr(String(error));
      finish(1, null);
    });
  });
  return child;
}

/** Queue scripts for successive spawns; returns the contexts as they start. */
function scriptClaude(...scripts: FakeClaudeScript[]): FakeClaudeContext[] {
  const contexts: FakeClaudeContext[] = [];
  for (const script of scripts) {
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) =>
      makeFakeClaude(args, async (ctx) => { contexts.push(ctx); await script(ctx); }));
  }
  return contexts;
}

const ev = {
  init: (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId }),
  messageStart: (id: string, usage: Record<string, number> = {}) => ({ type: "stream_event", event: { type: "message_start", message: { id, model: "claude-sonnet-4-6", usage } } }),
  textDelta: (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }),
  thinkingDelta: (thinking: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } } }),
  messageDelta: (usage: Record<string, number>) => ({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage } }),
  assistant: (id: string, content: unknown[], usage?: Record<string, number>) => ({ type: "assistant", message: { id, model: "claude-sonnet-4-6", content, ...(usage ? { usage } : {}) } }),
  result: (sessionId: string, extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 1.23, ...extra }),
};

/** A plain final answer: init, text, result, exit 0. */
function answer(sessionId: string, text: string): FakeClaudeScript {
  return async (ctx) => {
    await ctx.prompt;
    ctx.emit(ev.init(sessionId));
    ctx.emit(ev.assistant(`msg_${text.length}`, [{ type: "text", text }]));
    ctx.emit(ev.result(sessionId));
    ctx.exit(0);
  };
}

const httpTool: NativeToolDef = {
  name: "http_request",
  description: "Send an HTTP request",
  input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};
const user = (text: string): NativeMessage => ({ role: "user", content: [{ type: "text", text }] });

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

beforeEach(() => {
  spawnMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("buildClaudeArgs", () => {
  it("disables every built-in tool, ignores user MCP servers and pre-allows only the bridge", () => {
    const args = buildClaudeArgs({ mcpConfigPath: "/tmp/x/mcp.json", systemPromptFile: "/tmp/x/sys.txt", model: "opus" });
    expect(argValue(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(argValue(args, "--setting-sources")).toBe("");
    expect(argValue(args, "--mcp-config")).toBe("/tmp/x/mcp.json");
    expect(argValue(args, "--allowedTools")).toBe("mcp__zero");
    expect(argValue(args, "--permission-mode")).toBe("dontAsk");
    expect(args).toContain("--include-partial-messages");
    expect(argValue(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(argValue(args, "--model")).toBe("opus");
    expect(argValue(args, "--system-prompt-file")).toBe("/tmp/x/sys.txt");
    expect(args).not.toContain("--resume");
    // The prompt travels over stdin, never argv.
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("--verbose");
  });

  it("resumes without re-sending the system prompt, and marks side requests non-persistent", () => {
    const resumed = buildClaudeArgs({ resume: "sess-1", systemPromptFile: "/x" });
    expect(argValue(resumed, "--resume")).toBe("sess-1");
    expect(resumed).not.toContain("--system-prompt-file");
    const ephemeral = buildClaudeArgs({ ephemeral: true });
    expect(ephemeral).toContain("--no-session-persistence");
    expect(ephemeral).not.toContain("--mcp-config");
    expect(argValue(ephemeral, "--tools")).toBe("");
    expect(ephemeral).toContain("--strict-mcp-config");
  });
});

describe("renderClaudeSeedPrompt", () => {
  it("returns the plain request when there is no prior history", () => {
    expect(renderClaudeSeedPrompt([user("hello")])).toBe("hello");
  });

  it("renders history (including tool calls and results) and ends with the latest request", () => {
    const prompt = renderClaudeSeedPrompt([
      user("[summary] earlier work"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "http_request", input: { url: "https://x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "200 OK", is_error: false }] },
      { role: "assistant", content: [{ type: "text", text: "It answered 200." }] },
      user("now check /admin"),
    ]);
    expect(prompt).toContain("<conversation_history>");
    expect(prompt).toContain("[summary] earlier work");
    expect(prompt).toContain('Assistant called tool http_request (id t1) with input {"url":"https://x"}');
    expect(prompt).toContain("Tool result for t1:\n200 OK");
    expect(prompt.trim().endsWith("now check /admin")).toBe(true);
  });

  it("asks to continue when the history ends in tool results", () => {
    const prompt = renderClaudeSeedPrompt([
      user("go"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "http_request", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
    ]);
    expect(prompt).toContain("Continue the task from the latest tool results above.");
  });
});

describe("mapClaudeStopReason", () => {
  it("maps the Claude vocabulary", () => {
    expect(mapClaudeStopReason("tool_use")).toBe("tool_use");
    expect(mapClaudeStopReason("success")).toBe("end_turn");
    expect(mapClaudeStopReason("success_max_turns")).toBe("max_tokens");
    expect(mapClaudeStopReason("error_during_execution")).toBe("error");
    expect(mapClaudeStopReason(undefined)).toBe("end_turn");
  });
});

// ── Runtime behaviour against a fake claude process ─────────────────────────

describe("CliNativeRuntime — claude subscription mode", () => {
  it("rejects type=api and reports codex/gemini as unsupported without spawning", async () => {
    expect(() => new CliNativeRuntime({ type: "api" as never, timeout: 1000 })).toThrow(/CliNativeRuntime/);
    const rt = new CliNativeRuntime({ type: "codex", timeout: 1000 }, runtimeOptions);
    const result = await rt.executeNative("system", [user("hi")], [httpTool]);
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("only supported for the 'claude' CLI runtime");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("routes a Claude tool call through the caller exactly once and resumes the same process with the result", async () => {
    let toolAnswer: { text: string; isError: boolean } | undefined;
    const contexts = scriptClaude(async (c) => {
      expect(await c.listTools()).toEqual(["http_request"]);
      c.emit(ev.init("sess-1"));
      c.emit(ev.assistant("m1", [{ type: "text", text: "Probing." }]));
      // Claude Code echoes its own tool_use on stdout; it must be ignored.
      c.emit(ev.assistant("m1", [{ type: "tool_use", id: "toolu_echo", name: "mcp__zero__http_request", input: { url: "https://x" } }]));
      toolAnswer = await c.callTool("http_request", { url: "https://x" });
      c.emit(ev.assistant("m2", [{ type: "text", text: "Got 200." }]));
      c.emit(ev.result("sess-1"));
      c.exit(0);
    });
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("scan https://x")];

    const first = await rt.executeNative("you are 0", messages, [httpTool]);
    expect(first.stopReason).toBe("tool_use");
    const toolUses = first.content.filter((b) => b.type === "tool_use");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({ name: "http_request", input: { url: "https://x" } });
    expect(first.content[0]).toEqual({ type: "text", text: "Probing." });
    expect(first.content.some((b) => b.type === "tool_use" && b.id === "toolu_echo")).toBe(false);
    expect(await contexts[0]!.prompt).toBe("scan https://x");

    const id = (toolUses[0] as { id: string }).id;
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: '{"status":200}' }] });
    const second = await rt.executeNative("you are 0", messages, [httpTool]);
    expect(second.stopReason).toBe("end_turn");
    expect(second.content).toEqual([{ type: "text", text: "Got 200." }]);
    expect(toolAnswer).toEqual({ text: '{"status":200}', isError: false });
    // One process served both rounds.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(argValue(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");
    expect(argValue(args, "--allowedTools")).toBe("mcp__zero");
  });

  it("forwards an operator denial (is_error result) to Claude without running anything", async () => {
    let toolAnswer: { text: string; isError: boolean } | undefined;
    scriptClaude(async (c) => {
      c.emit(ev.init("s"));
      toolAnswer = await c.callTool("http_request", { url: "https://x" });
      c.emit(ev.assistant("m2", [{ type: "text", text: "Understood, not running it." }]));
      c.emit(ev.result("s"));
      c.exit(0);
    });
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("go")];
    const first = await rt.executeNative("sys", messages, [httpTool]);
    const id = (first.content.find((b) => b.type === "tool_use") as { id: string }).id;
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "not approved", is_error: true }] });
    const second = await rt.executeNative("sys", messages, [httpTool]);
    expect(second.stopReason).toBe("end_turn");
    expect(toolAnswer).toEqual({ text: "not approved", isError: true });
  });

  it("refuses a tool that was not offered this turn without surfacing it", async () => {
    let refused: { text: string; isError: boolean } | undefined;
    scriptClaude(async (c) => {
      c.emit(ev.init("s"));
      refused = await c.callTool("bash", { command: "rm -rf /" });
      c.emit(ev.result("s"));
      c.exit(0);
    });
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const result = await rt.executeNative("sys", [user("go")], [httpTool]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.content.some((b) => b.type === "tool_use")).toBe(false);
    expect(refused?.isError).toBe(true);
  });

  it("streams text and reasoning deltas, and does not re-emit streamed text", async () => {
    scriptClaude(async (c) => {
      c.emit(ev.init("s"));
      c.emit(ev.messageStart("m1", { input_tokens: 10 }));
      c.emit(ev.thinkingDelta("hmm"));
      c.emit(ev.textDelta("Hel"));
      c.emit(ev.textDelta("lo"));
      c.emit(ev.assistant("m1", [{ type: "text", text: "Hello" }]));
      c.emit(ev.assistant("m9", [{ type: "text", text: "Unstreamed" }]));
      c.emit(ev.result("s"));
      c.exit(0);
    });
    const deltas: Array<[string, string]> = [];
    const callbacks: NativeStreamCallbacks = { onDelta: (scope, text) => deltas.push([scope, text]) };
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const result = await rt.executeNative("sys", [user("hi")], [httpTool], callbacks);
    expect(deltas).toEqual([
      ["reasoning", "hmm"],
      ["assistant_response", "Hel"],
      ["assistant_response", "lo"],
      ["assistant_response", "Unstreamed"],
    ]);
    expect(result.content).toEqual([{ type: "text", text: "Hello" }, { type: "text", text: "Unstreamed" }]);
  });

  it("maps usage per API message without double counting across repeated events and rounds", async () => {
    scriptClaude(async (c) => {
      c.emit(ev.init("s"));
      c.emit(ev.messageStart("m1", { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 }));
      // Claude Code repeats the message usage on every content-block event.
      c.emit(ev.assistant("m1", [{ type: "text", text: "a" }], { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 }));
      c.emit(ev.assistant("m1", [{ type: "tool_use", id: "x", name: "mcp__zero__http_request", input: {} }], { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 }));
      const pending = c.callTool("http_request", { url: "u" });
      // The final output count arrives after the tool call started.
      c.emit(ev.messageDelta({ output_tokens: 20 }));
      await pending;
      c.emit(ev.messageStart("m2", { input_tokens: 200 }));
      c.emit(ev.messageDelta({ output_tokens: 5 }));
      c.emit(ev.assistant("m2", [{ type: "text", text: "done" }], { input_tokens: 200, output_tokens: 5 }));
      c.emit(ev.result("s", { usage: { input_tokens: 300, output_tokens: 25 } }));
      c.exit(0);
    });
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("go")];
    const first = await rt.executeNative("sys", messages, [httpTool]);
    const id = (first.content.find((b) => b.type === "tool_use") as { id: string }).id;
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] });
    const second = await rt.executeNative("sys", messages, [httpTool]);
    const total = {
      inputTokens: (first.usage?.inputTokens ?? 0) + (second.usage?.inputTokens ?? 0),
      outputTokens: (first.usage?.outputTokens ?? 0) + (second.usage?.outputTokens ?? 0),
      cached: (first.usage?.cachedInputTokens ?? 0) + (second.usage?.cachedInputTokens ?? 0),
    };
    // m1: 150 prompt (100 + 50 cached) + 20 out; m2: 200 prompt + 5 out.
    expect(total).toEqual({ inputTokens: 350, outputTokens: 25, cached: 50 });
    // total_cost_usd is never surfaced as a billed amount.
    expect(JSON.stringify([first, second])).not.toContain("1.23");
  });

  it("resumes the Claude session for the next operator message, sending only the new text", async () => {
    scriptClaude(answer("sess-a", "first answer"), answer("sess-a", "second answer"));
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("first")];
    const r1 = await rt.executeNative("sys", messages, [httpTool]);
    messages.push({ role: "assistant", content: r1.content }, user("second"));
    const contexts = spawnMock.mock.calls;
    await rt.executeNative("sys", messages, [httpTool]);
    const args1 = contexts[0]![1] as string[];
    const args2 = contexts[1]![1] as string[];
    expect(args1).toContain("--system-prompt-file");
    expect(args1).not.toContain("--resume");
    expect(argValue(args2, "--resume")).toBe("sess-a");
    expect(args2).not.toContain("--system-prompt-file");
  });

  it("starts a new session seeded with 0's transcript after compaction rewrites history", async () => {
    const contexts = scriptClaude(answer("sess-a", "first answer"), answer("sess-b", "after compaction"));
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("first")];
    const r1 = await rt.executeNative("sys", messages, [httpTool]);
    messages.push({ role: "assistant", content: r1.content }, user("second"));
    // Compaction replaces the history in place.
    messages.splice(0, 2, user("[summary] the operator asked about x; it was answered"));
    await rt.executeNative("sys", messages, [httpTool]);
    const args2 = spawnMock.mock.calls[1]![1] as string[];
    expect(args2).not.toContain("--resume");
    expect(args2).toContain("--system-prompt-file");
    const prompt = await contexts[1]!.prompt;
    expect(prompt).toContain("[summary] the operator asked about x");
    expect(prompt.trim().endsWith("second")).toBe(true);
  });

  it("starts a new session when the system prompt changes between turns", async () => {
    scriptClaude(answer("sess-a", "one"), answer("sess-b", "two"));
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("first")];
    const r1 = await rt.executeNative("standard mode", messages, [httpTool]);
    messages.push({ role: "assistant", content: r1.content }, user("second"));
    await rt.executeNative("recon mode", messages, [httpTool]);
    const args2 = spawnMock.mock.calls[1]![1] as string[];
    expect(args2).not.toContain("--resume");
    const systemFile = argValue(args2, "--system-prompt-file");
    expect(systemFile).toBeDefined();
  });

  it("re-seeds a session that was compacted mid-turn, after finishing the turn on the live process", async () => {
    scriptClaude(async (c) => {
      c.emit(ev.init("sess-a"));
      await c.callTool("http_request", { url: "u" });
      c.emit(ev.assistant("m2", [{ type: "text", text: "done" }]));
      c.emit(ev.result("sess-a"));
      c.exit(0);
    }, answer("sess-b", "next"));
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("older"), { role: "assistant", content: [{ type: "text", text: "old" }] }, user("go")];
    const first = await rt.executeNative("sys", messages, [httpTool]);
    const id = (first.content.find((b) => b.type === "tool_use") as { id: string }).id;
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] });
    messages.splice(0, 2, user("[summary] older exchange"));
    const second = await rt.executeNative("sys", messages, [httpTool]);
    expect(second.stopReason).toBe("end_turn");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    messages.push({ role: "assistant", content: second.content }, user("next"));
    await rt.executeNative("sys", messages, [httpTool]);
    expect(spawnMock.mock.calls[1]![1]).not.toContain("--resume");
  });

  it("runs tool-less side requests (summaries) as one-shot sessions without disturbing a parked run", async () => {
    let toolAnswer: { text: string; isError: boolean } | undefined;
    const contexts = scriptClaude(async (c) => {
      c.emit(ev.init("main"));
      toolAnswer = await c.callTool("http_request", { url: "u" });
      c.emit(ev.assistant("m2", [{ type: "text", text: "main done" }]));
      c.emit(ev.result("main"));
      c.exit(0);
    }, answer("side", "a summary of the conversation"));
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("go")];
    const first = await rt.executeNative("sys", messages, [httpTool]);
    const summary = await rt.executeNative("You are a summarizer.", [user("summarize this")], []);
    expect(summary.content).toEqual([{ type: "text", text: "a summary of the conversation" }]);
    const sideArgs = spawnMock.mock.calls[1]![1] as string[];
    expect(sideArgs).toContain("--no-session-persistence");
    expect(sideArgs).not.toContain("--mcp-config");
    expect(sideArgs).not.toContain("--resume");
    expect(await contexts[1]!.prompt).toBe("summarize this");

    const id = (first.content.find((b) => b.type === "tool_use") as { id: string }).id;
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] });
    const second = await rt.executeNative("sys", messages, [httpTool]);
    expect(second.content).toEqual([{ type: "text", text: "main done" }]);
    expect(toolAnswer?.text).toBe("ok");
  });

  it("abandons a run whose tool calls the caller never answered, then re-seeds", async () => {
    const contexts = scriptClaude(async (c) => {
      c.emit(ev.init("main"));
      await c.callTool("http_request", { url: "u" }).catch(() => undefined);
      await c.killed;
    }, answer("fresh", "ok"));
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("go")];
    const first = await rt.executeNative("sys", messages, [httpTool]);
    expect(first.stopReason).toBe("tool_use");
    // The turn was cancelled; the engine closed the call and the operator moved on.
    const id = (first.content.find((b) => b.type === "tool_use") as { id: string }).id;
    messages.push(
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "cancelled", is_error: true }] },
      user("try something else"),
    );
    const next = await rt.executeNative("sys", messages, [httpTool]);
    // The parked process is killed rather than left blocked on the bridge.
    await contexts[0]!.killed;
    expect(next.content).toEqual([{ type: "text", text: "ok" }]);
    const args = spawnMock.mock.calls[1]![1] as string[];
    expect(args).not.toContain("--resume");
    expect(await contexts[1]!.prompt).toContain("try something else");
  });

  it("falls back to a seeded session when resuming a stale session fails", async () => {
    scriptClaude(
      answer("stale", "first"),
      async (c) => { c.stderr("No conversation found with session ID: stale"); c.exit(1); },
      answer("fresh", "recovered"),
    );
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const messages: NativeMessage[] = [user("first")];
    const r1 = await rt.executeNative("sys", messages, [httpTool]);
    messages.push({ role: "assistant", content: r1.content }, user("second"));
    const r2 = await rt.executeNative("sys", messages, [httpTool]);
    expect(r2.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(argValue(spawnMock.mock.calls[1]![1] as string[], "--resume")).toBe("stale");
    expect(spawnMock.mock.calls[2]![1]).not.toContain("--resume");
  });

  it("surfaces a login hint when the CLI is not authenticated", async () => {
    scriptClaude(async (c) => { c.stderr("Error: Please run /login\n"); c.exit(1); });
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const result = await rt.executeNative("sys", [user("hi")], [httpTool]);
    expect(result.stopReason).toBe("error");
    expect(result.error).toMatch(/claude login/i);
  });

  it("reports operator cancellation structurally and kills the process", async () => {
    const contexts = scriptClaude(async (c) => { c.emit(ev.init("s")); await c.killed; });
    const rt = new CliNativeRuntime({ type: "claude", timeout: 10_000 }, runtimeOptions);
    const controller = new AbortController();
    const pending = rt.executeNative("sys", [user("hi")], [httpTool], undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    await contexts[0]!.killed;
    expect(result.cancelled).toBe(true);
  });

  it("reports the CLI as unavailable when the binary cannot be resolved", async () => {
    const rt = new CliNativeRuntime({ type: "claude", timeout: 1000 }, { resolveCommand: () => undefined });
    expect(await rt.isAvailable()).toBe(false);
    const result = await rt.executeNative("sys", [user("hi")], [httpTool]);
    expect(result.error).toMatch(/not found on PATH/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("detects availability through `claude --version`", async () => {
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => makeFakeClaude(args, async (c) => c.exit(0)));
    const rt = new CliNativeRuntime({ type: "claude", timeout: 1000 }, runtimeOptions);
    expect(await rt.isAvailable()).toBe(true);
    expect(spawnMock.mock.calls[0]![1]).toEqual(["--version"]);
  });
});

describe("ClaudeSubscriptionRuntime", () => {
  it("is built by createConsoleRuntime for the claude-code provider without an API key", () => {
    const runtime = createConsoleRuntime({ provider: CLAUDE_CODE_PROVIDER_ID, env: { ANTHROPIC_API_KEY: "" } });
    expect(runtime).toBeInstanceOf(ClaudeSubscriptionRuntime);
    expect(runtime.resolvedProvider()).toBe("claude-code");
  });

  it("strips API keys from the child environment so the subscription is used", async () => {
    scriptClaude(answer("s", "ok"));
    const rt = new ClaudeSubscriptionRuntime({ model: "sonnet", env: { ANTHROPIC_API_KEY: "sk-ant-test" } }, runtimeOptions);
    await rt.executeNative("sys", [user("hi")], [httpTool]);
    const options = spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(options.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(options.env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"]).toBe("1");
    expect(argValue(spawnMock.mock.calls[0]![1] as string[], "--model")).toBe("sonnet");
  });

  it("omits --model for the CLI default and never prices usage at API rates", () => {
    const rt = new ClaudeSubscriptionRuntime({ model: "cli-default" }, runtimeOptions);
    expect(rt.resolvedModel()).toBe("cli-default");
    expect(rt.resolvedPricingModel()).toBe("claude-code/cli-default");
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, rt.resolvedPricingModel())).toBe(0);
    expect(rt.connectionIdentity()).toMatch(/^[a-f0-9]{64}$/);
    rt.reconfigure({ model: "opus" });
    expect(rt.resolvedModel()).toBe("opus");
    expect(() => rt.reconfigure({ provider: "anthropic" })).toThrow(/new console session/);
  });
});

// ── Console turn engine integration: the four autonomy modes ────────────────

describe("console turn engine on the Claude subscription runtime", () => {
  /** Claude calls `bash` once via MCP (and echoes the tool_use on stdout). */
  function bashOnce(command: string, seen: Array<{ text: string; isError: boolean }>): FakeClaudeScript {
    return async (c) => {
      c.emit(ev.init("s"));
      c.emit(ev.assistant("m1", [{ type: "tool_use", id: "toolu_echo", name: "mcp__zero__bash", input: { command } }]));
      seen.push(await c.callTool("bash", { command }));
      c.emit(ev.assistant("m2", [{ type: "text", text: "finished" }]));
      c.emit(ev.result("s"));
      c.exit(0);
    };
  }

  async function runMode(mode: ConsoleAutonomyMode, approve?: boolean) {
    const seen: Array<{ text: string; isError: boolean }> = [];
    scriptClaude(bashOnce("echo zero-bridge-ok", seen));
    const approvals: string[] = [];
    const runtime = new ClaudeSubscriptionRuntime({ timeout: 30_000 }, runtimeOptions);
    const session = createConsoleSession({
      runtime, autonomyMode: mode, allowModelSelfExtension: false, refineObjective: false,
      ...(approve === undefined ? {} : { approveTool: async (call) => { approvals.push(call.name); return approve; } }),
    });
    const deltas: string[] = [];
    const outcome = await session.send("run the check", { onAssistantDelta: (text) => deltas.push(text) });
    return { outcome, seen, approvals, deltas };
  }

  it("standard: an operator denial blocks the tool and Claude receives the refusal", async () => {
    const { outcome, seen, approvals } = await runMode("standard", false);
    expect(approvals).toEqual(["bash"]);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]!.result.error).toContain("not approved");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.isError).toBe(true);
    expect(seen[0]!.text).toContain("not approved");
    expect(outcome.stopReason).toBe("end_turn");
  });

  it("recon: a mutating tool is refused without prompting", async () => {
    const { outcome, seen, approvals } = await runMode("recon", true);
    expect(approvals).toEqual([]);
    expect(outcome.toolCalls[0]!.result.error).toContain("Recon mode");
    expect(seen[0]!.isError).toBe(true);
  });

  it.each(["yolo", "copilot"] as const)("%s: the tool runs once, through 0's executor", async (mode) => {
    const { outcome, seen, approvals, deltas } = await runMode(mode, false);
    expect(approvals).toEqual([]);
    // The echoed stdout tool_use was not dispatched a second time.
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]!.call.name).toBe("bash");
    const result = outcome.toolCalls[0]!.result;
    // No gate refused it: the call reached 0's executor and its result was
    // relayed back to Claude.
    expect(result.error ?? "").not.toMatch(/not approved|Recon mode|not permitted/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.isError).toBe(!result.success);
    // The console's bash tool needs /bin/bash, which Windows hosts lack.
    if (process.platform !== "win32") {
      expect(result.success).toBe(true);
      expect(seen[0]!.text).toContain("zero-bridge-ok");
    }
    expect(outcome.assistantText).toBe("finished");
    expect(deltas.join("")).toBe("finished");
  });
});
