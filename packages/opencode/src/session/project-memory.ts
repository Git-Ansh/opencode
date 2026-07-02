import fs from "fs/promises"
import path from "path"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

export namespace ProjectMemory {
  const log = Log.create({ service: "project-memory" })

  function memoryDir(): string {
    return path.join(Instance.directory, ".opencode", "memory")
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(memoryDir(), { recursive: true })
  }

  function keyToFile(key: string): string {
    // Sanitize key to safe filename
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
    return path.join(memoryDir(), `${safe}.md`)
  }

  export async function save(key: string, content: string): Promise<void> {
    await ensureDir()
    const filePath = keyToFile(key)
    const header = `# ${key}\n_Updated: ${new Date().toISOString()}_\n\n`
    await fs.writeFile(filePath, header + content, "utf-8")
    log.info("saved memory", { key })
  }

  export async function get(key: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(keyToFile(key), "utf-8")
      return content
    } catch {
      return undefined
    }
  }

  export async function remove(key: string): Promise<void> {
    try {
      await fs.unlink(keyToFile(key))
    } catch {
      // ignore if not exists
    }
  }

  export async function list(): Promise<{ key: string; summary: string }[]> {
    await ensureDir()
    const files = await fs.readdir(memoryDir()).catch(() => [])
    const result: { key: string; summary: string }[] = []

    for (const file of files) {
      if (!file.endsWith(".md")) continue
      try {
        const content = await fs.readFile(path.join(memoryDir(), file), "utf-8")
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
    await ensureDir()
    const files = await fs.readdir(memoryDir()).catch(() => [])
    const results: { key: string; content: string; score: number }[] = []
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)

    if (terms.length === 0) return []

    for (const file of files) {
      if (!file.endsWith(".md")) continue
      try {
        const content = await fs.readFile(path.join(memoryDir(), file), "utf-8")
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
