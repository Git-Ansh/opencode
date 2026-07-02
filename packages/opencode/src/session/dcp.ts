import { AppRuntime } from "@/effect/app-runtime"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "../provider/provider"
import { Token } from "../util/token"
import { ProviderTransform } from "../provider/transform"

// TODO(port): util/log.ts no longer exists — logging moved to Effect's Logger
// (packages/core/src/observability/logging.ts), not reachable from this plain
// async helper. Falls back to console.error.
const log = {
  info: (message: string, extra?: Record<string, unknown>) => console.error(`[dcp] ${message}`, extra ?? ""),
}

export namespace DCP {
  interface ScoreEntry {
    part: SessionV1.Part
    messageID: string
    messageIndex: number
    score: number
    tokens: number
  }

  export interface Stats {
    before: number
    after: number
    pruned: number
    kept: number
    percentage: number
  }

  export async function adapt(input: {
    sessionID: string
    model: Provider.Model
  }): Promise<Stats> {
    const msgs = await AppRuntime.runPromise(Session.use.messages({ sessionID: SessionID.make(input.sessionID) }))
    const contextLimit = input.model.limit.context
    const maxOutput = ProviderTransform.maxOutputTokens(input.model)
    const target = Math.floor((contextLimit - maxOutput) * 0.85)

    // Calculate total tokens
    let total = 0
    const entries: ScoreEntry[] = []

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      for (const part of msg.parts) {
        const tokens = estimatePartTokens(part)
        total += tokens
        entries.push({
          part,
          messageID: msg.info.id,
          messageIndex: i,
          score: scorePart(part, i, msgs.length),
          tokens,
        })
      }
    }

    log.info("adapt", { total, target, contextLimit })

    if (total <= target) {
      return {
        before: total,
        after: total,
        pruned: 0,
        kept: 100,
        percentage: Math.round((total / contextLimit) * 100),
      }
    }

    // Sort by score ascending (lowest relevance first)
    const sorted = entries
      .filter((e) => canPrune(e))
      .sort((a, b) => a.score - b.score)

    let pruned = 0
    const toPrune: ScoreEntry[] = []

    for (const entry of sorted) {
      if (total - pruned <= target) break
      toPrune.push(entry)
      pruned += entry.tokens
    }

    // Apply pruning
    for (const entry of toPrune) {
      if (entry.part.type === "tool" && entry.part.state.status === "completed") {
        entry.part.state.time.compacted = Date.now()
        await AppRuntime.runPromise(Session.use.updatePart(entry.part))
      }
    }

    const after = total - pruned
    const kept = Math.round((1 - pruned / total) * 100)

    log.info("adapted", { before: total, after, pruned, kept })

    return {
      before: total,
      after,
      pruned: toPrune.length,
      kept,
      percentage: Math.round((after / contextLimit) * 100),
    }
  }

  function scorePart(part: SessionV1.Part, msgIndex: number, totalMsgs: number): number {
    let score = 0

    // Recency score: newer = higher (exponential decay)
    const recency = msgIndex / Math.max(totalMsgs - 1, 1)
    score += recency * 50

    // Type score
    switch (part.type) {
      case "text":
        score += 40
        break
      case "compaction":
        score += 100 // always keep
        break
      case "step-start":
      case "step-finish":
        score += 30
        break
      case "tool":
        if (part.state.status === "completed") {
          score += 15
          // Skill tool outputs are more valuable
          if (part.tool === "skill") score += 30
        } else {
          score += 25
        }
        break
      case "reasoning":
        score += 10
        break
      case "patch":
        score += 35
        break
      case "file":
        score += 30
        break
      default:
        score += 20
    }

    return score
  }

  function canPrune(entry: ScoreEntry): boolean {
    const part = entry.part
    // Never prune compaction summaries
    if (part.type === "compaction") return false
    // Never prune user text
    if (part.type === "text") return false
    // Never prune patches (they're small and important)
    if (part.type === "patch") return false
    // Never prune step markers
    if (part.type === "step-start" || part.type === "step-finish") return false
    // Can prune tool outputs and reasoning
    if (part.type === "tool" && part.state.status === "completed") return true
    if (part.type === "reasoning") return true
    return false
  }

  function estimatePartTokens(part: SessionV1.Part): number {
    switch (part.type) {
      case "text":
        return Token.estimate((part as any).text ?? "")
      case "tool":
        if (part.state.status === "completed" && !part.state.time.compacted) {
          return Token.estimate(part.state.output ?? "")
        }
        return Token.estimate(JSON.stringify(part.state.input ?? ""))
      case "reasoning":
        return Token.estimate((part as any).text ?? "")
      case "compaction":
        return 50
      default:
        return 20
    }
  }
}
