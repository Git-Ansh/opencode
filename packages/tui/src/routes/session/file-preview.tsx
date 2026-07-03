import { createSignal, createEffect, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { spawn } from "node:child_process"
import path from "path"

// Opens the real file (not a temp copy) in $EDITOR/$VISUAL, suspending the TUI
// renderer while the external editor owns the terminal. Unlike `openEditor()`
// in ../../editor.ts (which round-trips content through a temp file), this is
// fire-and-forget: we don't read anything back. Shared with diff-view.tsx.
export async function openFileInEditor(renderer: ReturnType<typeof useRenderer>, filepath: string) {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) return
  renderer.suspend()
  renderer.currentRenderBuffer.clear()
  try {
    await new Promise<void>((resolve, reject) => {
      const parts = editor.split(" ")
      const child = spawn(parts[0]!, [...parts.slice(1), filepath], {
        stdio: ["inherit", "inherit", "inherit"],
        shell: process.platform === "win32",
      })
      child.on("error", reject)
      child.on("exit", (code, signal) => {
        if (code === 0) return resolve()
        reject(new Error(`Editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      })
    })
  } catch {
    // non-fatal — opening the editor is a convenience action
  } finally {
    renderer.currentRenderBuffer.clear()
    renderer.resume()
    renderer.requestRender()
  }
}

export function FilePreview(props: { filepath: string; width?: number; height?: number }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [content, setContent] = createSignal("")
  const [error, setError] = createSignal("")

  createEffect(async () => {
    try {
      const file = Bun.file(props.filepath)
      const exists = await file.exists()
      if (!exists) {
        setError("File not found")
        setContent("")
        return
      }
      const text = await file.text()
      setContent(text)
      setError("")
    } catch (e: any) {
      setError(e.message ?? "Failed to read file")
      setContent("")
    }
  })

  useKeyboard((evt) => {
    if (evt.name === "e" && !evt.ctrl && !evt.option) {
      void openFileInEditor(renderer, props.filepath)
    }
  })

  const filename = () => path.basename(props.filepath)
  const lines = () => content().split("\n")

  return (
    <box flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text} wrapMode="none">
          <b>{filename()}</b>
        </text>
        <text fg={theme.textMuted}>e to edit</text>
      </box>
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
      <Show when={!error()}>
        <scrollbox flexGrow={1}>
          <text fg={theme.text} wrapMode="none">
            {lines()
              .map((line, i) => {
                const num = String(i + 1).padStart(4)
                return `${num} ${line}\n`
              })
              .join("")}
          </text>
        </scrollbox>
      </Show>
    </box>
  )
}
