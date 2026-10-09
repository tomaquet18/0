<p align="center">
  <a href="https://0.security/">
    <img src="assets/readme-cover.png" alt="0security terminal security research workflow" width="100%">
  </a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/0-aperture-white.svg">
    <img src="assets/0-aperture-ink.svg" alt="0security" width="280">
  </picture>
</p>

<p align="center">
  <strong>Open-source security workflows in your browser, terminal, or coding agent.</strong><br/>
  <sub>Backed by Y Combinator · The Swiss Applied AI &amp; Cybersecurity Research Lab</sub><br/>
  <a href="https://0.security/">0.security</a> ·
  <a href="https://docs.0.security/">Documentation</a> ·
  <a href="https://github.com/0sec-labs/foxguard">FoxGuard</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-1A1815?style=flat-square&labelColor=1A1815" alt="License: MIT OR Apache-2.0"></a>
  <a href="https://github.com/0sec-labs/0/releases/latest">Latest release</a>
  <a href="#status-and-safety"><img src="https://img.shields.io/badge/status-research%20preview-FD802E?style=flat-square&labelColor=1A1815" alt="Status: research preview"></a>
</p>

<p align="center">
  <img src="assets/zero-manifesto-movement.webp" alt="Zero manifesto movement" width="100%">
</p>

## About this fork: Claude subscription support

This fork is based on the **v0.23.0** release of
[0sec-labs/0](https://github.com/0sec-labs/0). It adds one feature: the chat
(terminal UI, web console and headless `console --print`) can run on your
**Claude subscription** through the local [Claude Code](https://docs.claude.com/en/docs/claude-code)
CLI (`claude -p`), with no Anthropic API key.

- **New provider, "Claude (subscription)"** (`claude-code`). It is available
  when `claude --version` works and you are signed in to Claude Code. It
  stores no credentials, because authentication stays in the `claude` CLI.
- **All four autonomy modes** (`standard`, `copilot`, `yolo`, `recon`) keep the
  same guarantees as the API path:
  - Claude Code's built-in tools are disabled.
  - 0's own tools are exposed to Claude through a session-scoped MCP bridge on
    `127.0.0.1` with a per-run token.
  - Every tool call goes through 0's approval, recon, scope and budget gates,
    and is never executed twice.
- **Behaves like the API path:**
  - Responses stream token by token.
  - 0 stays in charge of context. Compaction or a system prompt change starts
    a fresh Claude session seeded with 0's transcript.
  - Token usage is recorded. The cost is shown as `$—`, because subscription
    use is not billed per token.
  - On Windows, `claude.cmd` is resolved without going through a shell.
- **Isolation:** your personal Claude Code settings, hooks, plugins and
  `CLAUDE.md` files are not loaded, and `ANTHROPIC_API_KEY` is removed from
  the subprocess.
- `0 protocol-check --runtime claude` works again.

### Using it

**Terminal UI.** Run `0`, then `/model` → **Claude (subscription)**. Pick
`cli-default`, `opus`, `sonnet` or `haiku`. If you switch providers in the
middle of a chat, the new provider applies after `/new`.

**Web console.** Run `0 web`. The provider appears under **Connections** and
**Models**.

**Headless.**

```bash
ZERO_PROVIDER=claude-code ZERO_MODEL=sonnet 0 console --print "Review this repository" --mode standard
```

Each turn sends 0's system prompt and tool list, which is roughly 30–60k input
tokens. That counts against your subscription's usage limits.

### Building the binary from this fork

The `install.sh` below installs the **official** binary, which does not
include this feature. To build a self-contained binary from this fork on Linux
x64, you need Node 24, pnpm 9 and git. Bun 1.3.14 is only needed to compile,
and the result runs without Node or Bun.

```bash
git clone https://github.com/tomaquet18/0 && cd 0
npm install --prefix /tmp/bun-tmp bun@1.3.14
export PATH=/tmp/bun-tmp/node_modules/.bin:$PATH
pnpm install --no-frozen-lockfile
pnpm --filter "@0/cli..." build && pnpm --filter @0/dashboard build
bash scripts/bun-compile.sh "" dist-bin/0
cp ~/.0/bin/0 ~/.0/bin/0.official    # optional backup of an existing install
cp dist-bin/0 ~/.0/bin/0
```

Do not run `0 upgrade` afterwards: it replaces the binary with the official
release.

**Known limitation:** on native Windows, the v0.23.0 console fails to start
with "evolution storage directory must be owner-only", whichever provider you
use. Use WSL instead.

## Get started

Install on Apple Silicon macOS or x64/ARM64 Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0/main/install.sh | bash
export PATH="$HOME/.0/bin:$PATH"
0 web
```

**Browser:** `0 web` · **Terminal:** `0`

Configure a [model provider](https://docs.0.security/api-keys/) before running AI workflows.

## Workflows

Browser, CLI, and MCP share one workflow runner with retained results.

| Work | Built-in templates |
| --- | --- |
| Assess | Repositories, dependencies, APIs, web configuration, scoped penetration tests, package behavior, smart contracts, native code |
| Verify | Findings with replay evidence |
| Fix | Candidates with regression tests |
| Research | Security research, deep source investigation |

Start from 12 templates, customize steps, and run manually or with browser triggers and schedules.
**Template:** starting point · **Workflow:** reusable steps · **Run:** one execution.

```bash
0 workflow list --templates
0 workflow run --template security-research \
  --target /absolute/path/to/repo --workspace /absolute/path/to/repo \
  --format json > run.json
0 runs list
```

[Workflow guide: inputs, limits, and results](https://docs.0.security/workflow/).

<details>
  <summary>Preview the web app</summary>

![Customer API security review in the Zero web app](assets/screenshots/web-chat.jpg)

![Customer API security workflow in the Zero web app](assets/screenshots/web-workflow.jpg)

</details>

## Use 0 from another agent

Use the CLI commands above, or **MCP** to discover templates, create workflows, and manage runs:

```bash
0 mcp-server --workflows --workspace /absolute/path/to/repo
```

Local MCP requires an explicitly selected host-local execution profile.
For a registered remote engine, use `0 mcp-server --workflows --backend production`.
0's model provider is separate from the connecting agent's session.

Browser chat's **Connect an external agent** copies a setup prompt.
See [MCP setup and individual tools](https://docs.0.security/integrations/) or
[local and remote engines](https://docs.0.security/engine-connections/).

## Plugins

Connect GitHub, Elastic, Semgrep, Snyk, Linear, Jira, Cloudflare, Slack, and Teams
through [plugins and MCP](https://docs.0.security/integrations/).

More guides: [installation](https://docs.0.security/getting-started/) ·
[GitHub Actions](https://docs.0.security/ci/github-action/) ·
[plugin development](https://docs.0.security/hackstore/) ·
[troubleshooting](https://docs.0.security/troubleshooting/).

## Development

Install dependencies, run `npm run dev`, and open the printed browser address.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status and safety

**Research preview.** Assess authorized systems and review findings and fixes.
The terminal defaults to YOLO; use `0 console --mode standard` for confirmations.
The optional [scope plugin](https://docs.0.security/scope/) enforces target boundaries.

Report vulnerabilities through [SECURITY.md](SECURITY.md).
Licensed under [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE).

[Public disclosures and upstream fixes](https://0.security/research/#disclosures).
Thanks to [OpenTUI](https://github.com/anomalyco/opentui), [Bun](https://bun.sh/),
[React](https://react.dev/), [Models.dev](https://models.dev/),
[LiteLLM](https://github.com/BerriAI/litellm), and our contributors.
