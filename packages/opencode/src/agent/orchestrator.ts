import { Agent } from "./agent"
import { Session } from "../session/session"
import { SessionPrompt } from "../session/prompt"
import { SessionID } from "../session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppRuntime } from "@/effect/app-runtime"

// TODO(port): util/log.ts no longer exists — logging moved to Effect's Logger
// (packages/core/src/observability/logging.ts), not reachable from this plain
// async orchestration engine. Falls back to console.error.
const log = {
  info: (message: string, extra?: Record<string, unknown>) => console.error(`[orchestrator] ${message}`, extra ?? ""),
}

// TODO(port): Agent.get/list, Session.create/messages, and SessionPrompt.prompt
// are now Effect services (packages under the app's Effect DI graph) rather than
// plain async functions. This file stays Promise-based — matching its original
// design and the `tool/orchestrate.ts` caller — and bridges into the Effect
// world via `AppRuntime.runPromise`, the same escape hatch the codebase itself
// uses for other legacy Promise/async-local-storage callers (see
// project/instance-runtime.ts). A more idiomatic native-Effect rewrite (see
// tool/task.ts for the modern equivalent of a single delegated subagent call)
// is possible but out of scope for this import-fixing pass.
export namespace Orchestrator {
  export type Strategy = "parallel" | "pipeline" | "map-reduce" | "consensus"

  export interface TaskSpec {
    agent: string
    prompt: string
    description: string
  }

  export interface Result {
    agent: string
    sessionID: string
    output: string
    status: "completed" | "error"
    duration: number
  }

  export async function execute(input: {
    strategy: Strategy
    tasks: TaskSpec[]
    sessionID: string
    model: { providerID: string; modelID: string }
    abort: AbortSignal
  }): Promise<Result[]> {
    switch (input.strategy) {
      case "parallel":
        return parallel(input)
      case "pipeline":
        return pipeline(input)
      case "map-reduce":
        return mapReduce(input)
      case "consensus":
        return consensus(input)
    }
  }

  async function spawnAgent(spec: TaskSpec, parentID: string, model: { providerID: string; modelID: string }, abort: AbortSignal): Promise<Result> {
    const start = Date.now()
    const agent = await AppRuntime.runPromise(Agent.Service.use((a) => a.get(spec.agent)))
    if (!agent) {
      return {
        agent: spec.agent,
        sessionID: "",
        output: `Agent "${spec.agent}" not found`,
        status: "error",
        duration: 0,
      }
    }

    try {
      const finalModel = agent.model ?? model
      if (!finalModel.providerID || !finalModel.modelID) {
        return {
          agent: spec.agent,
          sessionID: "",
          output: "No model available for agent",
          status: "error",
          duration: Date.now() - start,
        }
      }

      const session = await AppRuntime.runPromise(
        Session.use.create({
          parentID: SessionID.make(parentID),
          title: `${spec.description} (@${spec.agent} subagent)`,
        }),
      )

      await AppRuntime.runPromise(
        SessionPrompt.Service.use((sessionPrompt) =>
          sessionPrompt.prompt({
            sessionID: session.id,
            agent: spec.agent,
            model: {
              providerID: ProviderV2.ID.make(finalModel.providerID),
              modelID: ModelV2.ID.make(finalModel.modelID),
            },
            parts: [{ type: "text", text: spec.prompt }],
          }),
        ),
      )

      const msgs = await AppRuntime.runPromise(Session.use.messages({ sessionID: session.id }))
      const lastAssistant = msgs
        .filter((m) => m.info.role === "assistant")
        .pop()

      const output = lastAssistant?.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as SessionV1.TextPart).text)
        .join("\n") ?? ""

      return {
        agent: spec.agent,
        sessionID: session.id,
        output,
        status: "completed",
        duration: Date.now() - start,
      }
    } catch (e: any) {
      return {
        agent: spec.agent,
        sessionID: "",
        output: e.message ?? String(e),
        status: "error",
        duration: Date.now() - start,
      }
    }
  }

  async function parallel(input: {
    tasks: TaskSpec[]
    sessionID: string
    model: { providerID: string; modelID: string }
    abort: AbortSignal
  }): Promise<Result[]> {
    log.info("parallel", { count: input.tasks.length })
    const results = await Promise.all(
      input.tasks.map((task) => spawnAgent(task, input.sessionID, input.model, input.abort)),
    )
    return results
  }

  async function pipeline(input: {
    tasks: TaskSpec[]
    sessionID: string
    model: { providerID: string; modelID: string }
    abort: AbortSignal
  }): Promise<Result[]> {
    log.info("pipeline", { count: input.tasks.length })
    const results: Result[] = []
    let prev = ""

    for (const task of input.tasks) {
      const prompt = prev
        ? `Previous agent output:\n<previous_output>\n${prev}\n</previous_output>\n\n${task.prompt}`
        : task.prompt
      const result = await spawnAgent({ ...task, prompt }, input.sessionID, input.model, input.abort)
      results.push(result)
      prev = result.output
      if (result.status === "error") break
    }

    return results
  }

  async function mapReduce(input: {
    tasks: TaskSpec[]
    sessionID: string
    model: { providerID: string; modelID: string }
    abort: AbortSignal
  }): Promise<Result[]> {
    log.info("map-reduce", { count: input.tasks.length })
    // Map phase: run all tasks in parallel
    const mapped = await parallel(input)

    // Reduce phase: synthesize results
    const combined = mapped
      .filter((r) => r.status === "completed")
      .map((r, i) => `<result agent="${r.agent}" index="${i}">\n${r.output}\n</result>`)
      .join("\n\n")

    if (!combined) return mapped

    const reducer: TaskSpec = {
      agent: "general",
      description: "Synthesize results",
      prompt: `Synthesize the following results from multiple agents into a coherent summary:\n\n${combined}`,
    }
    const reduced = await spawnAgent(reducer, input.sessionID, input.model, input.abort)
    return [...mapped, reduced]
  }

  async function consensus(input: {
    tasks: TaskSpec[]
    sessionID: string
    model: { providerID: string; modelID: string }
    abort: AbortSignal
  }): Promise<Result[]> {
    log.info("consensus", { count: input.tasks.length })
    // Run all tasks on the same prompt
    const results = await parallel(input)

    // Compare results
    const outputs = results
      .filter((r) => r.status === "completed")
      .map((r, i) => `<solution agent="${r.agent}" index="${i}">\n${r.output}\n</solution>`)
      .join("\n\n")

    if (!outputs) return results

    const judge: TaskSpec = {
      agent: "general",
      description: "Judge consensus",
      prompt: `Multiple agents solved the same problem. Compare their solutions and provide the best answer:\n\n${outputs}`,
    }
    const judged = await spawnAgent(judge, input.sessionID, input.model, input.abort)
    return [...results, judged]
  }
}
