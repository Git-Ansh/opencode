import z from "zod"
import { Tool } from "./tool"
import { Orchestrator } from "../agent/orchestrator"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { Session } from "../session"
import DESCRIPTION from "./orchestrate.txt"

export const OrchestrateTool = Tool.define("orchestrate", {
  description: DESCRIPTION,
  parameters: z.object({
    strategy: z
      .enum(["parallel", "pipeline", "map-reduce", "consensus"])
      .describe(
        "Orchestration strategy: parallel (run simultaneously), pipeline (chain outputs), map-reduce (split and merge), consensus (compare solutions)",
      ),
    tasks: z
      .array(
        z.object({
          agent: z
            .string()
            .describe("Agent name to use (reviewer, researcher, tester, refactor, general, explore)"),
          description: z.string().describe("Short task description (3-5 words)"),
          prompt: z.string().describe("Full task prompt for the agent"),
        }),
      )
      .describe("Tasks to orchestrate"),
  }),
  async execute(params, ctx) {
    // Get the current model from the message that triggered this tool call
    const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
    let model: { providerID: string; modelID: string }

    if (msg.info.role === "assistant" && msg.info.providerID && msg.info.modelID) {
      model = { providerID: msg.info.providerID, modelID: msg.info.modelID }
    } else {
      // Fallback: find last assistant message in the session
      const msgs = await Session.messages({ sessionID: ctx.sessionID })
      const lastAssistant = msgs.filter(m => m.info.role === "assistant" && m.info.providerID).pop()
      if (lastAssistant && lastAssistant.info.role === "assistant") {
        model = { providerID: lastAssistant.info.providerID, modelID: lastAssistant.info.modelID }
      } else {
        // Final fallback: project default model
        model = await Provider.defaultModel()
      }
    }

    const results = await Orchestrator.execute({
      strategy: params.strategy,
      tasks: params.tasks,
      sessionID: ctx.sessionID,
      model,
      abort: ctx.abort,
    })

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
  },
})
