import { existsSync, readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";

/**
 * A spawnable command line for a CLI runtime binary: `command` is passed to
 * `child_process.spawn` WITHOUT `shell: true`, with `prefixArgs` prepended to
 * the caller's own arguments.
 */
export interface ResolvedCliCommand {
  command: string;
  prefixArgs: string[];
}

export interface CliCommandResolverOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  isFile?: (path: string) => boolean;
  /** Injectable for tests. */
  readText?: (path: string) => string;
}

const WINDOWS_DIRECT_EXTENSIONS = [".exe", ".com"];
const WINDOWS_SHIM_EXTENSIONS = [".cmd", ".bat"];

/**
 * Resolve a CLI binary name (e.g. `claude`) to something `spawn` can run
 * directly, without a shell.
 *
 * POSIX: PATH is searched for the name, so a missing binary is reported up
 * front instead of as a spawn ENOENT.
 *
 * Windows: `spawn` only finds `.exe`/`.com` files on PATH, and running a
 * `.cmd`/`.bat` shim requires `cmd.exe`, which would re-parse every argument
 * (the prompt, the system prompt, JSON configs) through shell metacharacter
 * rules. So PATH is walked here: a native `.exe`/`.com` is used as-is, and an
 * npm-style `.cmd` shim is unwrapped to the JavaScript entry point (or native
 * binary) it forwards to. A shim that cannot be unwrapped is refused rather
 * than executed through a shell — the caller reports the CLI as unavailable.
 *
 * Returns undefined when nothing safe to spawn was found.
 */
export function resolveCliCommand(name: string, opts: CliCommandResolverOptions = {}): ResolvedCliCommand | undefined {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? defaultIsFile;
  const readText = opts.readText ?? ((path: string) => readFileSync(path, "utf-8"));

  if (platform !== "win32") {
    if (name.includes("/")) return isFile(name) ? { command: name, prefixArgs: [] } : undefined;
    for (const dir of (env["PATH"] ?? "").split(":")) {
      if (!dir) continue;
      const full = `${dir.replace(/\/+$/, "")}/${name}`;
      if (isFile(full)) return { command: full, prefixArgs: [] };
    }
    return undefined;
  }

  const candidates = windowsCandidates(name, env, isFile);
  for (const candidate of candidates) {
    const ext = win32.extname(candidate).toLowerCase();
    if (WINDOWS_DIRECT_EXTENSIONS.includes(ext)) return { command: candidate, prefixArgs: [] };
    if (WINDOWS_SHIM_EXTENSIONS.includes(ext)) {
      const unwrapped = unwrapWindowsShim(candidate, env, isFile, readText);
      if (unwrapped) return unwrapped;
    }
  }
  return undefined;
}

function windowsCandidates(name: string, env: NodeJS.ProcessEnv, isFile: (p: string) => boolean): string[] {
  const extensions = [...WINDOWS_DIRECT_EXTENSIONS, ...WINDOWS_SHIM_EXTENSIONS];
  const hasExt = extensions.includes(win32.extname(name).toLowerCase());
  const names = hasExt ? [name] : extensions.map((ext) => name + ext);
  if (win32.isAbsolute(name) || name.includes("\\") || name.includes("/")) {
    return names.filter((n) => isFile(n));
  }
  const pathValue = env["Path"] ?? env["PATH"] ?? env["path"] ?? "";
  const out: string[] = [];
  for (const dir of pathValue.split(";")) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed) continue;
    // PATH order wins over extension order, as in cmd.exe's own lookup.
    for (const candidateName of names) {
      const full = win32.join(trimmed, candidateName);
      if (isFile(full)) out.push(full);
    }
  }
  return out;
}

/**
 * npm / pnpm / yarn `.cmd` shims end with a line like
 *   "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
 * (or `"%~dp0\..."`). Pull the shim-relative target out of it.
 */
function unwrapWindowsShim(
  shimPath: string,
  env: NodeJS.ProcessEnv,
  isFile: (p: string) => boolean,
  readText: (p: string) => string,
): ResolvedCliCommand | undefined {
  let text: string;
  try { text = readText(shimPath); } catch { return undefined; }
  const shimDir = win32.dirname(shimPath);
  const targets = [...text.matchAll(/"%~?dp0%?\\?([^"%]+?\.(?:js|cjs|mjs|exe))"/gi)].map((m) => m[1]!);
  for (const relative of targets) {
    const target = win32.resolve(shimDir, relative);
    if (!isFile(target)) continue;
    if (/\.exe$/i.test(target)) return { command: target, prefixArgs: [] };
    // npm shims prefer a node.exe sitting next to the shim, then PATH.
    const localNode = win32.join(shimDir, "node.exe");
    const node = isFile(localNode) ? localNode : windowsCandidates("node", env, isFile).find((c) => /\.exe$/i.test(c));
    if (!node) return undefined;
    return { command: node, prefixArgs: [target] };
  }
  return undefined;
}

function defaultIsFile(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}
