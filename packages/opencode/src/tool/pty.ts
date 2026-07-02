import { Context, Schema, Effect } from "effect"
import * as Tool from "./tool"
import { Pty } from "@opencode-ai/core/pty"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { InstanceState } from "@/effect/instance-state"

// TODO(port): the old `../pty` module (a simple process-global `Pty.create/list/
// write/remove` namespace) no longer exists. PTY sessions are now a
// location-scoped Effect service (`@opencode-ai/core/pty`, registered in
// `packages/core/src/location-services.ts`'s `locationServices` node list) —
// the same subsystem that backs the interactive terminal panes over the
// httpapi (see `server/routes/instance/httpapi/handlers/pty.ts`, which this
// file's `scopedPty` helper mirrors). This means PTY sessions created by this
// tool live in the same location-scoped registry as the user-facing terminal
// UI, rather than a tool-private list — worth confirming that's the intended
// product behavior (e.g. should the LLM be able to see/kill the user's manual
// terminal panes and vice versa?) in a follow-up review.
//
// `LocationServiceMap.Service` is resolved once per tool at Tool.define's
// init time (like `Git.Service` in tool/git.ts) rather than inside `execute`,
// because `Tool.Def["execute"]` must return `Effect.Effect<ExecuteResult<M>>`
// with no outstanding requirements (R = never) — resolving it up front and
// closing over it is what lets `scopedPty` fully discharge Pty.Service's
// requirement per call via `Effect.provide`.
function makePtyOps(locations: Context.Service.Shape<typeof LocationServiceMap.Service>) {
  function scopedPty<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      return yield* effect.pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))),
      )
    })
  }

  const getOrUndefined = (id: typeof PtyID.Type) =>
    scopedPty(Pty.Service.use((service) => service.get(id))).pipe(
      Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(undefined)),
    )

  return { scopedPty, getOrUndefined }
}

const SpawnParameters = Schema.Struct({
  command: Schema.optional(Schema.String).annotate({ description: "Command to run (defaults to system shell)" }),
  args: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Command arguments" }),
  cwd: Schema.optional(Schema.String).annotate({ description: "Working directory" }),
  title: Schema.optional(Schema.String).annotate({ description: "Title for this PTY session" }),
})

export const PtySpawnTool = Tool.define(
  "pty_spawn",
  Effect.gen(function* () {
    const { scopedPty } = makePtyOps(yield* LocationServiceMap.Service)

    return {
      description: `Spawn a new interactive pseudo-terminal (PTY) session. Use this for commands that require interactivity (e.g., npm init, git rebase -i, python REPL, ssh).

Returns a PTY session ID. Use pty_read to get output, pty_write to send input, pty_kill to terminate.

IMPORTANT: Only use PTY for truly interactive commands. For normal commands, use the regular bash tool.`,
      parameters: SpawnParameters,
      execute: (params: Schema.Schema.Type<typeof SpawnParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "bash",
            patterns: [params.command ?? "shell"],
            always: ["*"],
            metadata: { command: params.command, type: "pty" },
          })

          const info = yield* scopedPty(
            Pty.Service.use((service) =>
              service.create({
                command: params.command,
                args: params.args ? Array.from(params.args) : undefined,
                cwd: params.cwd,
                title: params.title,
              }),
            ),
          )

          return {
            title: `PTY: ${params.command ?? "shell"}`,
            metadata: { ptyId: info.id, pid: info.pid } as Record<string, any>,
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
        }).pipe(Effect.orDie),
    }
  }),
)

const ReadParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "PTY session ID" }),
  tail: Schema.optional(Schema.Number).annotate({
    description: "Number of characters from the end to return (default: all)",
  }),
})

export const PtyReadTool = Tool.define(
  "pty_read",
  Effect.gen(function* () {
    const { scopedPty, getOrUndefined } = makePtyOps(yield* LocationServiceMap.Service)

    return {
      description: "Read the current output buffer from a PTY session. Returns the accumulated terminal output.",
      parameters: ReadParameters,
      execute: (params: Schema.Schema.Type<typeof ReadParameters>) =>
        Effect.gen(function* () {
          const id = PtyID.make(params.id)
          const session = yield* getOrUndefined(id)

          if (!session) {
            return {
              title: "PTY not found",
              metadata: {} as Record<string, any>,
              output: `No PTY session found with ID: ${params.id}. It may have exited.`,
            }
          }

          // A one-shot "read the current buffer" snapshot: attach just long
          // enough to capture the replay + cursor, then immediately detach —
          // this tool has no live/streaming read mode.
          const attachment = yield* scopedPty(
            Pty.Service.use((service) => service.attach(id, { onData: () => {}, onEnd: () => {} })),
          ).pipe(Effect.catch(() => Effect.succeed(undefined)))

          if (!attachment) {
            return {
              title: `PTY: ${session.id}`,
              metadata: { status: session.status } as Record<string, any>,
              output: `PTY session ${session.id} exists but its buffer is not accessible (process already exited).`,
            }
          }

          attachment.detach()
          let buffer = attachment.replay
          if (params.tail && buffer.length > params.tail) {
            buffer = buffer.slice(-params.tail)
          }

          return {
            title: `PTY output: ${session.id}`,
            metadata: { status: session.status, pid: session.pid } as Record<string, any>,
            output: buffer || "(no output yet)",
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const WriteParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "PTY session ID" }),
  input: Schema.String.annotate({ description: "Text to send to the PTY (use \\n for Enter key)" }),
})

export const PtyWriteTool = Tool.define(
  "pty_write",
  Effect.gen(function* () {
    const { scopedPty, getOrUndefined } = makePtyOps(yield* LocationServiceMap.Service)

    return {
      description:
        "Send input to a running PTY session. Use \\n for Enter, \\t for Tab. The input is written to the terminal's stdin.",
      parameters: WriteParameters,
      execute: (params: Schema.Schema.Type<typeof WriteParameters>) =>
        Effect.gen(function* () {
          const id = PtyID.make(params.id)
          const session = yield* getOrUndefined(id)
          if (!session) {
            return {
              title: "PTY not found",
              metadata: {} as Record<string, any>,
              output: `No PTY session found with ID: ${params.id}`,
            }
          }

          if (session.status !== "running") {
            return {
              title: "PTY not running",
              metadata: {} as Record<string, any>,
              output: `PTY session ${params.id} has already exited.`,
            }
          }

          // Interpret escape sequences
          const input = params.input.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r")

          yield* scopedPty(Pty.Service.use((service) => service.write(id, input)))

          return {
            title: `PTY input sent: ${params.id}`,
            metadata: { ptyId: params.id } as Record<string, any>,
            output: `Sent ${input.length} characters to PTY ${params.id}. Use pty_read to see the result.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const KillParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "PTY session ID to kill" }),
})

export const PtyKillTool = Tool.define(
  "pty_kill",
  Effect.gen(function* () {
    const { scopedPty, getOrUndefined } = makePtyOps(yield* LocationServiceMap.Service)

    return {
      description: "Kill a PTY session and its running process.",
      parameters: KillParameters,
      execute: (params: Schema.Schema.Type<typeof KillParameters>) =>
        Effect.gen(function* () {
          const id = PtyID.make(params.id)
          const session = yield* getOrUndefined(id)
          if (!session) {
            return {
              title: "PTY not found",
              metadata: {} as Record<string, any>,
              output: `No PTY session found with ID: ${params.id}`,
            }
          }

          yield* scopedPty(Pty.Service.use((service) => service.remove(id)))

          return {
            title: `PTY killed: ${params.id}`,
            metadata: { ptyId: params.id } as Record<string, any>,
            output: `PTY session ${params.id} has been terminated.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const ListParameters = Schema.Struct({})

export const PtyListTool = Tool.define(
  "pty_list",
  Effect.gen(function* () {
    const { scopedPty } = makePtyOps(yield* LocationServiceMap.Service)

    return {
      description: "List all active PTY sessions with their status.",
      parameters: ListParameters,
      execute: (_params: Schema.Schema.Type<typeof ListParameters>) =>
        Effect.gen(function* () {
          const sessions = yield* scopedPty(Pty.Service.use((service) => service.list()))

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
        }).pipe(Effect.orDie),
    }
  }),
)
