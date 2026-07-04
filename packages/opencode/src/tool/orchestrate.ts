import { Schema, Effect } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { Orchestrator } from "../agent/orchestrator"
import { Session } from "../session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { Database } from "@opencode-ai/core/database/database"
import DESCRIPTION from "./orchestrate.txt"

const Parameters = Schema.Struct({
  strategy: Schema.Literals(["parallel", "pipeline", "map-reduce", "consensus"]).annotate({
    description:
      "Orchestration strategy: parallel (run simultaneously), pipeline (chain outputs), map-reduce (split and merge), consensus (compare solutions)",
  }),
  tasks: Schema.Array(
    Schema.Struct({
      agent: Schema.String.annotate({
        description: "Agent name to use (reviewer, researcher, tester, refactor, general, explore)",
      }),
      description: Schema.String.annotate({ description: "Short task description (3-5 words)" }),
      prompt: Schema.String.annotate({ description: "Full task prompt for the agent" }),
    }),
  ).annotate({ description: "Tasks to orchestrate" }),
})

export const OrchestrateTool = Tool.define(
  "orchestrate",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service
    const database = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Get the current model from the message that triggered this tool call
          const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.orDie,
          )

          const model = yield* Effect.gen(function* () {
            if (msg.info.role === "assistant" && msg.info.providerID && msg.info.modelID) {
              return { providerID: msg.info.providerID, modelID: msg.info.modelID }
            }
            // Fallback: find last assistant message in the session
            const msgs = yield* sessions.messages({ sessionID: ctx.sessionID })
            const lastAssistant = msgs.filter((m) => m.info.role === "assistant" && m.info.providerID).pop()
            if (lastAssistant && lastAssistant.info.role === "assistant") {
              return { providerID: lastAssistant.info.providerID, modelID: lastAssistant.info.modelID }
            }
            // Final fallback: project default model
            return yield* provider.defaultModel()
          })

          // Orchestrator is a plain-Promise module that bridges back into the
          // Effect world via the global AppRuntime, whose fibers lack the
          // per-request InstanceRef — resolve the instance context here (this
          // execute body runs inside it) and thread it in so Orchestrator can
          // re-provide it on every bridged effect.
          const instance = yield* InstanceState.context

          const results = yield* Effect.promise(() =>
            Orchestrator.execute({
              strategy: params.strategy,
              tasks: params.tasks.map((task) => ({ ...task })),
              sessionID: ctx.sessionID,
              model,
              abort: ctx.abort,
              instance,
            }),
          )

          const summary = results
            .map(
              (r, i) =>
                `[${r.agent}] ${r.status === "completed" ? "OK" : "ERROR"} (${r.duration}ms)\n${r.output.slice(0, 2000)}`,
            )
            .join("\n\n---\n\n")

          const completed = results.filter((r) => r.status === "completed").length
          const failed = results.filter((r) => r.status === "error").length

          return {
            title: `Orchestrated ${results.length} agents (${params.strategy})`,
            output: `Orchestration complete: ${completed} succeeded, ${failed} failed\n\n${summary}`,
            metadata: {
              strategy: params.strategy,
              completed,
              failed,
              results: results.map((r) => ({
                agent: r.agent,
                status: r.status,
                duration: r.duration,
                sessionID: r.sessionID,
              })),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
