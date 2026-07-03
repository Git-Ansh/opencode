import fs from "fs/promises"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import type { AppRuntime as AppRuntimeType } from "@/effect/app-runtime"

// Note(port): the original `util/log.ts` Log.create({service}) logger no longer
// exists (logging moved to Effect's Logger under packages/core/src/observability),
// and this module never actually logged anything, so the import is just dropped.
//
// Note(port): `@/effect/app-runtime` assembles the entire Effect DI graph, and
// this module is reachable from *inside* that graph (session/llm/request.ts ->
// session/system.ts -> here). A static top-level `import { AppRuntime }` would
// close a circular-import loop back onto app-runtime.ts, throwing a "Cannot
// access ... before initialization" TDZ error at worker-thread module-load
// time. AppRuntime is only ever needed inside `gather()` (never at module
// scope), so loading it lazily via dynamic import breaks the cycle.
let appRuntimePromise: Promise<typeof AppRuntimeType> | undefined
function getAppRuntime(): Promise<typeof AppRuntimeType> {
  if (!appRuntimePromise) appRuntimePromise = import("@/effect/app-runtime").then((m) => m.AppRuntime)
  return appRuntimePromise
}

export namespace ContextInjection {
  const MAX_TOKENS = 4000
  const CHARS_PER_TOKEN = 4

  interface Source {
    type: string
    content: string
    priority: number
  }

  export async function gather(): Promise<string[]> {
    const AppRuntime = await getAppRuntime()
    const ctx = await AppRuntime.runPromise(InstanceState.context)
    // Non-git projects have worktree="/", avoid running git commands with cwd: "/"
    if (ctx.project.vcs !== "git") return []

    const sources: Source[] = []
    const dir = ctx.directory

    // Git diff summary
    try {
      const result = await AppRuntime.runPromise(Git.Service.use((git) => git.run(["diff", "--stat", "HEAD"], { cwd: dir })))
      if (result.exitCode === 0) {
        const text = result.text().trim()
        if (text) {
          sources.push({ type: "git_diff", content: text, priority: 1 })
        }
      }
    } catch {}

    // Git status
    try {
      const result = await AppRuntime.runPromise(Git.Service.use((git) => git.run(["status", "--short"], { cwd: dir })))
      if (result.exitCode === 0) {
        const text = result.text().trim()
        if (text) {
          sources.push({ type: "git_status", content: text, priority: 2 })
        }
      }
    } catch {}

    // package.json summary
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"))
      const scripts = Object.keys(pkg.scripts ?? {}).join(", ")
      const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 15).join(", ")
      const devDeps = Object.keys(pkg.devDependencies ?? {}).slice(0, 10).join(", ")
      const lines = [`name: ${pkg.name ?? "unknown"}`]
      if (scripts) lines.push(`scripts: ${scripts}`)
      if (deps) lines.push(`dependencies: ${deps}`)
      if (devDeps) lines.push(`devDependencies: ${devDeps}`)
      sources.push({ type: "package_json", content: lines.join("\n"), priority: 3 })
    } catch {}

    // README.md first 500 chars
    try {
      const readme = await fs.readFile(path.join(dir, "README.md"), "utf-8")
      const text = readme.slice(0, 500).trim()
      if (text) {
        sources.push({ type: "readme", content: text + (readme.length > 500 ? "\n[truncated]" : ""), priority: 4 })
      }
    } catch {}

    // Makefile / Justfile targets
    try {
      let makeContent: string | undefined
      for (const name of ["Makefile", "justfile", "Justfile"]) {
        try {
          makeContent = await fs.readFile(path.join(dir, name), "utf-8")
          break
        } catch {}
      }
      if (makeContent) {
        const targets = makeContent
          .split("\n")
          .filter((l) => /^[a-zA-Z_][\w-]*\s*:/.test(l))
          .map((l) => l.split(":")[0].trim())
          .join(", ")
        if (targets) {
          sources.push({ type: "makefile_targets", content: targets, priority: 5 })
        }
      }
    } catch {}

    // .env.example expected vars
    try {
      const envExample = await fs.readFile(path.join(dir, ".env.example"), "utf-8")
      const vars = envExample
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l.trim()))
        .map((l) => l.trim().split("=")[0])
        .join(", ")
      if (vars) {
        sources.push({ type: "env_example", content: `Expected env vars: ${vars}`, priority: 6 })
      }
    } catch {}

    sources.sort((a, b) => a.priority - b.priority)

    const maxChars = MAX_TOKENS * CHARS_PER_TOKEN
    let total = 0
    const result: string[] = []

    for (const source of sources) {
      const remaining = maxChars - total
      if (remaining <= 0) break
      const content =
        source.content.length > remaining ? source.content.slice(0, remaining) + "\n[truncated]" : source.content
      result.push(`<context-injection type="${source.type}">\n${content}\n</context-injection>`)
      total += content.length
    }

    return result
  }
}
