import path from "path"
import { Schema, Effect } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { Process } from "@/util/process"
import DESCRIPTION from "./test.txt"

type Framework = "vitest" | "jest" | "bun" | "pytest" | "cargo" | "go"

interface Failure {
  name: string
  file: string
  error: string
}

interface Result {
  framework: string
  passed: number
  failed: number
  skipped: number
  duration: string
  failures: Failure[]
  raw: string
}

async function exists(filepath: string): Promise<boolean> {
  return Bun.file(filepath)
    .exists()
    .catch(() => false)
}

async function detect(cwd: string): Promise<Framework | undefined> {
  const pkg = path.join(cwd, "package.json")
  if (await exists(pkg)) {
    const content = await Bun.file(pkg).json().catch(() => ({}))

    if (content.scripts?.test) {
      const cmd = content.scripts.test as string
      if (cmd.includes("vitest")) return "vitest"
      if (cmd.includes("jest")) return "jest"
      if (cmd.includes("bun test")) return "bun"
    }

    const deps = { ...content.devDependencies, ...content.dependencies }
    if (deps.vitest) return "vitest"
    if (deps.jest) return "jest"
    if (deps.mocha) return "jest"
  }

  if (await exists(path.join(cwd, "Cargo.toml"))) return "cargo"
  if (await exists(path.join(cwd, "pyproject.toml"))) return "pytest"
  if (await exists(path.join(cwd, "pytest.ini"))) return "pytest"
  if (await exists(path.join(cwd, "go.mod"))) return "go"

  return undefined
}

function command(fw: Framework, filepath?: string, filter?: string): string[] {
  switch (fw) {
    case "vitest": {
      const args = ["npx", "vitest", "run", "--reporter=verbose"]
      if (filter) args.push("-t", filter)
      if (filepath) args.push(filepath)
      return args
    }
    case "jest": {
      const args = ["npx", "jest", "--verbose"]
      if (filter) args.push("-t", filter)
      if (filepath) args.push(filepath)
      return args
    }
    case "bun": {
      const args = ["bun", "test"]
      if (filter) args.push("--grep", filter)
      if (filepath) args.push(filepath)
      return args
    }
    case "pytest": {
      const args = ["pytest", "-v"]
      if (filter) args.push("-k", filter)
      if (filepath) args.push(filepath)
      return args
    }
    case "cargo": {
      const args = ["cargo", "test"]
      if (filter) args.push(filter)
      if (filepath) args.push("--", "--test-threads=1")
      return args
    }
    case "go": {
      const target = filepath ? `./${filepath}/...` : "./..."
      const args = ["go", "test", "-v", target]
      if (filter) args.push("-run", filter)
      return args
    }
  }
}

function parseVitest(output: string): Partial<Result> {
  let passed = 0
  let failed = 0
  let skipped = 0
  let duration = ""
  const failures: Failure[] = []

  const summary = output.match(/Tests\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed/i)
  if (summary) {
    failed = parseInt(summary[1], 10)
    passed = parseInt(summary[2], 10)
  } else {
    const pass = output.match(/(\d+)\s+passed/i)
    const fail = output.match(/(\d+)\s+failed/i)
    if (pass) passed = parseInt(pass[1], 10)
    if (fail) failed = parseInt(fail[1], 10)
  }

  const skip = output.match(/(\d+)\s+skipped/i)
  if (skip) skipped = parseInt(skip[1], 10)

  const dur = output.match(/Duration\s+([\d.]+\s*\w+)/i) || output.match(/Time:\s+([\d.]+\s*\w+)/i)
  if (dur) duration = dur[1]

  const failBlocks = output.matchAll(/FAIL\s+(.+?)(?:\s+>\s+(.+))?\n[\s\S]*?(?:Error|AssertionError):\s*(.+)/g)
  for (const block of failBlocks) {
    failures.push({
      file: block[1].trim(),
      name: block[2]?.trim() || "",
      error: block[3].trim(),
    })
  }

  return { passed, failed, skipped, duration, failures }
}

function parsePytest(output: string): Partial<Result> {
  let passed = 0
  let failed = 0
  let skipped = 0
  let duration = ""
  const failures: Failure[] = []

  const counts = output.match(/(\d+)\s+passed/i)
  if (counts) passed = parseInt(counts[1], 10)
  const fail = output.match(/(\d+)\s+failed/i)
  if (fail) failed = parseInt(fail[1], 10)
  const skip = output.match(/(\d+)\s+skipped/i)
  if (skip) skipped = parseInt(skip[1], 10)
  const err = output.match(/(\d+)\s+error/i)
  if (err) failed += parseInt(err[1], 10)

  const dur = output.match(/in\s+([\d.]+s)/i)
  if (dur) duration = dur[1]

  const failBlocks = output.matchAll(/FAILED\s+(\S+)::(\S+)/g)
  for (const block of failBlocks) {
    failures.push({ file: block[1], name: block[2], error: "" })
  }

  return { passed, failed, skipped, duration, failures }
}

function parseCargo(output: string): Partial<Result> {
  let passed = 0
  let failed = 0
  let skipped = 0
  let duration = ""
  const failures: Failure[] = []

  const result = output.match(/test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/)
  if (result) {
    passed = parseInt(result[1], 10)
    failed = parseInt(result[2], 10)
    skipped = parseInt(result[3], 10)
  }

  const dur = output.match(/finished in\s+([\d.]+s)/i)
  if (dur) duration = dur[1]

  const failLines = output.matchAll(/test\s+(\S+)\s+\.\.\.\s+FAILED/g)
  for (const line of failLines) {
    failures.push({ name: line[1], file: "", error: "" })
  }

  return { passed, failed, skipped, duration, failures }
}

function parseGo(output: string): Partial<Result> {
  let passed = 0
  let failed = 0
  let skipped = 0
  let duration = ""
  const failures: Failure[] = []

  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    if (line.match(/^ok\s+/)) passed++
    if (line.match(/^FAIL\s+/)) {
      failed++
      const m = line.match(/^FAIL\s+(\S+)/)
      if (m) failures.push({ name: m[1], file: "", error: "" })
    }
    if (line.includes("--- PASS")) passed++
    if (line.includes("--- FAIL")) {
      const m = line.match(/--- FAIL:\s+(\S+)/)
      if (m) failures.push({ name: m[1], file: "", error: "" })
    }
    if (line.includes("--- SKIP")) skipped++
  }

  const dur = output.match(/ok\s+\S+\s+([\d.]+s)/)
  if (dur) duration = dur[1]

  return { passed, failed, skipped, duration, failures }
}

function parse(fw: Framework, output: string): Partial<Result> {
  switch (fw) {
    case "vitest":
    case "jest":
    case "bun":
      return parseVitest(output)
    case "pytest":
      return parsePytest(output)
    case "cargo":
      return parseCargo(output)
    case "go":
      return parseGo(output)
  }
}

const Parameters = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({ description: "Specific test file or directory" }),
  filter: Schema.optional(Schema.String).annotate({ description: "Test name filter/grep pattern" }),
  framework: Schema.optional(Schema.String).annotate({
    description: "Override auto-detection: vitest, jest, bun, pytest, cargo, go",
  }),
})

export const TestTool = Tool.define(
  "test",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const cwd = (yield* InstanceState.context).directory
        const fw = (params.framework as Framework) || (yield* Effect.promise(() => detect(cwd)))
        if (!fw) throw new Error("Could not detect test framework. Please specify the `framework` parameter.")

        const cmd = command(fw, params.path, params.filter)

        yield* ctx.ask({
          permission: "bash",
          patterns: [cmd.join(" ")],
          always: [cmd[0] + " *"],
          metadata: { framework: fw, path: params.path, filter: params.filter },
        })

        const result = yield* Effect.promise(() => Process.run(cmd, { cwd, nothrow: true }))
        const output = result.stdout.toString() + result.stderr.toString()
        const parsed = parse(fw, output)

        const structured: Result = {
          framework: fw,
          passed: parsed.passed || 0,
          failed: parsed.failed || 0,
          skipped: parsed.skipped || 0,
          duration: parsed.duration || "",
          failures: parsed.failures || [],
          raw: output,
        }

        return {
          title: `test ${fw}${params.path ? ` ${params.path}` : ""}`,
          output: JSON.stringify(structured, null, 2),
          metadata: {
            framework: fw,
            passed: structured.passed,
            failed: structured.failed,
            skipped: structured.skipped,
            duration: structured.duration,
          },
        }
      }).pipe(Effect.orDie),
  }),
)
