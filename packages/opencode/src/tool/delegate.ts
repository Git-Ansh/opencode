import * as Tool from "./tool"
import { Schema, Effect, Scope, Cause } from "effect"
import { Session } from "../session/session"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { TaskPromptOps } from "./task"
import { Delegation } from "../session/delegation"
import { Database } from "@opencode-ai/core/database/database"

// TODO(port): util/log.ts no longer exists — logging moved to Effect's Logger
// (packages/core/src/observability/logging.ts). This module now runs natively
// inside the Effect world (Tool.define wraps execute in Effect.gen), but the
// per-call logging below happens after the fire-and-forget prompt completes,
// outside the tool's own call span, so it's kept as a lightweight console
// logger rather than threading an Effect logger through the fork.
const log = {
  info: (message: string, extra?: Record<string, unknown>) => console.error(`[tool.delegate] ${message}`, extra ?? ""),
  error: (message: string, extra?: Record<string, unknown>) => console.error(`[tool.delegate] ${message}`, extra ?? ""),
}

// Note(port): the field-level `agent` description used to list the dynamically
// resolved agent names (only known once `Agent.Service.list()` resolves inside
// the tool's init Effect). Keeping the schema's *shape* static/hoisted (needed
// so TypeScript can infer `execute`'s params type — see tool/task.ts for the
// established pattern) means that per-field annotation can no longer embed the
// live agent list; the tool's top-level `description` string still does,
// since that's plain runtime text with no effect on the schema's type.
const DelegateParameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The research task to perform" }),
  agent: Schema.String.annotate({ description: "Agent type to use (see tool description for available agents)" }),
  title: Schema.String.annotate({ description: "Short title for this delegation (3-5 words)" }),
})

// TODO(port): `tool/task.ts` (the native `task` tool) is the modern,
// fully-Effect-native equivalent of a single delegated subagent call — it
// even has a `background: true` mode with BackgroundJob-backed notification
// on completion, which is close to what this file's "fire-and-forget +
// delegation_read" design does by hand. Keeping this file as its own
// tool (as originally ported) since it targets a narrower set of read-only
// agents and a simpler polling-based read-back model, but it may be worth
// consolidating with `task` in a later pass.
//
// Note(port/wiring): originally yielded `SessionPrompt.Service` directly, but
// `session/prompt.ts`'s own layer already depends on `tool/registry.ts`
// (ToolRegistry.node) to resolve custom tools — yielding SessionPrompt.Service
// here would make registry.ts need SessionPrompt.node too, a genuine
// LayerNode cycle. `tool/task.ts` sidesteps exactly this by never taking
// SessionPrompt.Service as an Effect dependency: prompt.ts builds a
// `TaskPromptOps` object once per prompt loop and threads it through every
// tool call via `ctx.extra.promptOps` (see session/tools.ts's `context()`).
// This file now uses that same plumbing instead.
const DELEGATABLE_AGENTS = ["explore", "researcher", "reviewer"]

export const DelegateTool = Tool.define(
  "delegate",
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const scope = yield* Scope.Scope

    // Note(port/wiring): `agent.list()` reads per-instance config (InstanceState),
    // which is only available once a project instance is loaded. `Tool.define`'s
    // init Effect above runs once as part of ToolRegistry's global, instance-
    // independent layer build (see tool/registry.ts), *before* any InstanceRef is
    // provided — calling `agent.list()` here (as this used to) dies with
    // "InstanceRef not provided" for every command, not just ones that use this
    // tool. Same class of bug already worked around in tool/lint.ts and
    // tool/test.ts: instance-scoped lookups must be deferred into `execute`,
    // which always runs within a request that has a loaded instance. The static
    // `description` below can no longer embed the live per-agent description
    // text, so it just names the fixed allowlist instead.
    return {
      description: `Fire off an async research task that runs in the background. Returns immediately with a delegation ID. Use delegation_read to get results later. The task runs in a read-only sub-agent session.

Available agents: ${DELEGATABLE_AGENTS.join(", ")} (read-only subagents; use the \`task\` tool description for what each does).`,
      parameters: DelegateParameters,
      execute: (params: Schema.Schema.Type<typeof DelegateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const agents = (yield* agent.list()).filter(
            (a) => a.mode === "subagent" && DELEGATABLE_AGENTS.includes(a.name),
          )
          const agentNames = agents.map((a) => a.name)

          const next = yield* agent.get(params.agent)
          if (!next) return yield* Effect.fail(new Error(`Unknown agent: ${params.agent}. Available: ${agentNames.join(", ")}`))

          // Only allow read-only agents
          if (!DELEGATABLE_AGENTS.includes(params.agent)) {
            return yield* Effect.fail(new Error(`Only read-only agents (${DELEGATABLE_AGENTS.join(", ")}) can be delegated`))
          }

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) return yield* Effect.fail(new Error("delegate tool requires promptOps in ctx.extra"))

          yield* ctx.ask({
            permission: "task",
            patterns: [params.agent],
            always: ["*"],
            metadata: {
              description: params.title,
              subagent_type: params.agent,
              async: true,
            },
          })

          const delegationID = `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

          const session = yield* sessions.create({
            parentID: ctx.sessionID,
            title: `[async] ${params.title} (@${next.name})`,
          })

          yield* Effect.promise(() =>
            Delegation.save({
              id: delegationID,
              sessionID: ctx.sessionID,
              agentSessionID: session.id,
              title: params.title,
              prompt: params.prompt,
              agent: params.agent,
              status: "running",
              startTime: Date.now(),
            }),
          )

          const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.orDie,
          )
          const model =
            next.model ??
            (msg.info.role === "assistant"
              ? { modelID: msg.info.modelID, providerID: msg.info.providerID }
              : undefined)
          if (!model) return yield* Effect.fail(new Error("No model available to run the delegated agent"))

          // Fire and forget — don't await
          const promptParts = yield* ops.resolvePromptParts(params.prompt)

          yield* ops
            .prompt({
              sessionID: session.id,
              model,
              agent: next.name,
              parts: promptParts,
            })
            .pipe(
              // Note(port/wiring): `ops.prompt` (see tool/task.ts's TaskPromptOps) already
              // converts every failure into a defect (`Effect.catch(Effect.die)` in
              // session/prompt.ts's `ops()`), so its error channel is `never` — use
              // matchCauseEffect + Cause.squash to still observe/report failures here.
              Effect.matchCauseEffect({
                onSuccess: (result) =>
                  Effect.promise(async () => {
                    const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""
                    await Delegation.update(delegationID, {
                      status: "completed",
                      output: text,
                      summary: text.slice(0, 200),
                      endTime: Date.now(),
                    })
                    log.info("delegation completed", { id: delegationID })
                  }),
                onFailure: (cause) =>
                  Effect.promise(async () => {
                    const err = Cause.squash(cause)
                    await Delegation.update(delegationID, {
                      status: "error",
                      output: err instanceof Error ? err.message : String(err),
                      endTime: Date.now(),
                    })
                    log.error("delegation failed", { id: delegationID, error: err })
                  }),
              }),
              Effect.forkIn(scope, { startImmediately: true }),
            )

          yield* ctx.metadata({
            title: `Delegated: ${params.title}`,
            metadata: { delegationID, sessionId: session.id },
          })

          return {
            title: `Delegated: ${params.title}`,
            metadata: { delegationID, sessionId: session.id },
            output: [
              `Delegation ${delegationID} started (agent: ${params.agent}).`,
              `The task is running in the background.`,
              `Use delegation_read with id "${delegationID}" to check results later.`,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const DelegationReadParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The delegation ID returned by the delegate tool" }),
})

export const DelegationReadTool = Tool.define(
  "delegation_read",
  Effect.gen(function* () {
    return {
      description:
        "Read the result of a background delegation task. Returns the current status and output if completed.",
      parameters: DelegationReadParameters,
      execute: (params: Schema.Schema.Type<typeof DelegationReadParameters>) =>
        Effect.promise(async () => {
          const entry = await Delegation.get(params.id)
          if (!entry) {
            return {
              title: "Delegation not found",
              metadata: {} as Record<string, any>,
              output: `No delegation found with ID: ${params.id}`,
            }
          }

          const elapsed = entry.endTime
            ? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s`
            : `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s (still running)`

          const lines = [
            `Delegation: ${entry.title}`,
            `Status: ${entry.status}`,
            `Agent: ${entry.agent}`,
            `Duration: ${elapsed}`,
            `Session: ${entry.agentSessionID}`,
            "",
          ]

          if (entry.status === "completed" && entry.output) {
            lines.push("<delegation_result>", entry.output, "</delegation_result>")
          } else if (entry.status === "error" && entry.output) {
            lines.push(`Error: ${entry.output}`)
          } else {
            lines.push("Task is still running. Check back later.")
          }

          return {
            title: `Delegation: ${entry.title} (${entry.status})`,
            metadata: { delegationID: entry.id, status: entry.status },
            output: lines.join("\n"),
          }
        }),
    }
  }),
)

const DelegationListParameters = Schema.Struct({})

export const DelegationListTool = Tool.define(
  "delegation_list",
  Effect.gen(function* () {
    return {
      description: "List all background delegation tasks for the current session with their status.",
      parameters: DelegationListParameters,
      execute: (_params: Schema.Schema.Type<typeof DelegationListParameters>, ctx: Tool.Context) =>
        Effect.promise(async () => {
          const entries = await Delegation.list(ctx.sessionID)

          if (entries.length === 0) {
            return {
              title: "No delegations",
              metadata: {},
              output: "No background delegations have been created in this session.",
            }
          }

          const lines = entries.map((e) => {
            const elapsed = e.endTime
              ? `${((e.endTime - e.startTime) / 1000).toFixed(1)}s`
              : `${((Date.now() - e.startTime) / 1000).toFixed(1)}s`
            return `- [${e.status}] ${e.id}: ${e.title} (${e.agent}, ${elapsed})`
          })

          return {
            title: `${entries.length} delegation(s)`,
            metadata: {},
            output: lines.join("\n"),
          }
        }),
    }
  }),
)
