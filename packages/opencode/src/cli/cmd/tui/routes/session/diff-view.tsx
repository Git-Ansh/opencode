import { createSignal, For, Show, createMemo, createEffect, onCleanup, type Accessor } from "solid-js"
import { useTheme } from "../../context/theme"
import { useKeyboard } from "@opentui/solid"
import { useSync } from "../../context/sync"
import { createTwoFilesPatch } from "diff"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import { watch, type FSWatcher } from "node:fs"

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function openInEditor(filepath: string) {
  const editor = process.env.VISUAL || process.env.EDITOR || "code"
  const args = editor.split(" ")
  try {
    Bun.spawn([...args, filepath], { stdio: ["ignore", "ignore", "ignore"] })
  } catch {}
}

interface FileEntry {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
  status?: string
  category: "modified" | "opened"
  _diff?: string
}

type FilterMode = "all" | "modified" | "opened"
const FILE_FILTERS: { mode: FilterMode; label: string }[] = [
  { mode: "modified", label: "Modified" },
  { mode: "opened", label: "Opened" },
  { mode: "all", label: "All" },
]

export function DiffView(props: { sessionID: string; openedFiles?: string[]; onCloseFile?: (filepath: string) => void; filterMode?: Accessor<FilterMode>; setFilterMode?: (m: FilterMode) => void; showList?: Accessor<boolean>; setShowList?: (v: boolean) => void }) {
  const { theme, syntax } = useTheme()
  const sync = useSync()
  const [selected, setSelected] = createSignal(0)
  const [localShowList, setLocalShowList] = createSignal(true)
  const showList = () => props.showList ? props.showList() : localShowList()
  const setShowList = (v: boolean | ((prev: boolean) => boolean)) => {
    const val = typeof v === "function" ? v(showList()) : v
    props.setShowList ? props.setShowList(val) : setLocalShowList(val)
  }
  const [localFilter, setLocalFilter] = createSignal<FilterMode>("modified")
  const filterMode = () => props.filterMode ? props.filterMode() : localFilter()
  const setFilterMode = (m: FilterMode) => props.setFilterMode ? props.setFilterMode(m) : setLocalFilter(m)
  const [fileVersion, setFileVersion] = createSignal(0)

  // Watch for external file changes
  let watchers: FSWatcher[] = []
  let watchDebounce: ReturnType<typeof setTimeout> | undefined

  function watchFiles(paths: string[]) {
    for (const w of watchers) { try { w.close() } catch {} }
    watchers = []
    for (const fp of paths) {
      try {
        const w = watch(fp, () => {
          if (watchDebounce) clearTimeout(watchDebounce)
          watchDebounce = setTimeout(() => setFileVersion(v => v + 1), 300)
        })
        watchers.push(w)
      } catch {}
    }
  }

  onCleanup(() => {
    for (const w of watchers) { try { w.close() } catch {} }
    if (watchDebounce) clearTimeout(watchDebounce)
  })

  // Raw files from sync data
  const rawFiles = createMemo((): FileEntry[] => {
    const result: FileEntry[] = []
    const seen = new Set<string>()

    // Modified files from session_diff
    const diffs = sync.data.session_diff[props.sessionID] ?? []
    for (const d of diffs) {
      result.push({ ...d, category: "modified" })
      seen.add(d.file)
    }

    // Fallback: modified files from tool parts
    if (diffs.length === 0) {
      const msgs = sync.data.message[props.sessionID] ?? []
      const toolFiles = new Map<string, { tool: string; diff?: string }>()
      for (const msg of msgs) {
        const parts = sync.data.part[msg.id] ?? []
        for (const p of parts) {
          if (p.type !== "tool") continue
          if (p.tool === "write" || p.tool === "edit" || p.tool === "apply_patch") {
            const fp = (p.state?.input as any)?.filePath ?? ""
            if (fp && (p.state?.status === "completed" || p.state?.status === "running")) {
              toolFiles.set(fp, { tool: p.tool, diff: p.state?.metadata?.diff })
            }
          }
        }
      }
      for (const [fp, info] of toolFiles) {
        result.push({
          file: fp, before: "", after: "", additions: 0, deletions: 0,
          status: "modified", category: "modified", _diff: info.diff,
        })
        seen.add(fp)
      }
    }

    // Opened files from read tool parts
    const msgs = sync.data.message[props.sessionID] ?? []
    for (const msg of msgs) {
      const parts = sync.data.part[msg.id] ?? []
      for (const p of parts) {
        if (p.type === "tool" && p.tool === "read" && p.state?.status === "completed") {
          const fp = (p.state?.input as any)?.filePath
            ?? (p.state?.input as any)?.file_path
            ?? p.state?.title ?? ""
          if (fp && !seen.has(fp)) {
            result.push({
              file: fp, before: "", after: "", additions: 0, deletions: 0,
              status: "read", category: "opened",
            })
            seen.add(fp)
          }
        }
      }
    }

    // User-opened files from sidebar
    for (const fp of (props.openedFiles ?? [])) {
      if (!seen.has(fp)) {
        result.push({
          file: fp, before: "", after: "", additions: 0, deletions: 0,
          status: "read", category: "opened",
        })
        seen.add(fp)
      }
    }

    return result
  })

  // Filter out deleted files and apply existence check
  const [validFiles, setValidFiles] = createSignal<FileEntry[]>([])

  createEffect(async () => {
    const raw = rawFiles()
    const _ver = fileVersion()
    const result: FileEntry[] = []
    for (const f of raw) {
      try {
        const exists = await Bun.file(f.file).exists()
        if (exists) {
          result.push(f)
        }
        // Skip files that don't exist (deleted)
      } catch {
        result.push(f) // Can't check — include
      }
    }
    setValidFiles(result)
  })

  // Apply filter
  const files = createMemo(() => {
    const mode = filterMode()
    const valid = validFiles()
    if (mode === "all") return valid
    return valid.filter(f => f.category === mode)
  })

  // Set up file watchers
  createEffect(() => {
    const paths = validFiles().map(f => f.file)
    watchFiles(paths)
  })

  // Track editing files
  const editingFiles = createMemo(() => {
    const msgs = sync.data.message[props.sessionID] ?? []
    const editing = new Set<string>()
    for (const msg of msgs) {
      const parts = sync.data.part[msg.id] ?? []
      for (const p of parts) {
        if (p.type === "tool" && (p.tool === "write" || p.tool === "edit") && p.state?.status === "running") {
          const fp = (p.state?.input as any)?.filePath ?? ""
          if (fp) editing.add(fp)
        }
      }
    }
    return editing
  })

  const current = createMemo(() => files()[selected()])

  // Load file content for preview
  const [fileContent, setFileContent] = createSignal("")

  createEffect(async () => {
    const file = current()
    const _ver = fileVersion()
    if (!file) { setFileContent(""); return }
    if (file.before || file.after) { setFileContent(""); return }
    try {
      const f = Bun.file(file.file)
      if (await f.exists()) {
        setFileContent(await f.text())
      } else {
        setFileContent("")
      }
    } catch {
      setFileContent("")
    }
  })

  const diffContent = createMemo(() => {
    const file = current()
    if (!file) return ""
    if (file._diff) return file._diff
    if (file.before || file.after) {
      try {
        return createTwoFilesPatch(
          file.file, file.file,
          file.before ?? "",
          file.after ?? "",
          "", "",
          { context: 3 },
        )
      } catch {
        return ""
      }
    }
    return ""
  })

  const filterLabel = () => {
    const mode = filterMode()
    if (mode === "all") return "all"
    if (mode === "modified") return "modified"
    return "opened"
  }

  useKeyboard((evt) => {
    // Ctrl+W toggle list
    if (evt.ctrl && evt.name === "w") {
      evt.preventDefault()
      setShowList(s => !s)
      return
    }
    // Ctrl+F cycle filter
    if (evt.ctrl && evt.name === "f") {
      evt.preventDefault()
      const order: FilterMode[] = ["modified", "opened", "all"]
      const idx = order.indexOf(filterMode())
      setFilterMode(order[(idx + 1) % order.length])
      setSelected(0)
      return
    }
    const count = files().length
    if (!count) return
    if (evt.ctrl && evt.name === "up") {
      evt.preventDefault()
      setSelected(s => Math.max(0, s - 1))
    }
    if (evt.ctrl && evt.name === "down") {
      evt.preventDefault()
      setSelected(s => Math.min(count - 1, s + 1))
    }
    if (evt.ctrl && evt.name === "e") {
      evt.preventDefault()
      const file = current()
      if (file) openInEditor(file.file)
    }
    // Ctrl+O to close an opened file (Ctrl+Shift doesn't work in terminals)
    if (evt.ctrl && evt.name === "o") {
      evt.preventDefault()
      const file = current()
      if (file && file.category === "opened") {
        props.onCloseFile?.(file.file)
      }
    }
  })

  const shortPath = (filepath: string) => {
    const parts = filepath.split(/[/\\]/)
    if (parts.length <= 3) return filepath
    return ".../" + parts.slice(-3).join("/")
  }

  const statusDot = (file: FileEntry) => {
    if (editingFiles().has(file.file)) return theme.warning
    if (file.category === "opened") return theme.info
    if (file.status === "added") return theme.success
    if (file.status === "deleted") return theme.error
    return theme.accent
  }

  const statusLabel = (file: FileEntry) => {
    if (editingFiles().has(file.file)) return "editing"
    if (file.category === "opened") return "opened"
    if (file.status === "added") return "new"
    if (file.status === "deleted") return "deleted"
    return "modified"
  }

  const modifiedCount = createMemo(() => validFiles().filter(f => f.category === "modified").length)
  const openedCount = createMemo(() => validFiles().filter(f => f.category === "opened").length)

  return (
    <box flexGrow={1}>
      <box
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        marginBottom={1}
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
      >
        <text fg={theme.text}>
          <b>{validFiles().length === 0 ? "No files" : `${validFiles().length} files`}</b>
        </text>
        <box flexDirection="row" gap={1}>
          <For each={FILE_FILTERS}>
            {(f) => {
              const count = () => f.mode === "modified" ? modifiedCount() : f.mode === "opened" ? openedCount() : validFiles().length
              return (
                <text
                  fg={filterMode() === f.mode ? theme.accent : theme.textMuted}
                  onMouseDown={() => { setFilterMode(f.mode); setSelected(0) }}
                >
                  {filterMode() === f.mode ? `\u25CF ${f.label}` : `  ${f.label}`} {count()}
                </text>
              )
            }}
          </For>
        </box>
      </box>
      <Show when={files().length === 0}>
        <box paddingLeft={1} paddingTop={1}>
          <text fg={theme.textMuted}>
            {validFiles().length > 0 ? `No ${filterLabel()} files` : "No files accessed"}
          </text>
        </box>
      </Show>
      <Show when={files().length > 0}>
        <box flexGrow={1} flexDirection="row">
          {/* File list - collapsible via width */}
          <box width={showList() ? "30%" : 0}>
            <Show when={showList()}>
              <scrollbox flexGrow={1}>
                <For each={files()}>
                  {(file, i) => {
                    const isSelected = () => i() === selected()
                    const prevFile = () => i() > 0 ? files()[i() - 1] : undefined
                    const showSeparator = () => prevFile()?.category === "modified" && file.category === "opened"

                    return (
                      <>
                        <Show when={showSeparator()}>
                          <text fg={theme.border} paddingLeft={1}>{"\u2500\u2500\u2500 opened \u2500\u2500\u2500"}</text>
                        </Show>
                        <box
                          backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                          onMouseDown={() => setSelected(i())}
                          paddingLeft={1}
                          paddingRight={1}
                        >
                          <box flexDirection="row" justifyContent="space-between">
                            <box flexDirection="row" gap={1}>
                              <text fg={statusDot(file)}>{"\u25CF"}</text>
                              <text fg={isSelected() ? theme.text : theme.textMuted} wrapMode="none">
                                {path.basename(file.file)}
                              </text>
                            </box>
                            <box flexDirection="row" gap={1}>
                              <Show when={file.additions > 0}>
                                <text fg={theme.diffAdded}>+{file.additions}</text>
                              </Show>
                              <Show when={file.deletions > 0}>
                                <text fg={theme.diffRemoved}>-{file.deletions}</text>
                              </Show>
                            </box>
                          </box>
                          <text fg={theme.textMuted} paddingLeft={2} wrapMode="none">
                            {shortPath(path.dirname(file.file))}
                          </text>
                        </box>
                      </>
                    )
                  }}
                </For>
              </scrollbox>
            </Show>
          </box>
          <box width={showList() ? 1 : 0} border={showList() ? ["left"] : undefined} borderColor={theme.border} />
          {/* Diff / file content */}
          <box flexGrow={1}>
            <Show when={current()}>
              {(file) => (
                <box flexGrow={1}>
                  <box
                    flexShrink={0}
                    flexDirection="row"
                    justifyContent="space-between"
                    backgroundColor={theme.backgroundPanel}
                    paddingLeft={2}
                    paddingRight={2}
                    paddingTop={1}
                    paddingBottom={1}
                    marginBottom={1}
                  >
                    <box flexDirection="row" gap={1}>
                      <text fg={statusDot(file())}>{"\u25CF"}</text>
                      <text fg={theme.text} wrapMode="none"><b>{path.basename(file().file)}</b></text>
                      <text fg={theme.textMuted}>{statusLabel(file())}</text>
                    </box>
                    <box flexDirection="row" gap={1}>
                      <Show when={file().additions > 0}>
                        <text fg={theme.diffAdded}>+{file().additions}</text>
                      </Show>
                      <Show when={file().deletions > 0}>
                        <text fg={theme.diffRemoved}>-{file().deletions}</text>
                      </Show>
                    </box>
                  </box>
                  {/* Show diff if available */}
                  <Show when={diffContent()}>
                    <scrollbox flexGrow={1}>
                      <diff
                        diff={diffContent()}
                        view="unified"
                        filetype={filetype(file().file)}
                        syntaxStyle={syntax()}
                        showLineNumbers={true}
                        width="100%"
                        wrapMode="truncate"
                        fg={theme.text}
                        addedBg={theme.diffAddedBg}
                        removedBg={theme.diffRemovedBg}
                        contextBg={theme.diffContextBg}
                        addedSignColor={theme.diffHighlightAdded}
                        removedSignColor={theme.diffHighlightRemoved}
                        lineNumberFg={theme.diffLineNumber}
                        lineNumberBg={theme.diffContextBg}
                        addedLineNumberBg={theme.diffAddedLineNumberBg}
                        removedLineNumberBg={theme.diffRemovedLineNumberBg}
                      />
                    </scrollbox>
                  </Show>
                  {/* Fallback: show file content with line numbers */}
                  <Show when={!diffContent() && fileContent()}>
                    <scrollbox flexGrow={1} paddingLeft={1}>
                      <For each={fileContent().split("\n")}>
                        {(line, i) => (
                          <text fg={theme.text} wrapMode="truncate">
                            <span style={{ fg: theme.diffLineNumber }}>{String(i() + 1).padStart(4)} </span>{line}
                          </text>
                        )}
                      </For>
                    </scrollbox>
                  </Show>
                  <Show when={!diffContent() && !fileContent()}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>(file content unavailable)</text>
                    </box>
                  </Show>
                </box>
              )}
            </Show>
          </box>
        </box>
      </Show>
    </box>
  )
}
