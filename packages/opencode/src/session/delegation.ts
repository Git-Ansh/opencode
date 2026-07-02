import { Log } from "../util/log"
import { Global } from "../global"
import path from "path"
import fs from "fs/promises"

export namespace Delegation {
  const log = Log.create({ service: "delegation" })

  export interface Entry {
    id: string
    sessionID: string
    agentSessionID: string
    title: string
    prompt: string
    agent: string
    status: "running" | "completed" | "error"
    summary?: string
    output?: string
    startTime: number
    endTime?: number
  }

  const dir = path.join(Global.Path.data, "delegations")
  const entries = new Map<string, Entry>()

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true })
  }

  function filePath(id: string) {
    return path.join(dir, `${id}.json`)
  }

  export async function save(entry: Entry): Promise<void> {
    entries.set(entry.id, entry)
    await ensureDir()
    await fs.writeFile(filePath(entry.id), JSON.stringify(entry, null, 2))
  }

  export async function get(id: string): Promise<Entry | undefined> {
    if (entries.has(id)) return entries.get(id)
    try {
      const data = await fs.readFile(filePath(id), "utf-8")
      const entry = JSON.parse(data) as Entry
      entries.set(id, entry)
      return entry
    } catch {
      return undefined
    }
  }

  export async function list(sessionID: string): Promise<Entry[]> {
    await ensureDir()
    const files = await fs.readdir(dir).catch(() => [])
    const result: Entry[] = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      try {
        const data = await fs.readFile(path.join(dir, file), "utf-8")
        const entry = JSON.parse(data) as Entry
        if (entry.sessionID === sessionID) {
          entries.set(entry.id, entry)
          result.push(entry)
        }
      } catch {
        // skip corrupted files
      }
    }
    return result
  }

  export async function update(id: string, patch: Partial<Entry>): Promise<void> {
    const entry = await get(id)
    if (!entry) return
    Object.assign(entry, patch)
    entries.set(id, entry)
    await ensureDir()
    await fs.writeFile(filePath(id), JSON.stringify(entry, null, 2))
  }
}
