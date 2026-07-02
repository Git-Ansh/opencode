import { Schema, Effect } from "effect"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  summary: Schema.optional(Schema.String).annotate({
    description: "Optional one-paragraph overview of what this plan accomplishes",
  }),
  steps: Schema.Array(
    Schema.Struct({
      text: Schema.String.annotate({ description: "Short imperative description of this step" }),
      files: Schema.optional(Schema.Array(Schema.String)).annotate({
        description: "Files this step will create or modify",
      }),
      rationale: Schema.optional(Schema.String).annotate({
        description: "One-line reason this step is needed",
      }),
    }),
  )
    .check(Schema.isMinLength(1))
    .annotate({ description: "Ordered list of concrete steps that make up the plan" }),
})

export const PlanProposeTool = Tool.define(
  "plan_propose",
  Effect.succeed({
    description: `Surface a structured plan to the user via the TUI's Plan Review pane. Use this in plan mode INSTEAD of typing the plan into chat.

The user sees each step in a side pane and can accept the whole plan, reject individual steps with comments, or revise. On full acceptance the build agent takes over and executes.

Each step should be a small, concrete unit of work. Optionally include the files it touches and a one-line rationale.`,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>) =>
      Effect.succeed({
        title: `Proposed plan: ${params.steps.length} steps`,
        output: `Plan with ${params.steps.length} step(s) sent to user. Wait for the user's decision (accept / revise) before continuing.`,
        metadata: { plan: params },
      }),
  }),
)
