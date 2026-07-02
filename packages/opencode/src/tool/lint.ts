import * as Tool from "./tool"
import { Schema, Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { InstanceState } from "@/effect/instance-state"

interface LinterConfig {
  name: string
  command: string
  detect: (cwd: string) => Promise<boolean>
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

async function pkgHasScript(cwd: string, scriptName: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf-8"))
    return scriptName in (pkg.scripts ?? {})
  } catch {
    return false
  }
}

const LINTERS: LinterConfig[] = [
  {
    name: "eslint",
    command: "npx eslint --format compact .",
    detect: async (cwd) =>
      (await fileExists(path.join(cwd, ".eslintrc"))) ||
      (await fileExists(path.join(cwd, ".eslintrc.js"))) ||
      (await fileExists(path.join(cwd, ".eslintrc.json"))) ||
      (await fileExists(path.join(cwd, "eslint.config.js"))) ||
      (await fileExists(path.join(cwd, "eslint.config.mjs"))) ||
      (await pkgHasScript(cwd, "lint")),
  },
  {
    name: "biome",
    command: "npx @biomejs/biome check .",
    detect: async (cwd) =>
      (await fileExists(path.join(cwd, "biome.json"))) || (await fileExists(path.join(cwd, "biome.jsonc"))),
  },
  {
    name: "ruff",
    command: "ruff check .",
    detect: async (cwd) =>
      (await fileExists(path.join(cwd, "pyproject.toml"))) || (await fileExists(path.join(cwd, "ruff.toml"))),
  },
  {
    name: "clippy",
    command: "cargo clippy --message-format=short 2>&1",
    detect: async (cwd) => await fileExists(path.join(cwd, "Cargo.toml")),
  },
  {
    name: "golangci-lint",
    command: "golangci-lint run --out-format=line-number",
    detect: async (cwd) =>
      (await fileExists(path.join(cwd, ".golangci.yml"))) ||
      (await fileExists(path.join(cwd, ".golangci.yaml"))) ||
      (await fileExists(path.join(cwd, "go.mod"))),
  },
]

export async function detectLinter(cwd: string): Promise<LinterConfig | undefined> {
  for (const linter of LINTERS) {
    try {
      if (await linter.detect(cwd)) return linter
    } catch {}
  }
  return undefined
}

const Parameters = Schema.Struct({
  command: Schema.optional(Schema.String).annotate({ description: "Custom lint command to run" }),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Specific files to lint (optional, defaults to whole project)",
  }),
})

// TODO(port): the original tool detected the linter once at tool-registration
// time so it could bake "Detected linter: X" straight into the static
// `description` shown to the LLM. Tool `Tool.define` init Effects are no
// longer guaranteed to run scoped to a specific project instance (that
// scoping now happens via InstanceState/location services wired up by the
// tool registry — out of scope here per the port plan), so detection is done
// per-call instead. This is arguably more correct in a multi-instance/
// workspace world (a different cwd could have a different linter), but it
// means the tool description below is generic rather than dynamically
// naming the detected linter up front.
export const LintTool = Tool.define(
  "lint",
  Effect.succeed({
    description: `Run the project's linter to check for errors and style issues. Auto-detects eslint, biome, ruff, clippy, or golangci-lint; you can also specify a custom command.

Use this after making code changes to catch errors immediately. The output is structured for easy parsing.`,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const cwd = (yield* InstanceState.context).directory
        const detected = yield* Effect.promise(() => detectLinter(cwd))
        const cmd = params.command ?? detected?.command
        if (!cmd) {
          return {
            title: "No linter found",
            metadata: {} as Record<string, any>,
            output:
              "No linter detected. Looked for: eslint, biome, ruff, clippy, golangci-lint. Provide a custom command or install a linter.",
          }
        }

        yield* ctx.ask({
          permission: "bash",
          patterns: [cmd.split(" ")[0]],
          always: ["*"],
          metadata: { command: cmd, type: "lint" },
        })

        const finalCmd = params.files?.length ? `${cmd} ${params.files.join(" ")}` : cmd

        // TODO(port): Bun's `$` shell no longer exposes a `.timeout()` method on
        // ShellPromise in this bun-types version (checked node_modules/bun-types).
        // The modern bash tool (tool/shell.ts) enforces timeouts by racing the
        // command against `Effect.sleep`, so we do the same here. Caveat: unlike
        // the old `.timeout()` (which killed the process), racing only stops us
        // from *waiting* on it — an orphaned `bash -c` process can keep running
        // in the background if this fires. Acceptable for a first port pass, but
        // worth revisiting alongside tool/shell.ts's timeout handling.
        const result = yield* Effect.race(
          Effect.promise(async () => {
            const { $ } = await import("bun")
            return $`bash -c ${finalCmd}`.quiet().cwd(cwd).nothrow()
          }),
          Effect.sleep("60 seconds").pipe(
            Effect.flatMap(() => Effect.fail(new Error(`lint command timed out after 60s: ${finalCmd}`))),
          ),
        )

        const stdout = result.stdout.toString().trim()
        const stderr = result.stderr.toString().trim()
        const output = [stdout, stderr].filter(Boolean).join("\n")

        const hasErrors = result.exitCode !== 0

        return {
          title: hasErrors ? `Lint: ${detected?.name ?? "custom"} found issues` : `Lint: clean`,
          metadata: {
            exitCode: result.exitCode,
            linter: detected?.name ?? "custom",
            hasErrors,
          },
          output: output || (hasErrors ? `Linter exited with code ${result.exitCode}` : "No lint errors found."),
        }
      }).pipe(Effect.orDie),
  }),
)
