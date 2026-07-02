import { Tool } from "./tool"
import z from "zod"
import { ProjectMemory } from "../session/project-memory"

export const MemorySaveTool = Tool.define("memory_save", {
  description: `Save a piece of project knowledge to persistent memory. Memories persist across sessions and are automatically injected into context when relevant.

Use this to remember:
- Architectural decisions and their rationale
- Project conventions and patterns
- Important file paths and their purposes
- User preferences and requirements
- Debugging insights and solutions

Memories are stored in .opencode/memory/ as markdown files.`,
  parameters: z.object({
    key: z
      .string()
      .describe("Short identifier for this memory (e.g., 'architecture', 'conventions', 'debugging-auth')"),
    content: z
      .string()
      .describe("The knowledge to remember. Be concise but complete. Include context about why this matters."),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "edit",
      patterns: [`.opencode/memory/${params.key}.md`],
      always: [".opencode/memory/*"],
      metadata: { key: params.key },
    })

    await ProjectMemory.save(params.key, params.content)

    return {
      title: `Saved memory: ${params.key}`,
      metadata: { key: params.key },
      output: `Memory "${params.key}" saved to .opencode/memory/. It will be automatically available in future sessions when relevant context is detected.`,
    }
  },
})

export const MemoryReadTool = Tool.define("memory_read", {
  description: `Read a specific project memory by key, or search memories by query.`,
  parameters: z.object({
    key: z.string().optional().describe("Exact key to read (e.g., 'architecture')"),
    query: z.string().optional().describe("Search query to find relevant memories"),
  }),
  async execute(params) {
    if (params.key) {
      const content = await ProjectMemory.get(params.key)
      if (!content) {
        return {
          title: `Memory not found: ${params.key}`,
          metadata: {},
          output: `No memory found with key "${params.key}". Use memory_list to see all available memories.`,
        }
      }
      return {
        title: `Memory: ${params.key}`,
        metadata: { key: params.key },
        output: content,
      }
    }

    if (params.query) {
      const results = await ProjectMemory.search(params.query)
      if (results.length === 0) {
        return {
          title: "No memories found",
          metadata: {},
          output: `No memories matched query "${params.query}".`,
        }
      }
      const output = results
        .map((r) => `## ${r.key}\n${r.content}`)
        .join("\n\n---\n\n")
      return {
        title: `${results.length} memory match(es)`,
        metadata: {},
        output,
      }
    }

    return {
      title: "memory_read",
      metadata: {},
      output: "Provide either a 'key' to read a specific memory or a 'query' to search.",
    }
  },
})

export const MemoryListTool = Tool.define("memory_list", {
  description: `List all project memories stored in .opencode/memory/.`,
  parameters: z.object({}),
  async execute() {
    const memories = await ProjectMemory.list()
    if (memories.length === 0) {
      return {
        title: "No memories",
        metadata: {},
        output: "No project memories stored yet. Use memory_save to create one.",
      }
    }

    const lines = memories.map((m) => `- **${m.key}**: ${m.summary || "(no summary)"}`)
    return {
      title: `${memories.length} memory(ies)`,
      metadata: {},
      output: lines.join("\n"),
    }
  },
})
