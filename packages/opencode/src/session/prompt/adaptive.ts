import { Instance } from "../../project/instance"
import path from "path"

import MOD_TYPESCRIPT from "./modules/typescript.txt"
import MOD_PYTHON from "./modules/python.txt"
import MOD_RUST from "./modules/rust.txt"
import MOD_REACT from "./modules/react.txt"
import MOD_NEXTJS from "./modules/nextjs.txt"
import MOD_DEBUGGING from "./modules/debugging.txt"
import MOD_REFACTORING from "./modules/refactoring.txt"
import MOD_TESTING from "./modules/testing.txt"

export namespace AdaptivePrompt {
  interface ProjectInfo {
    languages: string[]
    frameworks: string[]
  }

  const cache = new Map<string, ProjectInfo>()

  export async function detect(): Promise<ProjectInfo> {
    const dir = Instance.worktree
    const cached = cache.get(dir)
    if (cached) return cached

    const languages: string[] = []
    const frameworks: string[] = []

    // Check for language indicators
    const checks = await Promise.all([
      fileExists(dir, "tsconfig.json"),
      fileExists(dir, "package.json"),
      fileExists(dir, "Cargo.toml"),
      fileExists(dir, "pyproject.toml"),
      fileExists(dir, "go.mod"),
      fileExists(dir, "setup.py"),
      fileExists(dir, "requirements.txt"),
    ])

    if (checks[0] || checks[1]) {
      if (checks[0]) languages.push("typescript")
      else languages.push("javascript")
    }
    if (checks[2]) languages.push("rust")
    if (checks[3] || checks[5] || checks[6]) languages.push("python")
    if (checks[4]) languages.push("go")

    // Check package.json for frameworks
    if (checks[1]) {
      try {
        const pkg = await Bun.file(path.join(dir, "package.json")).json()
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        if (deps["react"] || deps["react-dom"]) frameworks.push("react")
        if (deps["next"]) frameworks.push("nextjs")
        if (deps["vue"]) frameworks.push("vue")
        if (deps["svelte"]) frameworks.push("svelte")
        if (deps["express"]) frameworks.push("express")
        if (deps["solid-js"]) frameworks.push("solidjs")
      } catch {}
    }

    const info = { languages, frameworks }
    cache.set(dir, info)
    return info
  }

  export function classifyTask(recentMessages: string[]): string | undefined {
    const text = recentMessages.join(" ").toLowerCase()
    const patterns: [string, string[]][] = [
      [
        "debugging",
        ["bug", "error", "fix", "broken", "crash", "fail", "issue", "wrong", "debug", "stack trace", "exception"],
      ],
      ["testing", ["test", "spec", "coverage", "assert", "mock", "stub", "unit test", "integration test"]],
      [
        "refactoring",
        ["refactor", "clean up", "cleanup", "restructure", "reorganize", "simplify", "extract", "rename"],
      ],
    ]

    for (const [mode, keywords] of patterns) {
      const matches = keywords.filter((k) => text.includes(k)).length
      if (matches >= 2) return mode
    }
    return undefined
  }

  export async function compose(recentMessages: string[]): Promise<string[]> {
    const project = await detect()
    const task = classifyTask(recentMessages)
    const parts: string[] = []

    // Language modules
    const langMap: Record<string, string> = {
      typescript: MOD_TYPESCRIPT,
      python: MOD_PYTHON,
      rust: MOD_RUST,
    }
    for (const lang of project.languages) {
      const mod = langMap[lang]
      if (mod) parts.push(mod.trim())
    }

    // Framework modules
    const fwMap: Record<string, string> = {
      react: MOD_REACT,
      nextjs: MOD_NEXTJS,
    }
    for (const fw of project.frameworks) {
      const mod = fwMap[fw]
      if (mod) parts.push(mod.trim())
    }

    // Task mode
    const taskMap: Record<string, string> = {
      debugging: MOD_DEBUGGING,
      refactoring: MOD_REFACTORING,
      testing: MOD_TESTING,
    }
    if (task) {
      const mod = taskMap[task]
      if (mod) parts.push(mod.trim())
    }

    if (!parts.length) return []

    // Budget: max ~2K tokens worth of text (rough estimate: 4 chars per token)
    const MAX_CHARS = 8000
    let total = 0
    const result: string[] = []
    for (const part of parts) {
      if (total + part.length > MAX_CHARS) break
      result.push(part)
      total += part.length
    }

    return result.length ? [`<adaptive-context>\n${result.join("\n\n")}\n</adaptive-context>`] : []
  }

  async function fileExists(dir: string, name: string): Promise<boolean> {
    try {
      return await Bun.file(path.join(dir, name)).exists()
    } catch {
      return false
    }
  }
}
