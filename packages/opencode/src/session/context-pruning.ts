import { Log } from "../util/log"
import type { MessageV2 } from "./message-v2"

export namespace ContextPruning {
  const log = Log.create({ service: "context-pruning" })

  // Protected tools whose outputs should never be pruned
  const PROTECTED_TOOLS = new Set(["todowrite", "todoread", "skill", "question", "plan_enter", "plan_exit"])

  /**
   * Apply all ephemeral context pruning passes on a deep-cloned message array.
   * Never touches the database — all mutations are in-memory only.
   */
  export function apply(messages: MessageV2.WithParts[]): MessageV2.WithParts[] {
    const msgs = structuredClone(messages)
    const deduped = deduplicateToolCalls(msgs)
    const superseded = supersedeWrites(msgs)
    const purged = purgeOldErrors(msgs)
    if (deduped + superseded + purged > 0) {
      log.info("pruned", { deduped, superseded, purged })
    }
    return msgs
  }

  /**
   * Deduplicate repeated tool calls with identical tool+input.
   * Walk backwards (newest first), keep the most recent, replace older duplicates.
   */
  function deduplicateToolCalls(msgs: MessageV2.WithParts[]): number {
    const seen = new Map<string, number>() // key -> message index of most recent
    let count = 0

    // Walk backwards to find the most recent call first
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      for (const part of msg.parts) {
        if (part.type !== "tool") continue
        if (part.state.status !== "completed") continue
        if (PROTECTED_TOOLS.has(part.tool)) continue

        const key = `${part.tool}:${JSON.stringify(part.state.input)}`
        if (!seen.has(key)) {
          seen.set(key, i)
        } else {
          // This is an older duplicate — replace output
          part.state.output = `[deduplicated — see more recent ${part.tool} call with same input]`
          count++
        }
      }
    }

    return count
  }

  /**
   * Supersede write/edit outputs when the file was later read.
   * If we read a file after writing it, the write output is redundant.
   */
  function supersedeWrites(msgs: MessageV2.WithParts[]): number {
    // Collect all file paths that were read (walk backwards)
    const readPaths = new Set<string>()
    const readIndex = new Map<string, number>() // path -> first (latest) read index
    let count = 0

    for (let i = msgs.length - 1; i >= 0; i--) {
      for (const part of msgs[i].parts) {
        if (part.type !== "tool") continue
        if (part.state.status !== "completed") continue
        if (part.tool === "read" && part.state.input?.filePath) {
          const fp = part.state.input.filePath as string
          if (!readPaths.has(fp)) {
            readPaths.add(fp)
            readIndex.set(fp, i)
          }
        }
      }
    }

    // Walk through write/edit parts — if the file was read after, supersede
    for (let i = 0; i < msgs.length; i++) {
      for (const part of msgs[i].parts) {
        if (part.type !== "tool") continue
        if (part.state.status !== "completed") continue
        if (part.tool !== "write" && part.tool !== "edit") continue

        const fp = (part.state.input?.filePath ?? part.state.input?.file_path) as string | undefined
        if (!fp) continue

        const ri = readIndex.get(fp)
        if (ri !== undefined && ri > i) {
          // The file was read after this write — supersede
          part.state.output = `[superseded — file was later read at its current state]`
          count++
        }
      }
    }

    return count
  }

  /**
   * Purge detailed input from old error tool parts.
   * Keep the error message but remove verbose input content for errors older than N turns.
   */
  function purgeOldErrors(msgs: MessageV2.WithParts[], turnsAgo: number = 4): number {
    // Count user turns from the end
    let userTurns = 0
    const turnCutoff: number[] = []

    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role === "user") {
        userTurns++
        if (userTurns >= turnsAgo) {
          turnCutoff.push(i)
          break
        }
      }
    }

    if (turnCutoff.length === 0) return 0
    const cutoffIndex = turnCutoff[0]
    let count = 0

    for (let i = 0; i < cutoffIndex; i++) {
      for (const part of msgs[i].parts) {
        if (part.type !== "tool") continue
        if (part.state.status !== "error") continue
        // Keep the error message but trim the input
        const inputStr = JSON.stringify(part.state.input)
        if (inputStr.length > 200) {
          part.state.input = { _pruned: `[input removed — error was ${userTurns}+ turns ago]` }
          count++
        }
      }
    }

    return count
  }
}
