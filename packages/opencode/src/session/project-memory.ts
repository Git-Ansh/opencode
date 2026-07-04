import fs from "fs/promises"
import path from "path"

// TODO(port): util/log.ts no longer exists — logging moved to Effect's Logger
// (packages/core/src/observability/logging.ts), which only wires up at the
// process-wide Logger level, not as a per-module logger these plain async
// functions can call into. Using a minimal local logger instead.
const log = {
  info: (message: string, extra?: Record<string, unknown>) => {
    if (process.env["OPENCODE_LOG_LEVEL"] === "DEBUG") console.error(`[project-memory] ${message}`, extra ?? "")
  },
}

// Note(port): this module used to resolve the project directory itself via
// `AppRuntime.runPromise(InstanceState.directory)`. That escape hatch runs the
// effect on the GLOBAL runtime, where the per-request InstanceRef context is
// not present, so every call died with "InstanceRef not provided" even when
// the original caller was inside an instance context. Callers (tool/memory.ts,
// session/prompt.ts) all run in Effect land inside the instance context, so
// they resolve `InstanceState.directory` there and pass it in as a plain
// argument instead — same fix as Notification.init(cfg) in project/bootstrap.ts.
export namespace ProjectMemory {
  function memoryDir(directory: string): string {
    return path.join(directory, ".opencode", "memory")
  }

  async function ensureDir(directory: string): Promise<string> {
    const dir = memoryDir(directory)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  function keyToFile(dir: string, key: string): string {
    // Sanitize key to safe filename
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
    return path.join(dir, `${safe}.md`)
  }

  export async function save(directory: string, key: string, content: string): Promise<void> {
    const dir = await ensureDir(directory)
    const filePath = keyToFile(dir, key)
    const header = `# ${key}\n_Updated: ${new Date().toISOString()}_\n\n`
    await fs.writeFile(filePath, header + content, "utf-8")
    log.info("saved memory", { key })
  }

  export async function get(directory: string, key: string): Promise<string | undefined> {
    try {
      const dir = memoryDir(directory)
      const content = await fs.readFile(keyToFile(dir, key), "utf-8")
      return content
    } catch {
      return undefined
    }
  }

  export async function remove(directory: string, key: string): Promise<void> {
    try {
      const dir = memoryDir(directory)
      await fs.unlink(keyToFile(dir, key))
    } catch {
      // ignore if not exists
    }
  }

  export async function list(directory: string): Promise<{ key: string; summary: string }[]> {
    const dir = await ensureDir(directory)
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

  export async function search(directory: string, query: string): Promise<{ key: string; content: string }[]> {
    const dir = await ensureDir(directory)
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
