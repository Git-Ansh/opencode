import { Tool } from "./tool"
import z from "zod"
import { Pty } from "../pty"

export const PtySpawnTool = Tool.define("pty_spawn", async () => {
  return {
    description: `Spawn a new interactive pseudo-terminal (PTY) session. Use this for commands that require interactivity (e.g., npm init, git rebase -i, python REPL, ssh).

Returns a PTY session ID. Use pty_read to get output, pty_write to send input, pty_kill to terminate.

IMPORTANT: Only use PTY for truly interactive commands. For normal commands, use the regular bash tool.`,
    parameters: z.object({
      command: z.string().optional().describe("Command to run (defaults to system shell)"),
      args: z.array(z.string()).optional().describe("Command arguments"),
      cwd: z.string().optional().describe("Working directory"),
      title: z.string().optional().describe("Title for this PTY session"),
    }),
    async execute(params, ctx) {
      await ctx.ask({
        permission: "bash",
        patterns: [params.command ?? "shell"],
        always: ["*"],
        metadata: { command: params.command, type: "pty" },
      })

      const info = await Pty.create({
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        title: params.title,
      })

      return {
        title: `PTY: ${params.command ?? "shell"}`,
        metadata: { ptyId: info.id, pid: info.pid },
        output: [
          `PTY session created: ${info.id}`,
          `Command: ${info.command} ${info.args.join(" ")}`,
          `PID: ${info.pid}`,
          ``,
          `Use pty_read("${info.id}") to see output`,
          `Use pty_write("${info.id}", "input\\n") to send input`,
          `Use pty_kill("${info.id}") to terminate`,
        ].join("\n"),
      }
    },
  }
})

export const PtyReadTool = Tool.define("pty_read", async () => {
  return {
    description: "Read the current output buffer from a PTY session. Returns the accumulated terminal output.",
    parameters: z.object({
      id: z.string().describe("PTY session ID"),
      tail: z.number().optional().describe("Number of characters from the end to return (default: all)"),
    }),
    async execute(params) {
      const sessions = Pty.list()
      const session = sessions.find((s) => s.id === params.id)

      if (!session) {
        // Check if it was a known session that exited
        return {
          title: "PTY not found",
          metadata: {},
          output: `No PTY session found with ID: ${params.id}. It may have exited.`,
        }
      }

      // Access the internal state to get buffer
      const internal = (Pty as any).state?.()?.get?.(params.id)
      if (!internal) {
        return {
          title: `PTY: ${session.id}`,
          metadata: { status: session.status },
          output: `PTY session ${session.id} exists but buffer is not accessible.`,
        }
      }

      let buffer = internal.buffer as string
      if (params.tail && buffer.length > params.tail) {
        buffer = buffer.slice(-params.tail)
      }

      return {
        title: `PTY output: ${session.id}`,
        metadata: { status: session.status, pid: session.pid },
        output: buffer || "(no output yet)",
      }
    },
  }
})

export const PtyWriteTool = Tool.define("pty_write", async () => {
  return {
    description:
      "Send input to a running PTY session. Use \\n for Enter, \\t for Tab. The input is written to the terminal's stdin.",
    parameters: z.object({
      id: z.string().describe("PTY session ID"),
      input: z.string().describe("Text to send to the PTY (use \\n for Enter key)"),
    }),
    async execute(params, ctx) {
      const session = Pty.list().find((s) => s.id === params.id)
      if (!session) {
        return {
          title: "PTY not found",
          metadata: {},
          output: `No PTY session found with ID: ${params.id}`,
        }
      }

      if (session.status !== "running") {
        return {
          title: "PTY not running",
          metadata: {},
          output: `PTY session ${params.id} has already exited.`,
        }
      }

      // Interpret escape sequences
      const input = params.input.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r")

      Pty.write(params.id, input)

      return {
        title: `PTY input sent: ${params.id}`,
        metadata: { ptyId: params.id },
        output: `Sent ${input.length} characters to PTY ${params.id}. Use pty_read to see the result.`,
      }
    },
  }
})

export const PtyKillTool = Tool.define("pty_kill", async () => {
  return {
    description: "Kill a PTY session and its running process.",
    parameters: z.object({
      id: z.string().describe("PTY session ID to kill"),
    }),
    async execute(params) {
      const session = Pty.list().find((s) => s.id === params.id)
      if (!session) {
        return {
          title: "PTY not found",
          metadata: {},
          output: `No PTY session found with ID: ${params.id}`,
        }
      }

      await Pty.remove(params.id)

      return {
        title: `PTY killed: ${params.id}`,
        metadata: { ptyId: params.id },
        output: `PTY session ${params.id} has been terminated.`,
      }
    },
  }
})

export const PtyListTool = Tool.define("pty_list", async () => {
  return {
    description: "List all active PTY sessions with their status.",
    parameters: z.object({}),
    async execute() {
      const sessions = Pty.list()

      if (sessions.length === 0) {
        return {
          title: "No PTY sessions",
          metadata: {},
          output: "No active PTY sessions. Use pty_spawn to create one.",
        }
      }

      const lines = sessions.map(
        (s) => `- ${s.id}: ${s.command} ${s.args.join(" ")} [${s.status}] (PID: ${s.pid}) "${s.title}"`,
      )

      return {
        title: `${sessions.length} PTY session(s)`,
        metadata: {},
        output: lines.join("\n"),
      }
    },
  }
})
