import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Global } from "@opencode-ai/core/global"

// TODO(port): util/log.ts no longer exists — logging moved to Effect's Logger
// (packages/core/src/observability/logging.ts), not reachable from this plain
// module. Falls back to console.error.
const log = {
  warn: (message: string, extra?: Record<string, unknown>) => console.error(`[telemetry] ${message}`, extra ?? ""),
  info: (message: string, extra?: Record<string, unknown>) => {
    if (process.env["OPENCODE_LOG_LEVEL"] === "DEBUG") console.error(`[telemetry] ${message}`, extra ?? "")
  },
}

export namespace Telemetry {
  export interface Event {
    type: "session.start" | "session.end" | "tool.call" | "tool.result" | "error" | "custom"
    timestamp: number
    sessionID?: string
    data: Record<string, any>
  }

  type Handler = (event: Event) => void
  const handlers: Handler[] = []
  let fileLogPath: string | undefined

  export function register(handler: Handler): () => void {
    handlers.push(handler)
    return () => {
      const idx = handlers.indexOf(handler)
      if (idx >= 0) handlers.splice(idx, 1)
    }
  }

  export function emit(event: Event): void {
    for (const handler of handlers) {
      try {
        handler(event)
      } catch (err) {
        log.warn("handler error", { error: err })
      }
    }

    if (fileLogPath) {
      const line = JSON.stringify(event) + "\n"
      fs.appendFile(fileLogPath, line).catch(() => {})
    }
  }

  export function enableFileLogging(filePath?: string): void {
    fileLogPath = filePath ?? path.join(Global.Path.log, "telemetry.jsonl")
    log.info("file logging enabled", { path: fileLogPath })
  }

  export function disableFileLogging(): void {
    fileLogPath = undefined
  }

  /**
   * Subscribe to all bus events and forward as telemetry.
   * Call this during bootstrap to capture everything.
   */
  export function init(): void {
    // TODO(port): the old EventEmitter-style `Bus.subscribeAll` is gone —
    // events now flow through the Effect-based EventV2 service. Bridge onto
    // it via AppRuntime.runFork so `init()` can stay a plain sync function
    // (matching how Phase 2's bootstrap.ts is expected to call it).
    AppRuntime.runFork(
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        yield* events.listen((busEvent) =>
          Effect.sync(() => {
            const properties = (busEvent.data ?? {}) as Record<string, any>
            const type = mapBusEventType(busEvent.type)
            emit({
              type,
              timestamp: Date.now(),
              sessionID: properties.sessionID ?? properties.info?.id,
              data: {
                busType: busEvent.type,
                ...properties,
              },
            })
          }),
        )
      }),
    )
  }

  function mapBusEventType(busType: string): Event["type"] {
    if (busType.startsWith("session.created") || busType === "session.status") return "session.start"
    if (busType.includes("error")) return "error"
    if (busType.startsWith("message.part.updated")) return "tool.result"
    return "custom"
  }
}
