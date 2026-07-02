import { Tool } from "./tool"
import z from "zod"

export const PlanProposeTool = Tool.define("plan_propose", {
  description: `Surface a structured plan to the user via the TUI's Plan Review pane. Use this in plan mode INSTEAD of typing the plan into chat.

The user sees each step in a side pane and can accept the whole plan, reject individual steps with comments, or revise. On full acceptance the build agent takes over and executes.

Each step should be a small, concrete unit of work. Optionally include the files it touches and a one-line rationale.`,
  parameters: z.object({
    summary: z
      .string()
      .optional()
      .describe("Optional one-paragraph overview of what this plan accomplishes"),
    steps: z
      .array(
        z.object({
          text: z.string().describe("Short imperative description of this step"),
          files: z
            .array(z.string())
            .optional()
            .describe("Files this step will create or modify"),
          rationale: z
            .string()
            .optional()
            .describe("One-line reason this step is needed"),
        }),
      )
      .min(1)
      .describe("Ordered list of concrete steps that make up the plan"),
  }),
  async execute(params) {
    return {
      title: `Proposed plan: ${params.steps.length} steps`,
      output: `Plan with ${params.steps.length} step(s) sent to user. Wait for the user's decision (accept / revise) before continuing.`,
      metadata: { plan: params },
    }
  },
})
