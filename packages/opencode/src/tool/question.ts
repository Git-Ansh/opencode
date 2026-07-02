import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.object({
    questions: z.array(Question.Info.omit({ custom: true }).extend({
      options: z.array(Question.Option).describe("Available choices"),
    })).describe("Questions to ask"),
  }),
  async execute(params, ctx) {
    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: params.questions,
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    function format(answer: Question.Answer | undefined) {
      if (!answer?.length) return "Unanswered"
      return answer.join(", ")
    }

    const formatted = params.questions.map((q, i) => `"${q.question}"="${format(answers[i])}"`).join(", ")

    // Check if user asked for elaboration (via "tell me more")
    const isElaboration = answers.some(a => a?.some(v => v === "[ELABORATE]"))
    if (isElaboration) {
      const optionSummary = params.questions.map(q =>
        q.options.map(o => `- ${o.label}: ${o.description}${o.detail ? ` (${o.detail})` : ""}`).join("\n")
      ).join("\n\n")
      return {
        title: "User wants more details",
        output: `The user pressed "tell me more". You MUST do BOTH of these steps in order:\n\nSTEP 1: Write a detailed explanation of each option with trade-offs, implications, and your recommendation:\n${optionSummary}\n\nSTEP 2: After your explanation, you MUST call the question tool again with the SAME question and options so the user can make their choice. Do NOT skip re-asking.`,
        metadata: { answers },
      }
    }

    return {
      title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
      output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
      metadata: {
        answers,
      },
    }
  },
})
