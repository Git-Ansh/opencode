import fs from "fs/promises"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import type { AppRuntime as AppRuntimeType } from "@/effect/app-runtime"

// TODO(port): util/log.ts no longer exists — logging moved to Effect's Logger
// (packages/core/src/observability/logging.ts), which only wires up at the
// process-wide Logger level, not as a per-module logger these plain async
// functions can call into. Using a minimal local logger instead.
const log = {
  info: (message: string, extra?: Record<string, unknown>) => {
    if (process.env["OPENCODE_LOG_LEVEL"] === "DEBUG") console.error(`[project-memory] ${message}`, extra ?? "")
  },
}

// Note(port): `@/effect/app-runtime` assembles the entire Effect DI graph, and
// this module is reachable from *inside* that graph (tool/memory.ts registers
// as a tool in tool/registry.ts, which is itself part of the graph). A static
// top-level `import { AppRuntime }` here would close a circular-import loop
// back onto app-runtime.ts, throwing a "Cannot access ... before
// initialization" TDZ error at worker-thread module-load time. AppRuntime is
// only ever needed inside `directory()` (never at module scope), so loading
// it lazily via dynamic import breaks the cycle.
let appRuntimePromise: Promise<typeof AppRuntimeType> | undefined
function getAppRuntime(): Promise<typeof AppRuntimeType> {
  if (!appRuntimePromise) appRuntimePromise = import("@/effect/app-runtime").then((m) => m.AppRuntime)
  return appRuntimePromise
}

export namespace ProjectMemory {
  async function directory(): Promise<string> {
    const AppRuntime = await getAppRuntime()
    return AppRuntime.runPromise(InstanceState.directory)
  }

  async function memoryDir(): Promise<string> {
    return path.join(await directory(), ".opencode", "memory")
  }

  async function ensureDir(): Promise<string> {
    const dir = await memoryDir()
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  function keyToFile(dir: string, key: string): string {
    // Sanitize key to safe filename
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
    return path.join(dir, `${safe}.md`)
  }

  export async function save(key: string, content: string): Promise<void> {
    const dir = await ensureDir()
    const filePath = keyToFile(dir, key)
    const header = `# ${key}\n_Updated: ${new Date().toISOString()}_\n\n`
    await fs.writeFile(filePath, header + content, "utf-8")
    log.info("saved memory", { key })
  }

  export async function get(key: string): Promise<string | undefined> {
    try {
      const dir = await memoryDir()
      const content = await fs.readFile(keyToFile(dir, key), "utf-8")
      return content
    } catch {
      return undefined
    }
  }

  export async function remove(key: string): Promise<void> {
    try {
      const dir = await memoryDir()
      await fs.unlink(keyToFile(dir, key))
    } catch {
      // ignore if not exists
    }
  }

  export async function list(): Promise<{ key: string; summary: string }[]> {
    const dir = await ensureDir()
    const files = await fs.readdir(dir).catch(() => [])
    const result: { key: string; summary: string }[] = []

    for (const file of files) {
      if (!file.endsWith(".md")) continue
      try {
        const content = await fs.readFile(path.join(dir, file), "utf-8")
        const firstLine = content.split("\n").find((l) => l.startsWith("# "))
        const key = firstLine?.replace(/^#\s*/, "") ?? file.replace(".md", "")
        // Get first non-header, non-empty line as summary
        const lines = content.split("\n").filter((l) => !l.startsWith("#") && !l.startsWith("_") && l.trim())
        const summary = lines[0]?.slice(0, 100) ?? ""
        result.push({ key, summary })
      } catch {
        // skip
      }
    }

    return result
  }

  export async function search(query: string): Promise<{ key: string; content: string }[]> {
    const dir = await ensureDir()
    const files = await fs.readdir(dir).catch(() => [])
    const results: { key: string; content: string; score: number }[] = []
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)

    if (terms.length === 0) return []

    for (const file of files) {
      if (!file.endsWith(".md")) continue
      try {
        const content = await fs.readFile(path.join(dir, file), "utf-8")
        const lower = content.toLowerCase()
        let score = 0
        for (const term of terms) {
          const idx = lower.indexOf(term)
          if (idx >= 0) score++
        }
        if (score > 0) {
          const firstLine = content.split("\n").find((l) => l.startsWith("# "))
          const key = firstLine?.replace(/^#\s*/, "") ?? file.replace(".md", "")
          results.push({ key, content, score })
        }
      } catch {
        // skip
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 5)
  }
}
