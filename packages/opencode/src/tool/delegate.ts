import { Tool } from "./tool"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { Delegation } from "../session/delegation"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.delegate" })

export const DelegateTool = Tool.define("delegate", async () => {
  const agents = await Agent.list().then((x) =>
    x.filter((a) => a.mode === "subagent" && ["explore", "researcher", "reviewer"].includes(a.name)),
  )
  const agentNames = agents.map((a) => a.name)

  return {
    description: `Fire off an async research task that runs in the background. Returns immediately with a delegation ID. Use delegation_read to get results later. The task runs in a read-only sub-agent session.

Available agents: ${agents.map((a) => `${a.name} (${a.description})`).join("; ")}`,
    parameters: z.object({
      prompt: z.string().describe("The research task to perform"),
      agent: z.string().describe(`Agent type to use: ${agentNames.join(", ")}`),
      title: z.string().describe("Short title for this delegation (3-5 words)"),
    }),
    async execute(params, ctx) {
      const agent = await Agent.get(params.agent)
      if (!agent) throw new Error(`Unknown agent: ${params.agent}. Available: ${agentNames.join(", ")}`)

      // Only allow read-only agents
      if (!["explore", "researcher", "reviewer"].includes(params.agent)) {
        throw new Error(`Only read-only agents (explore, researcher, reviewer) can be delegated`)
      }

      await ctx.ask({
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

      const session = await Session.create({
        parentID: ctx.sessionID,
        title: `[async] ${params.title} (@${agent.name})`,
      })

      await Delegation.save({
        id: delegationID,
        sessionID: ctx.sessionID,
        agentSessionID: session.id,
        title: params.title,
        prompt: params.prompt,
        agent: params.agent,
        status: "running",
        startTime: Date.now(),
      })

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      const model = agent.model ?? {
        modelID: (msg.info as any).modelID,
        providerID: (msg.info as any).providerID,
      }

      // Fire and forget — don't await
      const messageID = Identifier.ascending("message")
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model,
        agent: agent.name,
        tools: { todowrite: false, todoread: false, task: false },
        parts: promptParts,
      })
        .then(async (result) => {
          const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""
          await Delegation.update(delegationID, {
            status: "completed",
            output: text,
            summary: text.slice(0, 200),
            endTime: Date.now(),
          })
          log.info("delegation completed", { id: delegationID })
        })
        .catch(async (err) => {
          await Delegation.update(delegationID, {
            status: "error",
            output: err instanceof Error ? err.message : String(err),
            endTime: Date.now(),
          })
          log.error("delegation failed", { id: delegationID, error: err })
        })

      ctx.metadata({
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
    },
  }
})

export const DelegationReadTool = Tool.define("delegation_read", async () => {
  return {
    description:
      "Read the result of a background delegation task. Returns the current status and output if completed.",
    parameters: z.object({
      id: z.string().describe("The delegation ID returned by the delegate tool"),
    }),
    async execute(params) {
      const entry = await Delegation.get(params.id)
      if (!entry) {
        return {
          title: "Delegation not found",
          metadata: {},
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
    },
  }
})

export const DelegationListTool = Tool.define("delegation_list", async () => {
  return {
    description: "List all background delegation tasks for the current session with their status.",
    parameters: z.object({}),
    async execute(_params, ctx) {
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
    },
  }
})
