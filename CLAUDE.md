# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This is a **fork of [opencode](https://github.com/anomalyco/opencode)** (the open-source AI coding agent) being extended into a custom AI coding agent. The base project is a TypeScript/Bun monorepo with a client/server architecture and a SolidJS terminal UI.

> **Important — the fork's work is uncommitted.** The current `dev` branch is at the same commit as `origin/dev`. All custom features (multi-agent orchestration, new tools, context/memory subsystems, new TUI views) live as **uncommitted working-tree changes** (modified + untracked files), not as commits. The many `origin/*` branches are *upstream opencode's* branches, not this fork's. When you `git diff`, you are looking at the fork's actual work. See **Fork additions** below for what has been built.

opencode reads project rules from `AGENTS.md` (native) and falls back to `CLAUDE.md`. This repo already has an `AGENTS.md` at the root with the **code style guide** — read it; this file complements it rather than repeating it.

## Commands

Package manager is **Bun** (`bun@1.3.10`). Build/typecheck orchestration is **Turborepo**.

Run from the **repo root**:
- `bun install` — install workspace deps
- `bun run dev` — run opencode from source (`packages/opencode/src/index.ts`, `--conditions=browser`); this launches the TUI
- `bun run typecheck` — `turbo typecheck` across all packages (each package runs `tsgo --noEmit`, the TypeScript native preview compiler — **not** `tsc`)

Run from **`packages/opencode/`** (the main package):
- `bun run dev` — same as above, scoped
- `bun run build` — `script/build.ts`: generates `src/provider/models-snapshot.ts` from models.dev, bundles SQLite migrations, and produces standalone compiled binaries via `Bun.build({ compile })` for all platforms. Add `--single` to build only the current platform (much faster), `--skip-install` to skip re-installing native deps.
- `bun run typecheck` — `tsgo --noEmit`
- `bun test --timeout 30000` — run the test suite (Bun's built-in test runner)
- `bun run db generate --name <slug>` — generate a Drizzle migration into `migration/<timestamp>_<slug>/`

**Running a single test:** from `packages/opencode/`, `bun test test/path/to/file.test.ts` (a path) or `bun test -t "test name"` (a name filter). **Tests cannot run from the repo root** — there is a guard (`do-not-run-tests-from-root`); always `cd packages/opencode` (or another package) first.

**Formatting:** Prettier with `{ semi: false, printWidth: 120 }`, enforced via a Husky pre-commit hook. Note: the `lint`, `format`, `docs`, `deploy`, `clean`, `random` scripts in `packages/opencode/package.json` are **placeholder/joke scripts (fake)** — do not rely on them. There is no separate ESLint step; style is Prettier + the `AGENTS.md` conventions.

**Windows note (this machine):** Git Bash fails to fork in this environment (`dofork ... Resource temporarily unavailable`). Use the **PowerShell** tool for git and shell commands, not the Bash tool. opencode itself can be pointed at a Git Bash via `OPENCODE_GIT_BASH_PATH`.

## Repository layout

Bun workspace monorepo. Packages under `packages/`:
- **`opencode`** — the core agent, CLI, server, tools, providers, and the TUI. **This is where ~all the fork work is.**
- `sdk/js` (`@opencode-ai/sdk`) — typed client generated from the server's OpenAPI schema; the TUI and CLI talk to the server through it. Regenerate with `./packages/sdk/js/script/build.ts`.
- `plugin` (`@opencode-ai/plugin`) — plugin/custom-tool API surface.
- `app`, `desktop`, `desktop-electron` — web + desktop (Tauri/Electron) clients.
- `web`, `docs` — marketing site and **documentation** (`packages/web/src/content/docs/*.mdx` is the canonical feature reference: `agents`, `config`, `permissions`, `mcp-servers`, `models`, `providers`, `rules`, `skills`, `tools`, `tui`, `sdk`, `server`, etc.).
- `console`, `enterprise`, `identity`, `function`, `containers`, `control-plane` — hosted/cloud (OpenCode Zen) backends.
- `script`, `util`, `ui`, `storybook`, `slack`, `extensions` — supporting packages.

## Core architecture (base opencode)

**Client/server.** opencode is a single Hono app (`src/server/server.ts`, routes in `src/server/routes/*`) exposing an HTTP + SSE API, driven by one of several clients (TUI, web app, desktop, ACP). A server middleware reads `directory`/`workspace` from each request and wraps the handler in the right `Instance` context. `GET /event` bridges `Bus.subscribeAll` to an **SSE** stream. Clients use the generated **`@opencode-ai/sdk`** (`createOpencodeClient`) over two transports: real HTTP (`opencode serve`), or an **in-process bridge** where the TUI's `fetch` calls `Server.App().fetch(request)` directly (`src/cli/cmd/tui/worker.ts`) — i.e. the TUI reuses the *identical* server code path, not a separate one. This is why the TUI is "just another client."

**`Instance` — the DI/context container** (`src/project/instance.ts`). DI is done with **`AsyncLocalStorage`** (`src/util/context.ts` wraps it into `create()`/`use()`/`provide()`), not constructor injection. Everything is scoped to a project *directory*. `Instance.provide({ directory, init, fn })` resolves/caches a `Project` for a cwd, runs `InstanceBootstrap` once, and runs `fn` inside a context holding `directory`, `worktree` (git sandbox root; `/` for non-git projects), and `project`. Accessors `Instance.directory` / `Instance.worktree` / `Instance.project` read the current context. **`Instance.state(init, dispose?)`** (backed by `src/project/state.ts`) creates a per-directory memoized singleton with lifecycle disposal — the near-universal pattern for module state (e.g. `ToolRegistry.state`, `SessionPrompt.state`, `Bus.state`). `Instance.containsPath()` gates the `external_directory` permission.

**Namespaces, not classes.** Modules are organized as `export namespace X { ... }` with free functions and an `Instance.state` factory, rather than classes. Follow this when adding modules.

**Event bus** (`src/bus/`). `BusEvent.define(type, zodSchema)` declares an event; `Bus.publish` / `Bus.subscribe` / `Bus.subscribeAll` (wildcard `"*"`) move events within an instance and also emit to `GlobalBus`, which the server streams to clients over **SSE**. State flows server → bus → SSE → client store; client actions flow back via SDK HTTP calls.

**Session & the agent loop** (`src/session/`). A session holds a message history. `SessionPrompt.prompt(...)` → `loop(...)` (`session/prompt.ts`) is the turn engine: it resolves model/agent/tools (`ToolRegistry.tools(model, agent)` + MCP + LSP), assembles the system prompt (`system.ts` + fork injections), then runs `SessionProcessor.create().process()` (`session/processor.ts`), which consumes the **AI SDK v5** `fullStream` and translates deltas (`text-delta`, `reasoning`, `tool-call/result`, `step-finish`) into `Session.updatePart(...)`, handling retries, context-overflow→compaction, doom-loop detection, and snapshots. `session/llm.ts` wraps the AI SDK `streamText` call (prompt caching, provider transforms, plugin hooks). Messages use the **`MessageV2`** model: `Info` is a `User|Assistant` discriminated union; a message has typed **parts** discriminated by `type` (`text`, `reasoning`, `tool`, `file`, `step-start/finish`, `snapshot`, `patch`, `subtask`, `compaction`, `agent`, `retry`). `MessageV2.toModelMessages(msgs, model)` converts them to AI-SDK messages. Git **snapshots** (`src/snapshot/`) capture working-tree state so turns can be reverted/redone (no-ops for non-git projects).

**Providers & models** (`src/provider/`). `Provider` resolves models through the AI SDK, bundling ~20 provider factories (`@ai-sdk/anthropic|openai|google|bedrock|...`, OpenRouter, Copilot, GitLab). Model metadata comes from a **models.dev** snapshot baked in at build (`models-snapshot.ts`); auth via `src/auth/`. Key entry points: `Provider.getModel(providerID, modelID)`, `Provider.defaultModel()`. opencode is deliberately provider-agnostic; "opencode" is the hosted Zen provider.

**Tools** (`src/tool/`). Each tool is `Tool.define(id, init)` where `init` returns `{ description, parameters (zod), execute(args, ctx) }`. Descriptions are usually imported from a sibling `.txt` file. `Tool.define` auto-validates args against the schema and auto-truncates large output (unless the tool sets `metadata.truncated`). `ctx` provides `sessionID/messageID/agent/abort/messages`, a `metadata()` callback, and `ask()` for permission prompts. **`ToolRegistry`** (`src/tool/registry.ts`) holds the master list and does enablement: some tools are gated by env **flags** (`src/flag/flag.ts`, e.g. `OPENCODE_EXPERIMENTAL_PTY`, `OPENCODE_EXPERIMENTAL_LSP_TOOL`) or config; `websearch`/`codesearch` require the `opencode` provider or `OPENCODE_ENABLE_EXA`; GPT-family models get `apply_patch` while others get `edit`/`write`. Per-agent allow/deny is enforced by the tools themselves via `PermissionNext.evaluate(...)` against `agent.permission`. Custom tools are discovered from `{tool,tools}/*.{ts,js}` in config dirs and from plugins.

**Agents** (`src/agent/agent.ts`). An `Agent.Info` is a config object: `name`, `description`, `mode` (`primary` | `subagent` | `all`), `model`, `prompt`, `permission` (a `PermissionNext.Ruleset`), `temperature`, etc. Native agents are built in code (**build** = default full-access primary, **plan** = read-only primary, **general**/**explore** = subagents, plus hidden **compaction/title/summary**), then `cfg.agent` entries (from `opencode.json` or markdown agent files) can disable/override/add agents. Subagents run as **child sessions** — spawned with `Session.create({ parentID })` (the base `task` tool does this; the fork adds more spawn patterns).

**Config & rules.** `src/config/config.ts` defines the full config schema (Zod), loaded via `Instance.state` with strict precedence (later wins): remote `.well-known/opencode` → global `~/.config/opencode/opencode.json{,c}` → `OPENCODE_CONFIG` → project `opencode.json{,c}` → `.opencode/` dirs → inline → **managed enterprise dir (always wins)**. JSONC-aware; `mergeDeep` with array concatenation for `plugin`/`instructions`. Rules/instructions come from `AGENTS.md` (project + `~/.config/opencode/AGENTS.md` global), with `CLAUDE.md` / `~/.claude/CLAUDE.md` as Claude-Code-compatible fallbacks. Claude Code compat (skills, prompts) can be disabled with `OPENCODE_DISABLE_CLAUDE_CODE`.

**Storage.** State lives in **SQLite** at `<XDG_DATA>/opencode/opencode.db` (Drizzle ORM; schema in `src/**/*.sql.ts`, migrations in `packages/opencode/migration/`, bundled into the binary at build). `Database.use`/`transaction` use an AsyncLocalStorage tx context, and **`Database.effect()` defers `Bus.publish` until after the transaction commits** — so writes like `updateMessage`/`updatePart` persist first, then emit `MessageV2.Event.*` (which reach clients over SSE). On first run after upgrading, a one-time JSON→SQLite migration runs (`src/storage/json-migration.ts`). Global paths (`src/global/`) follow the XDG spec: config `~/.config/opencode`, data/`opencode.db`/logs under XDG data, cache auto-invalidated by `CACHE_VERSION`.

## Fork additions (the custom agent being built)

These are the fork's new/modified features. They are layered onto the base **mostly non-invasively** through `SystemPrompt` adapters and hook points in `session/prompt.ts`, `session/processor.ts`, and `project/bootstrap.ts`. All are currently **uncommitted**.

### Multi-agent orchestration
- **`src/agent/orchestrator.ts`** — `Orchestrator.execute({ strategy, tasks, ... })` with four strategies: **parallel** (`Promise.all`), **pipeline** (sequential, each output piped into the next as `<previous_output>`), **map-reduce** (parallel, then a `general` agent synthesizes), **consensus** (all agents solve the same prompt, then a `general` agent judges the best). Each task spawns a child session (`Session.create({ parentID })`) and returns its last assistant text.
- **`src/tool/orchestrate.ts`** (+`orchestrate.txt`) — the `orchestrate` tool; synchronous, awaits all agents.
- **`src/tool/delegate.ts`** — the `delegate` tool: **fire-and-forget async** background research in a read-only sub-session (only `explore`/`researcher`/`reviewer`). Returns a `del_...` id immediately; `delegation_read` / `delegation_list` retrieve status/output. Backed by **`src/session/delegation.ts`** (JSON persistence under the data dir).

### New native subagents (added to `agent.ts`, prompts in `src/agent/prompt/`)
- **reviewer** (read-only code review), **researcher** (read + web/websearch), **tester** (full access; writes/runs tests), **refactor** (read + edit; behavior-preserving), **brainstorm** (`mode: all`; asks clarifying questions, never writes code).

### New tools (`src/tool/`, all registered in `registry.ts`)
- **`git.ts`** (+`.txt`) — structured read-only git (`status|diff|log|branch|show|stash_list`) returning parsed JSON; prefer over `bash git` for reads.
- **`test.ts`** (+`.txt`) — auto-detects framework (vitest/jest/bun/pytest/cargo/go), runs it, returns `{ passed, failed, skipped, failures[] }`.
- **`lint.ts`** — auto-detects linter (eslint/biome/ruff/clippy/golangci-lint) or takes a custom command; structured pass/fail.
- **`memory.ts`** — `memory_save` / `memory_read` / `memory_list`; persistent project knowledge as markdown in `.opencode/memory/*.md` (backed by `session/project-memory.ts`), auto-injected into future sessions.
- **`plan-propose.ts`** — `plan_propose` surfaces a structured multi-step plan to the TUI Plan Review pane (instead of typing it in chat) and waits for accept/revise.
- **`pty.ts`** — `pty_spawn/read/write/kill/list` for interactive pseudo-terminals (REPLs, ssh, interactive rebase); gated behind `OPENCODE_EXPERIMENTAL_PTY`.

### Context intelligence & memory (`src/session/`)
- **`context-injection.ts`** — `ContextInjection.gather()` collects ambient project context (git diff/status, `package.json`, README head, Makefile/justfile targets, `.env.example` keys) into `<context-injection>` blocks (~4k-token budget).
- **`prompt/adaptive.ts`** + **`prompt/modules/*.txt`** — `AdaptivePrompt` sniffs languages (tsconfig/Cargo/pyproject/go.mod) and frameworks (react/next/vue/svelte/express/solid) and classifies the task (debugging/testing/refactoring), then concatenates matching prompt modules into an `<adaptive-context>` block.
- **`project-memory.ts`** — `.opencode/memory/*.md` store with term-overlap search; relevant memories auto-injected via `ProjectMemory.search(recentQuery)`.
- **`workspace.ts`** — in-memory per-session state (modified files, recent errors, parsed test results, build status) surfaced as a `<workspace>` summary; fed from `processor.ts`.

### Context-window management
- **`context-pruning.ts`** — **ephemeral, in-memory-only** pruning applied right before model messages are built (dedupe repeat tool calls, supersede write/edit output once a file is re-read, purge verbose stale errors). Never mutates the DB. Protects `todowrite/todoread/skill/question/plan_*`.
- **`dcp.ts`** — **Dynamic Context Pruning**: *persistent* compaction that scores parts by recency+type and marks the lowest-scored as `compacted` to fit ~85% of the model window. Exposed at **`POST /:sessionID/dcp`**.

### Safety & observability (new top-level modules)
- **`src/security/redact.ts`** — `SecretRedaction.redactOutput()` masks ~14 secret types (AWS/GitHub/JWT/Slack/OpenAI/Anthropic keys, connection strings, `.env` values); run on every completed tool output in `processor.ts` before storage/LLM.
- **`src/notification/`** — cross-platform desktop notifications (Windows toast / macOS osascript / Linux notify-send) on task-complete, permission-asked, and session-error; gated by the new `config.notifications` schema. Initialized in `project/bootstrap.ts`.
- **`src/telemetry/`** — pluggable event pipeline (`register`/`emit`, optional JSONL at `<data>/log/telemetry.jsonl`) subscribing to all bus events. Initialized in `project/bootstrap.ts`.

### New TUI views (`src/cli/cmd/tui/`)
The TUI is SolidJS rendered to the terminal via `@opentui/solid` + `@opentui/core` (JSX `<box>/<text>/<scrollbox>/<diff>`, flexbox, `useKeyboard`). It boots in `app.tsx` through a deep provider tree; the `context/` providers (`sdk.tsx` = SDK client + SSE, `sync.tsx` = central client store reconciled from server events, `local.tsx`, `keybind.tsx`, ...) drive everything. The main view is `routes/session/index.tsx`.
New views/components (all untracked): **`split-pane.tsx`** (resizable secondary pane with a tab bar — Agents/Terminal/Files/Plan), **`agents-view.tsx`** (live sub-agent orchestration monitor), **`terminal-view.tsx`** (bash-process monitor), **`diff-view.tsx`** (syntax-highlighted file diffs), **`file-preview.tsx`**, **`plan-review.tsx`** (interactive per-step plan approval → posts to `/plan/decision`), **`help-overlay.tsx`** (keybinding cheat-sheet), **`component/file-tree.tsx`** (live project tree), **`component/progress-dashboard.tsx`** (busy-subagent list). `index.tsx` auto-opens the relevant pane reactively (edit→files, long bash→terminal, orchestrate→agents, plan_propose→plan).

### New server endpoints (`src/server/routes/session.ts`)
- **`POST /:sessionID/dcp`** — run dynamic context pruning for a target model.
- **`POST /:sessionID/plan/decision`** — plan review accept/revise; `accept` switches to the build agent and resumes the loop, `revise` feeds per-step rejection comments back to the plan agent. Runs the agent loop fire-and-forget (TUI gets updates over SSE).

### Wiring summary (where the fork hooks in)
- `session/prompt.ts` — injects adaptive prompt, context-injection, workspace summary, and project-memory search into the system prompt; applies `ContextPruning`; appends live `<current_todos>` + TODO-discipline reminders; cancels child sub-agent sessions on abort.
- `session/processor.ts` — secret redaction + workspace tracking on tool results.
- `session/system.ts` — thin `adaptive()` / `contextInjection()` / `workspace()` adapters.
- `project/bootstrap.ts` — initializes `Notification` and `Telemetry`.
- `tool/registry.ts` — registers all new tools (and re-enables `todoread`).
- Prompt tweaks: `bash.txt` (non-interactive shell rules), `todowrite/todoread.txt` (stronger real-time-update mandate), `question.ts`/`question.txt` (mandatory per-option `detail` + "tell me more" elaborate flow), `websearch.ts` (inline `[N]` citations + Sources section), `plan.txt`/`qwen.txt`.

## Conventions

Follow the root **`AGENTS.md`** style guide (it is mandatory for agent-written code). Highlights:
- **Single-word names** by default for locals/params/helpers (`cfg`, `dir`, `opts`, `err`, `pid`); multi-word only when a single word is ambiguous. Inline values used once.
- Prefer `const`, early returns, and ternaries; **avoid `else`**, avoid `try/catch` where possible, avoid the `any` type, avoid unnecessary destructuring (use dot access).
- Prefer functional array methods over loops; use type-guard filters to preserve inference. Rely on type inference; annotate only for exports/clarity.
- Use Bun APIs (`Bun.file()`, `$`) where possible.
- **Drizzle schemas** use `snake_case` field names so DB column names don't need re-declaring; join columns `<entity>_id`, indexes `<table>_<column>_idx`. Schema files are `src/**/*.sql.ts`.
- Tests: avoid mocks; test the real implementation; run from a package dir, never the root.
- **Always use parallel tool calls** when operations are independent.
