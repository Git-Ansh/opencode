import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          // "Tell me more": the TUI sends this sentinel answer when the user asks to see
          // an option's `detail` field before deciding (see tool/question.txt).
          // TODO(port): the TUI-side trigger (pressing `?` to send "[ELABORATE]" and to
          // render `detail`/`category`) lives in packages/tui's question route, which is
          // Phase 4 (TUI relocation) work and hasn't been re-wired yet — this backend half
          // is forward-compatible but currently unreachable until that lands.
          const isElaboration = answers.some((a) => a?.some((v) => v === "[ELABORATE]"))
          if (isElaboration) {
            const optionSummary = params.questions
              .map((q) =>
                q.options
                  .map((o) => `- ${o.label}: ${o.description}${o.detail ? ` (${o.detail})` : ""}`)
                  .join("\n"),
              )
              .join("\n\n")
            return {
              title: "User wants more details",
              output: `The user pressed "tell me more". You MUST do BOTH of these steps in order:\n\nSTEP 1: Write a detailed explanation of each option with trade-offs, implications, and your recommendation:\n${optionSummary}\n\nSTEP 2: After your explanation, you MUST call the question tool again with the SAME question and options so the user can make their choice. Do NOT skip re-asking.`,
              metadata: { answers },
            }
          }

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
