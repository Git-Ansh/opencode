import { spawn } from "child_process"
import { Effect, Stream } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "../session/status"
import { Permission } from "../permission"
import { Session } from "../session/session"
import { Config } from "../config/config"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { AppRuntime as AppRuntimeType } from "@/effect/app-runtime"

// Note(port): this module is imported by project/bootstrap.ts, which sits
// *inside* the Effect DI graph that `@/effect/app-runtime` assembles
// (app-runtime.ts -> app-node-builder-v1.ts -> bootstrap.ts -> here). A
// static top-level `import { AppRuntime }` closes a circular-import loop back
// onto app-runtime.ts, which crashes module loading with "Cannot access
// 'node' before initialization" (TDZ) when the graph is first pulled in from
// a module like control-plane/workspace.ts. AppRuntime is only needed inside
// `init()` (never at module scope), so load it lazily via dynamic import —
// the same pattern upstream itself uses (cli/effect-cmd.ts,
// control-plane/adapters/worktree.ts).
let appRuntimePromise: Promise<typeof AppRuntimeType> | undefined
function getAppRuntime(): Promise<typeof AppRuntimeType> {
  if (!appRuntimePromise) appRuntimePromise = import("@/effect/app-runtime").then((m) => m.AppRuntime)
  return appRuntimePromise
}

// TODO(port): util/log.ts no longer exists — logging moved to Effect's Logger
// (packages/core/src/observability/logging.ts), not reachable from this plain
// async module. Falls back to console.error.
const log = {
  warn: (message: string, extra?: Record<string, unknown>) => console.error(`[notification] ${message}`, extra ?? ""),
  info: (message: string, extra?: Record<string, unknown>) => {
    if (process.env["OPENCODE_LOG_LEVEL"] === "DEBUG") console.error(`[notification] ${message}`, extra ?? "")
  },
}

export namespace Notification {
  let initialized = false

  export async function send(title: string, body: string): Promise<void> {
    try {
      // Sanitize inputs to prevent injection
      const safeTitle = title.replace(/['"\\`$]/g, "")
      const safeBody = body.replace(/['"\\`$]/g, "").slice(0, 200)

      if (process.platform === "win32") {
        // Use PowerShell toast notification
        const script = `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = '${safeTitle}'
$n.BalloonTipText = '${safeBody}'
$n.Visible = $true
$n.ShowBalloonTip(5000)
Start-Sleep -Seconds 6
$n.Dispose()
`
        const child = spawn("powershell", ["-NoProfile", "-Command", script], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
        child.unref()
      } else if (process.platform === "darwin") {
        const child = spawn("osascript", ["-e", `display notification "${safeBody}" with title "${safeTitle}"`], {
          detached: true,
          stdio: "ignore",
        })
        child.unref()
      } else {
        // Linux — use notify-send
        const child = spawn("notify-send", [safeTitle, safeBody], {
          detached: true,
          stdio: "ignore",
        })
        child.unref()
      }
    } catch (err) {
      log.warn("notification failed", { error: err })
    }
  }

  // Accepts the already-resolved instance config from bootstrap. Config.get()
  // is instance-scoped (requires InstanceRef), so re-fetching it here through
  // a bare AppRuntime.runPromise dies with "InstanceRef not provided" — the
  // caller (project/bootstrap.ts) runs inside instance context and passes the
  // config in instead. The Config.Service fallback remains for any caller that
  // does run inside instance context.
  export async function init(config?: ConfigV1.Info): Promise<void> {
    if (initialized) return
    initialized = true

    const AppRuntime = await getAppRuntime()
    const resolved = config ?? (await AppRuntime.runPromise(Config.Service.use((c) => c.get())))
    const notifConfig = resolved.notifications
    if (notifConfig?.enabled === false) return

    const subscriptions: Effect.Effect<void, never, EventV2Bridge.Service>[] = []

    // Notify on task completion (session goes idle)
    if (notifConfig?.on_complete !== false) {
      subscriptions.push(
        Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          yield* Stream.runForEach(events.subscribe(SessionStatus.Event.Idle), () =>
            Effect.promise(() => send("OpenCode", "Task complete")),
          )
        }),
      )
    }

    // Notify when permission is needed
    if (notifConfig?.on_permission !== false) {
      subscriptions.push(
        Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          yield* Stream.runForEach(events.subscribe(Permission.Event.Asked), (evt) =>
            Effect.promise(() => send("OpenCode - Action Required", `Permission needed: ${evt.data.permission}`)),
          )
        }),
      )
    }

    // Notify on errors
    if (notifConfig?.on_error !== false) {
      subscriptions.push(
        Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          yield* Stream.runForEach(events.subscribe(Session.Event.Error), (evt) => {
            const errName = (evt.data as { error?: { name?: string } }).error?.name ?? "Unknown error"
            return Effect.promise(() => send("OpenCode - Error", `Session error: ${errName}`))
          })
        }),
      )
    }

    // Fire-and-forget: keep these subscriptions alive for the process lifetime.
    AppRuntime.runFork(Effect.all(subscriptions, { concurrency: "unbounded", discard: true }))

    log.info("notifications initialized")
  }
}
