import { createHash } from "node:crypto";
import { CliNativeRuntime, type CliNativeRuntimeOptions } from "./cli-native.js";
import type { CodexCatalogModel } from "./codex-models.js";
import type { NativeRuntime, RuntimeConfig, SubagentModelSelection } from "./types.js";

/**
 * Provider id for Claude through the operator's own Claude subscription: the
 * console drives the locally installed and logged-in `claude` CLI. No
 * credentials are stored or read by 0 — authentication lives in the CLI.
 */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_PROVIDER_LABEL = "Claude (subscription)";
/**
 * Model id meaning "whatever the CLI is configured to use" (no `--model`).
 * Deliberately not `default`, which the pricing table reserves for its
 * fallback API rate.
 */
export const CLAUDE_CODE_DEFAULT_MODEL = "cli-default";
/** Model aliases `claude --model` accepts; the CLI resolves them to the latest release. */
export const CLAUDE_CODE_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: CLAUDE_CODE_DEFAULT_MODEL, label: "Claude Code default" },
  { id: "opus", label: "Opus (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
];

export interface ClaudeSubscriptionDiagnostics {
  valid: boolean;
  provider: typeof CLAUDE_CODE_PROVIDER_ID;
  providerLabel: string;
  reason?: "missing_cli";
  fatalError?: string;
}

/** True when `provider` selects the Claude subscription runtime. */
export function isClaudeSubscriptionProvider(provider: string | undefined | null): boolean {
  return provider === CLAUDE_CODE_PROVIDER_ID;
}

/**
 * {@link CliNativeRuntime} for the interactive console, with the read-only
 * connection surface the console, TUI and web layers query on a runtime
 * (diagnostics, identity, model selection). Tool execution, approvals and
 * context control are inherited — see the design notes in cli-native.ts.
 */
export class ClaudeSubscriptionRuntime extends CliNativeRuntime {
  constructor(config: Partial<RuntimeConfig> = {}, options: CliNativeRuntimeOptions = {}) {
    const model = config.model && config.model !== CLAUDE_CODE_DEFAULT_MODEL ? config.model : undefined;
    super({ ...config, type: "claude", timeout: config.timeout ?? 600_000, model, provider: undefined }, options);
  }

  protected override createFork(config: RuntimeConfig): NativeRuntime {
    return new ClaudeSubscriptionRuntime(config, this.options);
  }

  override async forkForSubagent(timeoutMs: number, selection?: SubagentModelSelection): Promise<ClaudeSubscriptionRuntime> {
    return (await super.forkForSubagent(timeoutMs, selection)) as ClaudeSubscriptionRuntime;
  }

  protected override childEnv(): NodeJS.ProcessEnv {
    const env = super.childEnv();
    // The operator chose the subscription: an API key in the environment
    // would silently switch Claude Code to metered API billing.
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    return env;
  }

  getConfigurationDiagnostics(): ClaudeSubscriptionDiagnostics {
    const base = { provider: CLAUDE_CODE_PROVIDER_ID, providerLabel: CLAUDE_CODE_PROVIDER_LABEL } as const;
    if (this.resolveCommand()) return { valid: true, ...base };
    return {
      valid: false, ...base, reason: "missing_cli",
      fatalError: "Claude (subscription) needs the Claude Code CLI on PATH. Install Claude Code and run `claude login`.",
    };
  }

  /**
   * Stable opaque digest (the settings store requires one): the CLI owns the
   * account and 0 never sees it, so every local-CLI connection is the same.
   */
  connectionIdentity(): string {
    return createHash("sha256").update(`${CLAUDE_CODE_PROVIDER_ID}:local-cli`).digest("hex");
  }

  resolvedProvider(): string {
    return CLAUDE_CODE_PROVIDER_ID;
  }

  override resolvedModel(): string {
    return this.config.model ?? CLAUDE_CODE_DEFAULT_MODEL;
  }

  /**
   * Subscription usage is not billed per token. A provider-qualified key with
   * no catalog rate makes every estimate render as unknown instead of an
   * API-rate dollar figure.
   */
  resolvedPricingModel(): string {
    return `${CLAUDE_CODE_PROVIDER_ID}/${this.resolvedModel()}`;
  }

  accessibleModels(): string[] {
    return CLAUDE_CODE_MODELS.map((model) => model.id);
  }

  modelSelection(): { agentModels: Record<string, string>; singleModel: boolean; autoRoute: boolean } {
    return { agentModels: { ...this.config.agentModels }, singleModel: this.config.singleModel === true, autoRoute: this.config.autoRoute === true };
  }

  reconfigure(sel: {
    model?: string;
    provider?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
    autoRoute?: boolean;
    env?: NodeJS.ProcessEnv;
  }): void {
    if (sel.provider !== undefined && sel.provider !== CLAUDE_CODE_PROVIDER_ID) {
      throw new Error("Switching between Claude (subscription) and an API provider needs a new console session.");
    }
    // `--model` applies per invocation, so the Claude session survives a switch.
    if (sel.model !== undefined) this.config = { ...this.config, model: sel.model === CLAUDE_CODE_DEFAULT_MODEL ? undefined : sel.model };
    if (sel.agentModels !== undefined) this.config = { ...this.config, agentModels: { ...sel.agentModels } };
    if (sel.singleModel !== undefined) this.config = { ...this.config, singleModel: sel.singleModel };
    if (sel.autoRoute !== undefined) this.config = { ...this.config, autoRoute: sel.autoRoute };
    if (sel.env !== undefined) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(sel.env)) if (typeof value === "string") env[key] = value;
      this.config = { ...this.config, env };
    }
  }

  /** The CLI resolves aliases itself; there is no account catalog to fetch. */
  async codexModelCatalog(_signal?: AbortSignal): Promise<CodexCatalogModel[]> {
    return CLAUDE_CODE_MODELS.map((model) => ({ id: model.id }) as CodexCatalogModel);
  }

  reasoningConfiguration(): { effort: string; options: string[] } | null {
    return null;
  }

  setReasoningEffort(_effort: string): void {
    throw new Error("This reasoning effort is not supported by the selected model and connection.");
  }
}
