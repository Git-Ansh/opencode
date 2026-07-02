import { Schema, Effect } from "effect"
import * as Tool from "./tool"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./git.txt"

const Parameters = Schema.Struct({
  action: Schema.Literals(["status", "diff", "log", "branch", "show", "stash_list"]),
  args: Schema.optional(Schema.String).annotate({
    description: "Additional arguments (e.g., commit hash for show, file path for diff)",
  }),
})

function parseStatus(raw: string) {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean)
  let branch = ""
  let ahead = 0
  let behind = 0
  const staged: { file: string; status: string }[] = []
  const unstaged: { file: string; status: string }[] = []
  const untracked: string[] = []

  for (const line of lines) {
    if (line.startsWith("##")) {
      const match = line.match(/^## (\S+?)(?:\.\.\.(\S+))?/)
      if (match) branch = match[1]
      const aheadMatch = line.match(/ahead (\d+)/)
      const behindMatch = line.match(/behind (\d+)/)
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10)
      if (behindMatch) behind = parseInt(behindMatch[1], 10)
      continue
    }
    const x = line[0]
    const y = line[1]
    const file = line.slice(3)
    if (x === "?" && y === "?") {
      untracked.push(file)
    } else {
      if (x !== " " && x !== "?") staged.push({ file, status: x })
      if (y !== " " && y !== "?") unstaged.push({ file, status: y })
    }
  }

  return { branch, ahead, behind, staged, unstaged, untracked }
}

function parseDiff(raw: string) {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean)
  const files: { path: string; additions: number; deletions: number }[] = []
  let summary = ""

  for (const line of lines) {
    const stat = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+(\+*)(-*)/)
    if (stat) {
      files.push({
        path: stat[1].trim(),
        additions: stat[3].length,
        deletions: stat[4].length,
      })
      continue
    }
    if (line.match(/^\s*\d+ files? changed/)) {
      summary = line.trim()
    }
  }

  return { files, summary }
}

function parseLog(raw: string) {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean)
  return lines.map((line) => {
    const match = line.match(/^([a-f0-9]+)\s+(?:\(([^)]+)\)\s+)?(.*)/)
    if (!match) return { hash: "", message: line, refs: "" }
    return { hash: match[1], refs: match[2] || "", message: match[3] }
  })
}

function parseBranch(raw: string) {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean)
  let current = ""
  const branches: { name: string; upstream: string; ahead: number; behind: number }[] = []

  for (const line of lines) {
    const active = line.startsWith("*")
    const trimmed = line.replace(/^\*?\s+/, "")
    const match = trimmed.match(/^(\S+)\s+[a-f0-9]+\s+(?:\[([^\]]+)\]\s+)?/)
    if (!match) continue
    const name = match[1]
    if (active) current = name
    let upstream = ""
    let ahead = 0
    let behind = 0
    if (match[2]) {
      const parts = match[2].split(":")
      upstream = parts[0].trim()
      const aheadMatch = match[2].match(/ahead (\d+)/)
      const behindMatch = match[2].match(/behind (\d+)/)
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10)
      if (behindMatch) behind = parseInt(behindMatch[1], 10)
    }
    branches.push({ name, upstream, ahead, behind })
  }

  return { current, branches }
}

function parseShow(raw: string) {
  const lines = raw.trim().split(/\r?\n/)
  let hash = ""
  let author = ""
  let date = ""
  const msg: string[] = []
  const files: string[] = []
  let inBody = false

  for (const line of lines) {
    if (line.startsWith("commit ")) {
      hash = line.slice(7).trim()
      continue
    }
    if (line.startsWith("Author:")) {
      author = line.slice(7).trim()
      continue
    }
    if (line.startsWith("Date:")) {
      date = line.slice(5).trim()
      inBody = true
      continue
    }
    if (inBody && line.match(/^\s+\S/)) {
      msg.push(line.trim())
      continue
    }
    if (line.match(/^\s*.+\|\s+\d+/)) {
      const m = line.match(/^\s*(.+?)\s+\|/)
      if (m) files.push(m[1].trim())
    }
  }

  return { hash, author, date, message: msg.join("\n"), files }
}

function parseStash(raw: string) {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean)
  return lines.map((line) => {
    const match = line.match(/^stash@\{(\d+)\}:\s*(.*)/)
    if (!match) return { index: 0, message: line }
    return { index: parseInt(match[1], 10), message: match[2] }
  })
}

export const GitTool = Tool.define(
  "git",
  Effect.gen(function* () {
    const git = yield* Git.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cwd = (yield* InstanceState.context).worktree
          const extra = params.args ? params.args.split(/\s+/) : []

          yield* ctx.ask({
            permission: "git",
            patterns: [params.action],
            always: ["*"],
            metadata: { action: params.action, args: params.args },
          })

          switch (params.action) {
            case "status": {
              const result = yield* git.run(["status", "--porcelain=v1", "-b"], { cwd })
              if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderr.toString()}`)
              const parsed = parseStatus(result.text())
              return {
                title: "git status",
                output: JSON.stringify(parsed, null, 2),
                metadata: parsed as Record<string, any>,
              }
            }

            case "diff": {
              const args = ["diff", "--stat", ...extra]
              const stat = yield* git.run(args, { cwd })
              if (stat.exitCode !== 0) throw new Error(`git diff failed: ${stat.stderr.toString()}`)
              const parsed = parseDiff(stat.text())

              const full = yield* git.run(["diff", ...extra], { cwd })
              const text = full.text()

              const output = {
                ...parsed,
                diff: text,
              }
              return {
                title: "git diff",
                output: JSON.stringify(output, null, 2),
                metadata: { files: parsed.files.length, summary: parsed.summary } as Record<string, any>,
              }
            }

            case "log": {
              const args = extra.length
                ? ["log", "--oneline", "--decorate", ...extra]
                : ["log", "--oneline", "--decorate", "-n", "20"]
              const result = yield* git.run(args, { cwd })
              if (result.exitCode !== 0) throw new Error(`git log failed: ${result.stderr.toString()}`)
              const parsed = parseLog(result.text())
              return {
                title: "git log",
                output: JSON.stringify(parsed, null, 2),
                metadata: { count: parsed.length } as Record<string, any>,
              }
            }

            case "branch": {
              const result = yield* git.run(["branch", "-vv"], { cwd })
              if (result.exitCode !== 0) throw new Error(`git branch failed: ${result.stderr.toString()}`)
              const parsed = parseBranch(result.text())
              return {
                title: "git branch",
                output: JSON.stringify(parsed, null, 2),
                metadata: parsed as Record<string, any>,
              }
            }

            case "show": {
              if (extra.length === 0) throw new Error("show requires a commit hash argument")
              const result = yield* git.run(["show", "--stat", ...extra], { cwd })
              if (result.exitCode !== 0) throw new Error(`git show failed: ${result.stderr.toString()}`)
              const parsed = parseShow(result.text())
              return {
                title: `git show ${extra[0]}`,
                output: JSON.stringify(parsed, null, 2),
                metadata: parsed as Record<string, any>,
              }
            }

            case "stash_list": {
              const result = yield* git.run(["stash", "list"], { cwd })
              if (result.exitCode !== 0) throw new Error(`git stash list failed: ${result.stderr.toString()}`)
              const raw = result.text().trim()
              if (!raw) {
                return {
                  title: "git stash list",
                  output: JSON.stringify([], null, 2),
                  metadata: { count: 0 } as Record<string, any>,
                }
              }
              const parsed = parseStash(raw)
              return {
                title: "git stash list",
                output: JSON.stringify(parsed, null, 2),
                metadata: { count: parsed.length } as Record<string, any>,
              }
            }
            default:
              throw new Error(`Unknown git action: ${params.action}`)
          }
        }).pipe(Effect.orDie),
    }
  }),
)
