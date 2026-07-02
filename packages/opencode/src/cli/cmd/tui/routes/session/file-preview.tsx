import { createSignal, createEffect, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Editor } from "../../util/editor"
import { useKeyboard } from "@opentui/solid"
import path from "path"

export function FilePreview(props: { filepath: string; width?: number; height?: number }) {
  const { theme } = useTheme()
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
    if (evt.name === "e" && !evt.ctrl && !evt.alt) {
      Editor.open(props.filepath)
    }
  })

  const filename = () => path.basename(props.filepath)
  const lines = () => content().split("\n")

  return (
    <box flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text} wrapMode="none"><b>{filename()}</b></text>
        <text fg={theme.textMuted}>e to edit</text>
      </box>
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
      <Show when={!error()}>
        <scrollbox flexGrow={1}>
          <text fg={theme.text} wrapMode="truncate">
            {lines().map((line, i) => {
              const num = String(i + 1).padStart(4)
              return `${num} ${line}\n`
            }).join("")}
          </text>
        </scrollbox>
      </Show>
    </box>
  )
}
