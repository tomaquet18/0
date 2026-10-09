import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  NativeRuntime,
  NativeMessage,
  NativeContentBlock,
  NativeToolDef,
  NativeRuntimeResult,
  NativeStreamCallbacks,
  RuntimeConfig,
  RuntimeType,
} from "./types.js";
import type { SubagentModelSelection } from "./types.js";
import { readCacheUsage } from "./prompt-cache.js";
import { resolveCliCommand, type ResolvedCliCommand } from "./cli-command.js";
import { CLAUDE_TOOL_BRIDGE_SERVER, ClaudeToolBridge, type BridgedToolCall } from "./claude-tool-bridge.js";

/**
 * CliNativeRuntime — wraps a CLI runtime (`claude`, `codex`, `gemini`) so
 * that it satisfies the {@link NativeRuntime} contract used by the native
 * agent loop and the console turn engine.
 *
 * The motivation is subscription auth: users who pay for Claude Pro / Max
 * already have working CLI auth on their machine, while the API runtimes
 * need a raw API key. Only `claude` is supported for multi-turn work; Codex
 * and Gemini fall through with a clear error.
 *
 * ## Tool routing: 0 executes every tool, Claude executes none
 *
 * Claude Code is spawned with ALL built-in tools disabled (`--tools ""`),
 * `--strict-mcp-config` (no user/project MCP servers), no user/project
 * settings (`--setting-sources ""`: no hooks or plugins), no CLAUDE.md
 * memory files, and a single MCP
 * server: a {@link ClaudeToolBridge} that this process serves on 127.0.0.1
 * (ephemeral port, per-run bearer token). The bridge lists exactly the
 * `tools` passed to `executeNative` and pre-allows them
 * (`--allowedTools mcp__zero`, `--permission-mode dontAsk`), so Claude never
 * prompts — approval is 0's job.
 *
 * The bridge does NOT execute anything. When Claude calls a tool, the MCP
 * request is parked and `executeNative` returns it to the caller as an
 * ordinary `tool_use` block (stopReason `tool_use`) while the `claude`
 * process stays alive, blocked on that MCP response. The caller (turn engine
 * or native loop) runs the call through its usual gates — standard-mode
 * approval, recon read-only policy, scope/credential controls, budgets, UI
 * events — and calls `executeNative` again with the `tool_result`. That
 * continuation call answers the parked MCP request and resumes reading the
 * same process. So:
 *   - every tool call is executed exactly once, by 0, through the same path
 *     an API runtime's `tool_use` takes;
 *   - `tool_use` blocks echoed on Claude's stdout are ignored (the bridge is
 *     the only source), so nothing can be double-dispatched;
 *   - a tool_result is delivered to a parked call at most once.
 *
 * ## Session / context control: 0 stays authoritative
 *
 * A clean turn ends with a `result` event; the Claude session id is kept and
 * the next operator message is sent with `--resume`. The session is dropped
 * and a NEW one is seeded with 0's current transcript (rendered into the
 * prompt, system prompt re-sent via `--system-prompt-file`) whenever 0's
 * history no longer matches what Claude saw: compaction rewrote it, the
 * system prompt changed, a turn was abandoned mid-tool-call, or a run failed.
 * Side requests that carry no tools (compaction summaries, objective
 * refinement) run as one-shot, non-persisted sessions and never disturb the
 * main conversation.
 *
 * Prompts and system prompts travel via stdin / a 0600 temp file, never
 * argv, so they neither hit the Windows command-line limit nor a shell.
 */
export interface CliNativeRuntimeOptions {
  /** Batch window for concurrent tool calls before handing them to the caller. */
  toolBatchWindowMs?: number;
  /** Kill a run that waits longer than this for the caller's tool results. */
  idleTimeoutMs?: number;
  /** Injectable command resolution (tests). */
  resolveCommand?: (name: string) => ResolvedCliCommand | undefined;
}

interface LaneState {
  systemHash: string;
  syncedLen: number;
  syncedHash: string;
  clean: boolean;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type Usage = NonNullable<NativeRuntimeResult["usage"]>;

interface Waiter {
  onToolCalls(): void;
  onExit(): void;
}

class ClaudeRun {
  proc!: ChildProcess;
  bridge?: ClaudeToolBridge;
  tmpDir?: string;
  callbacks?: NativeStreamCallbacks;
  waiter?: Waiter;
  stdoutBuf = "";
  stderrBuf = "";
  /** Text blocks of the current round (since the last return to the caller). */
  roundContent: NativeContentBlock[] = [];
  /** Tool calls Claude made that the caller has not seen yet. */
  queue: BridgedToolCall[] = [];
  /** Tool calls handed to the caller and awaiting its tool_result. */
  surfaced = new Set<string>();
  exited = false;
  exitCode: number | null = null;
  spawnError?: string;
  sawResult = false;
  resultError?: string;
  stopReason: NativeRuntimeResult["stopReason"] = "end_turn";
  sessionId?: string;
  historyRewritten = false;
  lastLen = 0;
  lastHash = "";
  rawUsage = new Map<string, RawUsage>();
  reported = new Map<string, Usage>();
  resultUsage?: RawUsage;
  currentMessageId?: string;
  deltaMessages = new Set<string>();
  idleTimer?: NodeJS.Timeout;
  exitHook?: () => void;
  constructor(readonly kind: "main" | "ephemeral", readonly systemHash: string, readonly resumed: boolean) {}
}

export class CliNativeRuntime implements NativeRuntime {
  readonly type: RuntimeType;
  protected config: RuntimeConfig;
  protected readonly options: CliNativeRuntimeOptions;
  private command: string;
  /** Claude Code session id of the main conversation lane. */
  private sessionId: string | undefined;
  private lane: LaneState | undefined;
  private live: ClaudeRun | undefined;
  private observedModel: string | undefined;

  constructor(config: RuntimeConfig, options: CliNativeRuntimeOptions = {}) {
    if (config.type === "api") {
      throw new Error(
        "CliNativeRuntime does not support type=api. Use LlmApiRuntime instead.",
      );
    }
    this.type = config.type;
    this.config = config;
    this.options = options;
    this.command = config.type;
  }

  /**
   * Drop the Claude session (and any run parked on tool calls) so the next
   * call starts a brand-new session seeded with the caller's transcript.
   */
  resetSession(): void {
    this.abandonLive("The 0 session was reset before this tool call completed.");
    this.sessionId = undefined;
    this.lane = undefined;
  }

  /** Kill any live `claude` process. Safe to call more than once. */
  dispose(): void {
    this.abandonLive("The 0 session ended before this tool call completed.");
  }

  resolvedModel(): string { return this.observedModel ?? this.config.model ?? "unknown"; }

  async forkForSubagent(timeout: number, selection?: SubagentModelSelection): Promise<NativeRuntime> {
    const pin = selection?.role && Object.hasOwn(this.config.agentModels ?? {}, selection.role) ? this.config.agentModels?.[selection.role] : undefined;
    const parentModel = this.observedModel ?? this.config.model;
    const model = this.config.singleModel ? parentModel : selection?.model ?? (pin && pin !== "auto" ? pin : parentModel);
    if (model !== parentModel && !Object.values(this.config.agentModels ?? {}).some(approved => approved !== "auto" && approved === model)) {
      throw new Error(`Model '${model}' was not approved for this CLI runtime.`);
    }
    return this.createFork({ ...this.config, timeout, model });
  }

  /** Subclasses return their own type so forks keep their console surface. */
  protected createFork(config: RuntimeConfig): NativeRuntime {
    return new CliNativeRuntime(config, this.options);
  }

  /** Environment for the child process. */
  protected childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.config.env };
    // Parked tool calls may wait on operator approval or long scans; Claude
    // Code must not time the MCP request out underneath the engine.
    env["MCP_TOOL_TIMEOUT"] ??= String(24 * 60 * 60 * 1000);
    // 0 owns the agent's instructions; the operator's personal CLAUDE.md
    // files must not leak into its context.
    env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] = "1";
    return env;
  }

  protected resolveCommand(): ResolvedCliCommand | undefined {
    return (this.options.resolveCommand ?? ((name: string) => resolveCliCommand(name, { env: { ...process.env, ...this.config.env } })))(this.command);
  }

  async isAvailable(): Promise<boolean> {
    const resolved = this.resolveCommand();
    if (!resolved) return false;
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try {
        proc = spawn(resolved.command, [...resolved.prefixArgs, "--version"], {
          cwd: this.config.cwd ?? process.cwd(),
          env: this.childEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 5_000);
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  async executeNative(
    system: string,
    messages: NativeMessage[],
    tools: NativeToolDef[],
    callbacks?: NativeStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<NativeRuntimeResult> {
    const start = Date.now();
    if (signal?.aborted) return { content: [], stopReason: "error", durationMs: 0, cancelled: true, error: "CLI execution cancelled." };

    if (this.type !== "claude") {
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        durationMs: Date.now() - start,
        error:
          `Native multi-turn agent loop is only supported for the 'claude' CLI runtime. ` +
          `'${this.type}' does not yet expose a stable session-resume protocol — ` +
          `use --runtime claude (with 'claude login') for subscription auth, ` +
          `or set ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY for --runtime api.`,
      };
    }

    const systemHash = hashText(system);

    // ── Continuation: deliver tool results to the parked run ──
    const live = this.live;
    if (live) {
      if (live.exited) {
        // The process died while 0 was running its tools; its session ends
        // mid-tool-call, so the next run must be re-seeded.
        this.live = undefined;
        this.dropLane();
      } else {
        const results = toolResultsFor(messages, live.surfaced);
        if (results) {
          clearTimeout(live.idleTimer);
          if (systemHash !== live.systemHash || hashMessages(messages.slice(0, live.lastLen)) !== live.lastHash) {
            // History or system prompt was rewritten (e.g. compaction) — finish
            // this turn on the live process but re-seed the next one.
            live.historyRewritten = true;
          }
          live.lastLen = messages.length;
          live.lastHash = hashMessages(messages);
          for (const [id, block] of results) {
            live.surfaced.delete(id);
            live.bridge?.resolve(id, { content: block.content, isError: block.is_error });
          }
          return this.drive(live, callbacks, signal, start);
        }
        if (tools.length === 0) return this.runEphemeral(system, messages, callbacks, signal, start);
        this.abandonLive("The 0 turn ended before this tool call completed.");
      }
    }

    if (tools.length === 0) return this.runEphemeral(system, messages, callbacks, signal, start);

    // ── New main-lane run: resume the Claude session or seed a fresh one ──
    const resumePrompt = this.resumePrompt(systemHash, messages);
    if (resumePrompt !== undefined && this.sessionId) {
      const result = await this.startRun("main", { system, systemHash, messages, tools, prompt: resumePrompt, resume: this.sessionId }, callbacks, signal, start);
      // A stale session (evicted, deleted) fails before producing anything;
      // fall back to a seeded session instead of surfacing the error.
      const staleSession = result.stopReason === "error" && !result.cancelled && !/timed out/.test(result.error ?? "")
        && result.content.every(isEmptyText) && this.sessionId === undefined;
      if (!staleSession) return result;
    }
    this.dropLane();
    return this.startRun("main", { system, systemHash, messages, tools, prompt: renderClaudeSeedPrompt(messages) }, callbacks, signal, start);
  }

  private resumePrompt(systemHash: string, messages: NativeMessage[]): string | undefined {
    const lane = this.lane;
    if (!lane || !lane.clean || lane.systemHash !== systemHash) return undefined;
    if (messages.length <= lane.syncedLen + 1) return undefined;
    if (hashMessages(messages.slice(0, lane.syncedLen)) !== lane.syncedHash) return undefined;
    if (messages[lane.syncedLen]?.role !== "assistant") return undefined;
    const texts: string[] = [];
    for (const message of messages.slice(lane.syncedLen + 1)) {
      if (message.role !== "user" || message.content.some((block) => block.type !== "text")) return undefined;
      texts.push(...message.content.map((block) => (block as { text: string }).text));
    }
    const prompt = texts.join("\n\n").trim();
    return prompt || undefined;
  }

  private dropLane(): void {
    this.lane = undefined;
    this.sessionId = undefined;
  }

  private abandonLive(reason: string): void {
    const live = this.live;
    if (!live) return;
    this.live = undefined;
    this.dropLane();
    live.bridge?.rejectAll(reason);
    terminateProcess(live.proc);
    this.cleanupRun(live);
  }

  private runEphemeral(
    system: string,
    messages: NativeMessage[],
    callbacks: NativeStreamCallbacks | undefined,
    signal: AbortSignal | undefined,
    start: number,
  ): Promise<NativeRuntimeResult> {
    return this.startRun("ephemeral", { system, systemHash: hashText(system), messages, tools: [], prompt: renderClaudeSeedPrompt(messages) }, callbacks, signal, start);
  }

  private async startRun(
    kind: "main" | "ephemeral",
    req: { system: string; systemHash: string; messages: NativeMessage[]; tools: NativeToolDef[]; prompt: string; resume?: string },
    callbacks: NativeStreamCallbacks | undefined,
    signal: AbortSignal | undefined,
    start: number,
  ): Promise<NativeRuntimeResult> {
    if (!req.prompt.trim()) {
      return { content: [{ type: "text", text: "" }], stopReason: "error", durationMs: Date.now() - start, error: "CliNativeRuntime: no user turn to send to Claude Code." };
    }
    const resolved = this.resolveCommand();
    if (!resolved) {
      if (kind === "main") this.dropLane();
      return {
        content: [{ type: "text", text: "" }], stopReason: "error", durationMs: Date.now() - start,
        error: "claude CLI not found on PATH. Install Claude Code and run `claude login`.",
      };
    }

    const run = new ClaudeRun(kind, req.systemHash, req.resume !== undefined);
    run.lastLen = req.messages.length;
    run.lastHash = hashMessages(req.messages);
    let args: string[];
    try {
      run.tmpDir = mkdtempSync(join(tmpdir(), "zero-claude-"));
      let mcpConfigPath: string | undefined;
      if (req.tools.length > 0) {
        run.bridge = new ClaudeToolBridge(req.tools, (call) => this.onBridgedCall(run, call));
        await run.bridge.start();
        mcpConfigPath = join(run.tmpDir, "mcp.json");
        writeFileSync(mcpConfigPath, run.bridge.mcpConfig(), { mode: 0o600 });
      }
      let systemPromptFile: string | undefined;
      if (!req.resume && req.system.trim()) {
        systemPromptFile = join(run.tmpDir, "system-prompt.txt");
        writeFileSync(systemPromptFile, req.system, { mode: 0o600 });
      }
      args = buildClaudeArgs({ model: this.config.model, resume: req.resume, systemPromptFile, mcpConfigPath, ephemeral: kind === "ephemeral" });
    } catch (error) {
      this.cleanupRun(run);
      if (kind === "main") this.dropLane();
      return { content: [{ type: "text", text: "" }], stopReason: "error", durationMs: Date.now() - start, error: `claude CLI setup failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    try {
      run.proc = spawn(resolved.command, [...resolved.prefixArgs, ...args], {
        cwd: this.config.cwd ?? process.cwd(),
        env: this.childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      this.cleanupRun(run);
      if (kind === "main") this.dropLane();
      return { content: [{ type: "text", text: "" }], stopReason: "error", durationMs: Date.now() - start, error: `claude CLI spawn failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.attach(run);
    run.proc.stdin?.on("error", () => { /* surfaced through the close/error handlers */ });
    run.proc.stdin?.end(req.prompt, "utf-8");
    if (kind === "main") this.live = run;
    return this.drive(run, callbacks, signal, start);
  }

  private onBridgedCall(run: ClaudeRun, call: BridgedToolCall): void {
    run.queue.push(call);
    if (run.waiter) this.scheduleFlush(run);
  }

  private scheduleFlush(run: ClaudeRun): void {
    const waiter = run.waiter;
    if (!waiter) return;
    const window = this.options.toolBatchWindowMs ?? 25;
    setTimeout(() => { if (run.waiter === waiter && run.queue.length > 0) waiter.onToolCalls(); }, window);
  }

  private attach(run: ClaudeRun): void {
    const proc = run.proc;
    proc.stdout?.on("data", (chunk: Buffer) => {
      run.stdoutBuf += chunk.toString("utf-8");
      let nl = run.stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        const line = run.stdoutBuf.slice(0, nl).trim();
        run.stdoutBuf = run.stdoutBuf.slice(nl + 1);
        nl = run.stdoutBuf.indexOf("\n");
        if (!line) continue;
        const event = tryParseJson(line);
        if (event) this.onEvent(run, event);
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (run.stderrBuf.length < 64_000) run.stderrBuf += chunk.toString("utf-8");
    });
    const exit = (code: number | null, spawnError?: string) => {
      if (run.exited) return;
      run.exited = true;
      run.exitCode = code;
      run.spawnError = spawnError;
      clearTimeout(run.idleTimer);
      run.bridge?.rejectAll("The claude process exited before this tool call completed.");
      if (run.waiter) run.waiter.onExit();
      else if (this.live === run) {
        // Died while 0 was executing tools; the next call re-seeds.
        this.live = undefined;
        this.dropLane();
        this.cleanupRun(run);
      } else this.cleanupRun(run);
    };
    proc.on("error", (err) => exit(null, err.message));
    proc.on("close", (code) => exit(code));
    run.exitHook = () => terminateProcess(proc);
    process.once("exit", run.exitHook);
  }

  private onEvent(run: ClaudeRun, event: Record<string, any>): void {
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      run.sessionId = event.session_id;
      if (run.kind === "main") this.sessionId = event.session_id;
      return;
    }

    if (event.type === "stream_event" && event.event && typeof event.event === "object") {
      const inner = event.event as Record<string, any>;
      if (inner.type === "message_start" && inner.message) {
        if (typeof inner.message.id === "string") {
          run.currentMessageId = inner.message.id;
          mergeRawUsage(run, inner.message.id, inner.message.usage);
        }
        if (typeof inner.message.model === "string") this.observedModel = inner.message.model;
      } else if (inner.type === "message_delta" && run.currentMessageId) {
        mergeRawUsage(run, run.currentMessageId, inner.usage);
      } else if (inner.type === "content_block_delta" && inner.delta) {
        if (inner.delta.type === "text_delta" && typeof inner.delta.text === "string" && inner.delta.text) {
          if (run.currentMessageId) run.deltaMessages.add(run.currentMessageId);
          run.callbacks?.onDelta?.("assistant_response", inner.delta.text);
        } else if (inner.delta.type === "thinking_delta" && typeof inner.delta.thinking === "string" && inner.delta.thinking) {
          run.callbacks?.onDelta?.("reasoning", inner.delta.thinking);
        }
      }
      return;
    }

    if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
      const messageId = typeof event.message.id === "string" ? event.message.id : undefined;
      if (typeof event.message.model === "string") this.observedModel = event.message.model;
      if (messageId) mergeRawUsage(run, messageId, event.message.usage);
      for (const block of event.message.content) {
        // Only text is taken from the stream. Tool calls reach 0 exclusively
        // through the MCP bridge; a `tool_use` echoed here is Claude's record
        // of a call that is already parked on the bridge (or that Claude
        // could not run because its built-ins are disabled), so it is never
        // re-dispatched.
        if (block?.type === "text" && typeof block.text === "string" && block.text) {
          run.roundContent.push({ type: "text", text: block.text });
          // Without partial messages the text never streamed; emit it whole.
          if (!messageId || !run.deltaMessages.has(messageId)) run.callbacks?.onDelta?.("assistant_response", block.text);
          if (block.text.trim()) run.callbacks?.onThinking?.(block.text);
        }
      }
      return;
    }

    if (event.type === "result") {
      run.sawResult = true;
      if (typeof event.session_id === "string") run.sessionId = event.session_id;
      if (event.usage && typeof event.usage === "object") run.resultUsage = event.usage as RawUsage;
      if (event.is_error === true || (typeof event.subtype === "string" && event.subtype.startsWith("error"))) {
        run.stopReason = "error";
        run.resultError = typeof event.result === "string" && event.result.trim()
          ? event.result.trim().slice(0, 500)
          : `Claude Code reported ${event.subtype ?? "an error"}.`;
      } else {
        run.stopReason = mapClaudeStopReason(event.stop_reason ?? event.subtype);
        // Tool calls are mediated by the bridge; a run that ended has no
        // outstanding calls, so it is a completed turn for the caller.
        if (run.stopReason === "tool_use") run.stopReason = "end_turn";
      }
    }
  }

  /** Wait until the run either needs 0 to execute tools or exits. */
  private drive(run: ClaudeRun, callbacks: NativeStreamCallbacks | undefined, signal: AbortSignal | undefined, start: number): Promise<NativeRuntimeResult> {
    return new Promise((resolve) => {
      run.callbacks = callbacks;
      let timedOut = false;
      let settled = false;
      const timeoutMs = this.config.timeout || 600_000;
      const timer = setTimeout(() => {
        timedOut = true;
        run.bridge?.rejectAll("Timed out.");
        terminateProcess(run.proc);
      }, timeoutMs);
      const onAbort = () => {
        run.bridge?.rejectAll("Cancelled by the operator.");
        terminateProcess(run.proc);
      };
      const finish = (result: NativeRuntimeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        run.waiter = undefined;
        run.callbacks = undefined;
        resolve(result);
      };
      run.waiter = {
        onToolCalls: () => {
          const calls = run.queue.splice(0);
          const content: NativeContentBlock[] = [...run.roundContent];
          run.roundContent = [];
          for (const call of calls) {
            run.surfaced.add(call.id);
            content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
          }
          const usage = takeUsageDelta(run);
          if (usage) callbacks?.onUsage?.(usage);
          // Bound the time the process may sit parked waiting for 0.
          run.idleTimer = setTimeout(() => {
            if (this.live === run) this.abandonLive("Timed out waiting for the tool result.");
          }, this.options.idleTimeoutMs ?? 60 * 60 * 1000);
          run.idleTimer.unref?.();
          finish({ content, stopReason: "tool_use", ...(usage ? { usage } : {}), durationMs: Date.now() - start });
        },
        onExit: () => {
          if (this.live === run) this.live = undefined;
          const usage = takeUsageDelta(run);
          if (usage) callbacks?.onUsage?.(usage);
          const content = run.roundContent.length > 0 ? run.roundContent : [{ type: "text" as const, text: "" }];
          this.cleanupRun(run);
          const fail = (error: string, extra: Partial<NativeRuntimeResult> = {}): NativeRuntimeResult => {
            if (run.kind === "main") this.dropLane();
            return { content, stopReason: "error", ...(usage ? { usage } : {}), durationMs: Date.now() - start, error, ...extra };
          };
          if (signal?.aborted) return finish(fail("CLI execution cancelled.", { cancelled: true }));
          if (timedOut) return finish(fail(`claude CLI timed out after ${timeoutMs}ms`));
          if (run.spawnError) return finish(fail(`claude CLI spawn failed: ${run.spawnError}`));
          if (run.stopReason === "error" && run.sawResult) return finish(fail(`claude CLI reported an error: ${run.resultError ?? "unknown error"}`));
          if (!run.sawResult) {
            const hint = extractAuthHint(run.stderrBuf);
            return finish(fail(
              `claude CLI exited ${run.exitCode}` +
              (hint ? ` — ${hint}` : "") +
              (run.stderrBuf.trim() ? `\nstderr: ${run.stderrBuf.trim().slice(0, 500)}` : ""),
            ));
          }
          if (run.kind === "main") {
            this.sessionId = run.sessionId ?? this.sessionId;
            this.lane = this.sessionId
              ? { systemHash: run.systemHash, syncedLen: run.lastLen, syncedHash: run.lastHash, clean: !run.historyRewritten }
              : undefined;
          }
          finish({ content, stopReason: run.stopReason, ...(usage ? { usage } : {}), durationMs: Date.now() - start });
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (run.exited) run.waiter.onExit();
      else if (run.queue.length > 0) this.scheduleFlush(run);
    });
  }

  private cleanupRun(run: ClaudeRun): void {
    clearTimeout(run.idleTimer);
    if (run.exitHook) { process.off("exit", run.exitHook); run.exitHook = undefined; }
    if (run.bridge) { void run.bridge.close(); run.bridge = undefined; }
    if (run.tmpDir) {
      try { rmSync(run.tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      run.tmpDir = undefined;
    }
  }
}

/**
 * Arguments for one `claude -p` run. The prompt is written to stdin.
 * Exported for unit testing.
 */
export function buildClaudeArgs(opts: {
  model?: string;
  resume?: string;
  systemPromptFile?: string;
  mcpConfigPath?: string;
  ephemeral?: boolean;
}): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
    // No built-in tools at all: every tool Claude can call is 0's, via MCP.
    "--tools", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    // Ignore user/project/local settings: their hooks, plugins and env would
    // run or inject context outside 0's control. OAuth login is unaffected.
    "--setting-sources", "",
    // Anything not pre-allowed is denied without prompting.
    "--permission-mode", "dontAsk",
  ];
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath, "--allowedTools", `mcp__${CLAUDE_TOOL_BRIDGE_SERVER}`);
  if (opts.model) args.push("--model", opts.model);
  if (opts.resume) args.push("--resume", opts.resume);
  else if (opts.systemPromptFile) args.push("--system-prompt-file", opts.systemPromptFile);
  if (opts.ephemeral) args.push("--no-session-persistence");
  return args;
}

/**
 * Render 0's conversation into the first prompt of a fresh Claude session:
 * everything before the trailing operator text becomes a transcript, the
 * trailing operator text is the request. Exported for unit testing.
 */
export function renderClaudeSeedPrompt(messages: NativeMessage[]): string {
  let split = messages.length;
  while (split > 0) {
    const message = messages[split - 1]!;
    if (message.role !== "user" || message.content.some((block) => block.type !== "text")) break;
    split--;
  }
  const history = messages.slice(0, split);
  const latest = messages.slice(split)
    .flatMap((message) => message.content.map((block) => (block as { text: string }).text))
    .join("\n\n").trim();
  if (history.length === 0) return latest;

  const lines: string[] = [];
  for (const message of history) {
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.trim()) lines.push(`${message.role === "user" ? "User" : "Assistant"}:\n${block.text}`);
      } else if (block.type === "tool_use") {
        lines.push(`Assistant called tool ${block.name} (id ${block.id}) with input ${JSON.stringify(block.input)}`);
      } else {
        lines.push(`Tool result for ${block.tool_use_id}${block.is_error ? " (error)" : ""}:\n${block.content}`);
      }
    }
  }
  return [
    "<conversation_history>",
    "The conversation so far, as recorded by the host (older parts may be summarized). Tool calls listed here were already executed and their results are included; do not repeat them unless you need new information.",
    "",
    lines.join("\n\n"),
    "</conversation_history>",
    "",
    latest || "Continue the task from the latest tool results above.",
  ].join("\n");
}

/**
 * Map Claude Code's stop-reason vocabulary to the native runtime's
 * normalized set. Exported for unit testing.
 */
export function mapClaudeStopReason(
  raw: string | undefined,
): NativeRuntimeResult["stopReason"] {
  if (!raw) return "end_turn";
  switch (raw) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "success_max_turns":
      return "max_tokens";
    case "end_turn":
    case "success":
    case "stop_sequence":
      return "end_turn";
    case "error":
    case "error_max_turns":
    case "error_during_execution":
      return "error";
    default:
      return "end_turn";
  }
}

/** Tool results in the last user message covering every surfaced call, or undefined. */
function toolResultsFor(messages: NativeMessage[], surfaced: Set<string>): Map<string, Extract<NativeContentBlock, { type: "tool_result" }>> | undefined {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || surfaced.size === 0) return undefined;
  const found = new Map<string, Extract<NativeContentBlock, { type: "tool_result" }>>();
  for (const block of last.content) {
    if (block.type === "tool_result" && surfaced.has(block.tool_use_id)) found.set(block.tool_use_id, block);
  }
  return found.size === surfaced.size ? found : undefined;
}

function mergeRawUsage(run: ClaudeRun, id: string, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const prev = run.rawUsage.get(id) ?? {};
  const next: RawUsage = { ...prev };
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    const value = num(u[key]);
    if (value !== undefined) next[key] = Math.max(prev[key] ?? 0, value);
  }
  run.rawUsage.set(id, next);
}

/**
 * Usage not yet reported to the caller. Claude Code repeats a message's usage
 * on every content-block event and finalizes output tokens late, so usage is
 * tracked per API message and only the growth since the last report is
 * returned — each token is counted exactly once across rounds.
 */
function takeUsageDelta(run: ClaudeRun): Usage | undefined {
  const total: Usage = { inputTokens: 0, outputTokens: 0 };
  let any = false;
  const add = (current: Usage, previous: Usage | undefined) => {
    const d = {
      inputTokens: current.inputTokens - (previous?.inputTokens ?? 0),
      outputTokens: current.outputTokens - (previous?.outputTokens ?? 0),
      cachedInputTokens: (current.cachedInputTokens ?? 0) - (previous?.cachedInputTokens ?? 0),
      cacheWriteTokens: (current.cacheWriteTokens ?? 0) - (previous?.cacheWriteTokens ?? 0),
    };
    if (d.inputTokens || d.outputTokens || d.cachedInputTokens || d.cacheWriteTokens) any = true;
    total.inputTokens += d.inputTokens;
    total.outputTokens += d.outputTokens;
    if (d.cachedInputTokens) total.cachedInputTokens = (total.cachedInputTokens ?? 0) + d.cachedInputTokens;
    if (d.cacheWriteTokens) total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + d.cacheWriteTokens;
  };
  if (run.rawUsage.size > 0) {
    for (const [id, raw] of run.rawUsage) {
      const current = readUsage(raw as Record<string, unknown>);
      if (!current) continue;
      add(current, run.reported.get(id));
      run.reported.set(id, current);
    }
  } else if (run.sawResult && run.resultUsage) {
    // Older CLIs without per-message ids: fall back to the run total.
    const current = readUsage(run.resultUsage as Record<string, unknown>);
    if (current) {
      add(current, run.reported.get("result"));
      run.reported.set("result", current);
    }
  }
  return any ? total : undefined;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashMessages(messages: NativeMessage[]): string {
  return hashText(JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content }))));
}

function isEmptyText(block: NativeContentBlock): boolean {
  return block.type === "text" && !block.text;
}

function terminateProcess(proc: ChildProcess | undefined): void {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const kill = (sig: NodeJS.Signals) => {
    if (proc.pid && process.platform !== "win32") {
      try { process.kill(-proc.pid, sig); return; } catch { /* fall through */ }
    }
    try { proc.kill(sig); } catch { /* already gone */ }
  };
  kill("SIGTERM");
  const timer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) kill("SIGKILL"); }, 1_000);
  timer.unref?.();
}

function tryParseJson(line: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, any>;
    }
  } catch {
    // not all stdout lines are stream-json events (e.g. log lines from
    // npm wrappers); ignore and move on.
  }
  return null;
}

function readUsage(
  u: Record<string, unknown>,
): NativeRuntimeResult["usage"] {
  const input = num(u.input_tokens) ?? num(u.prompt_tokens);
  const output = num(u.output_tokens) ?? num(u.completion_tokens);
  if (input === undefined && output === undefined && num(u.cache_read_input_tokens) === undefined && num(u.cache_creation_input_tokens) === undefined) return undefined;
  if (u.input_tokens !== undefined || u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
    return readCacheUsage({ ...u, input_tokens: input ?? 0, output_tokens: output ?? 0 });
  }
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function extractAuthHint(stderr: string): string | undefined {
  if (!stderr) return undefined;
  if (/please\s+run\s+(?:claude\s+login|\/login)/i.test(stderr)) {
    return "run `claude login` to authenticate the CLI with your subscription";
  }
  if (/not\s+(?:logged|authenticated)|invalid api key/i.test(stderr)) {
    return "Claude Code reports the user is not authenticated — run `claude login`";
  }
  if (/session\s+expired/i.test(stderr)) {
    return "Claude Code session expired — run `claude login` again";
  }
  return undefined;
}
