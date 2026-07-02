import { Tool } from "./tool"
import z from "zod"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.lint" })

interface LinterConfig {
  name: string
  command: string
  detect: () => Promise<boolean>
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

async function pkgHasScript(scriptName: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(Instance.directory, "package.json"), "utf-8"))
    return scriptName in (pkg.scripts ?? {})
  } catch {
    return false
  }
}

const LINTERS: LinterConfig[] = [
  {
    name: "eslint",
    command: "npx eslint --format compact .",
    detect: async () =>
      (await fileExists(path.join(Instance.directory, ".eslintrc"))) ||
      (await fileExists(path.join(Instance.directory, ".eslintrc.js"))) ||
      (await fileExists(path.join(Instance.directory, ".eslintrc.json"))) ||
      (await fileExists(path.join(Instance.directory, "eslint.config.js"))) ||
      (await fileExists(path.join(Instance.directory, "eslint.config.mjs"))) ||
      (await pkgHasScript("lint")),
  },
  {
    name: "biome",
    command: "npx @biomejs/biome check .",
    detect: async () => (await fileExists(path.join(Instance.directory, "biome.json"))) || (await fileExists(path.join(Instance.directory, "biome.jsonc"))),
  },
  {
    name: "ruff",
    command: "ruff check .",
    detect: async () =>
      (await fileExists(path.join(Instance.directory, "pyproject.toml"))) ||
      (await fileExists(path.join(Instance.directory, "ruff.toml"))),
  },
  {
    name: "clippy",
    command: "cargo clippy --message-format=short 2>&1",
    detect: async () => await fileExists(path.join(Instance.directory, "Cargo.toml")),
  },
  {
    name: "golangci-lint",
    command: "golangci-lint run --out-format=line-number",
    detect: async () =>
      (await fileExists(path.join(Instance.directory, ".golangci.yml"))) ||
      (await fileExists(path.join(Instance.directory, ".golangci.yaml"))) ||
      (await fileExists(path.join(Instance.directory, "go.mod"))),
  },
]

export async function detectLinter(): Promise<LinterConfig | undefined> {
  for (const linter of LINTERS) {
    try {
      if (await linter.detect()) return linter
    } catch {}
  }
  return undefined
}

export const LintTool = Tool.define("lint", async () => {
  const detected = await detectLinter()
  return {
    description: `Run the project's linter to check for errors and style issues.${detected ? ` Detected linter: ${detected.name}.` : " No linter auto-detected — you can specify a custom command."}

Use this after making code changes to catch errors immediately. The output is structured for easy parsing.`,
    parameters: z.object({
      command: z
        .string()
        .optional()
        .describe(`Custom lint command to run. Auto-detected: ${detected?.command ?? "none"}`),
      files: z
        .array(z.string())
        .optional()
        .describe("Specific files to lint (optional, defaults to whole project)"),
    }),
    async execute(params, ctx) {
      const cmd = params.command ?? detected?.command
      if (!cmd) {
        return {
          title: "No linter found",
          metadata: {},
          output:
            "No linter detected. Looked for: eslint, biome, ruff, clippy, golangci-lint. Provide a custom command or install a linter.",
        }
      }

      await ctx.ask({
        permission: "bash",
        patterns: [cmd.split(" ")[0]],
        always: ["*"],
        metadata: { command: cmd, type: "lint" },
      })

      const finalCmd = params.files?.length ? `${cmd} ${params.files.join(" ")}` : cmd

      const { $ } = await import("bun")
      const result = await $`bash -c ${finalCmd}`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()
        .timeout(60000)

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
    },
  }
})
