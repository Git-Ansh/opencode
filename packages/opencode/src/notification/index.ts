import { spawn } from "child_process"
import { Bus } from "../bus"
import { SessionStatus } from "../session/status"
import { PermissionNext } from "../permission/next"
import { Session } from "../session"
import { Config } from "../config/config"
import { Log } from "../util/log"

export namespace Notification {
  const log = Log.create({ service: "notification" })

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

  export async function init(): Promise<void> {
    if (initialized) return
    initialized = true

    const config = await Config.get()
    const notifConfig = config.notifications
    if (notifConfig?.enabled === false) return

    // Notify on task completion (session goes idle)
    if (notifConfig?.on_complete !== false) {
      Bus.subscribe(SessionStatus.Event.Status, (evt) => {
        if (evt.properties.status.type === "idle") {
          send("OpenCode", "Task complete")
        }
      })
    }

    // Notify when permission is needed
    if (notifConfig?.on_permission !== false) {
      Bus.subscribe(PermissionNext.Event.Asked, (evt) => {
        send("OpenCode - Action Required", `Permission needed: ${evt.properties.permission}`)
      })
    }

    // Notify on errors
    if (notifConfig?.on_error !== false) {
      Bus.subscribe(Session.Event.Error, (evt) => {
        const errName = evt.properties.error?.name ?? "Unknown error"
        send("OpenCode - Error", `Session error: ${errName}`)
      })
    }

    log.info("notifications initialized")
  }
}
