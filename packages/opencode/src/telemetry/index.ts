import fs from "fs/promises"
import path from "path"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { Global } from "../global"

export namespace Telemetry {
  const log = Log.create({ service: "telemetry" })

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
    Bus.subscribeAll((busEvent) => {
      const type = mapBusEventType(busEvent.type)
      emit({
        type,
        timestamp: Date.now(),
        sessionID: busEvent.properties?.sessionID ?? busEvent.properties?.info?.id,
        data: {
          busType: busEvent.type,
          ...busEvent.properties,
        },
      })
    })
  }

  function mapBusEventType(busType: string): Event["type"] {
    if (busType.startsWith("session.created") || busType === "session.status") return "session.start"
    if (busType.includes("error")) return "error"
    if (busType.startsWith("message.part.updated")) return "tool.result"
    return "custom"
  }
}
