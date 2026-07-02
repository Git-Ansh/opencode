import { createSignal, For, Show, createMemo, type Accessor, createEffect } from "solid-js"
import { useTheme } from "../../context/theme"
import { useKeyboard } from "@opentui/solid"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import stripAnsi from "strip-ansi"

type ProcessState = "running" | "completed" | "error"
type FilterMode = "all" | "running" | "done"
const TERMINAL_FILTERS: { mode: FilterMode; label: string }[] = [
  { mode: "running", label: "Running" },
  { mode: "done", label: "Done" },
  { mode: "all", label: "All" },
]

interface ProcessEntry {
  id: string
  command: string
  state: ProcessState
  output: string
  startTime: number
  endTime?: number
  exitCode?: number
}

export function TerminalView(props: { sessionID: string; filterMode?: Accessor<FilterMode>; setFilterMode?: (m: FilterMode) => void; showList?: Accessor<boolean>; setShowList?: (v: boolean) => void }) {
  const { theme } = useTheme()
  const sync = useSync()
  const sdk = useSDK()
  const [selected, setSelected] = createSignal(0)
  const [localFilter, setLocalFilter] = createSignal<FilterMode>("running")
  const filterMode = () => props.filterMode ? props.filterMode() : localFilter()
  const setFilterMode = (m: FilterMode) => props.setFilterMode ? props.setFilterMode(m) : setLocalFilter(m)
  const [localShowList, setLocalShowList] = createSignal(true)
  const showList = () => props.showList ? props.showList() : localShowList()
  const setShowList = (v: boolean) => props.setShowList ? props.setShowList(v) : setLocalShowList(v)

  const allProcesses = createMemo(() => {
    const msgs = sync.data.message[props.sessionID] ?? []
    const parts = msgs.flatMap(m => sync.data.part[m.id] ?? [])
    const procs: ProcessEntry[] = []

    for (const part of parts) {
      if (part.type !== "tool" || part.tool !== "bash") continue
      const state = part.state
      const cmd = typeof state.input === "string"
        ? state.input
        : state.input?.command ?? "unknown"

      procs.push({
        id: part.id,
        command: cmd,
        state: state.status === "running" ? "running"
          : state.status === "error" ? "error" : "completed",
        output: state.output ?? state.error ?? "",
        startTime: state.time?.start ?? 0,
        endTime: state.time?.end,
        exitCode: state.metadata?.exit,
      })
    }

    return procs
  })

  const processes = createMemo(() => {
    const mode = filterMode()
    if (mode === "all") return allProcesses()
    if (mode === "running") return allProcesses().filter(p => p.state === "running")
    return allProcesses().filter(p => p.state !== "running")
  })

  const current = createMemo(() => processes()[selected()])

  const runningCount = createMemo(() => allProcesses().filter(p => p.state === "running").length)
  const doneCount = createMemo(() => allProcesses().filter(p => p.state !== "running").length)

  const filterLabel = () => {
    const mode = filterMode()
    if (mode === "all") return "all"
    if (mode === "running") return "running"
    return "done"
  }

  useKeyboard((evt) => {
    // Ctrl+W toggle list
    if (evt.ctrl && evt.name === "w") {
      evt.preventDefault()
      setShowList(!showList())
      return
    }
    // Ctrl+F cycle filter
    if (evt.ctrl && evt.name === "f") {
      evt.preventDefault()
      const order: FilterMode[] = ["running", "done", "all"]
      const idx = order.indexOf(filterMode())
      setFilterMode(order[(idx + 1) % order.length])
      setSelected(0)
      return
    }
    const count = processes().length
    if (!count) return
    if (evt.ctrl && evt.name === "up") {
      evt.preventDefault()
      setSelected(s => Math.max(0, s - 1))
    }
    if (evt.ctrl && evt.name === "down") {
      evt.preventDefault()
      setSelected(s => Math.min(count - 1, s + 1))
    }
    // Ctrl+K to kill running process (aborts the session)
    if (evt.ctrl && evt.name === "k") {
      evt.preventDefault()
      const proc = current()
      if (proc && proc.state === "running") {
        sdk.client.session.abort({ sessionID: props.sessionID }).catch(() => {})
      }
    }
  })

  const stateColor = (state: ProcessState) => {
    if (state === "running") return theme.warning
    if (state === "completed") return theme.success
    return theme.error
  }

  const elapsed = (proc: ProcessEntry) => {
    const end = proc.endTime ?? Date.now()
    const ms = end - proc.startTime
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  }

  const shortCmd = (cmd: string) => {
    const first = cmd.split("\n")[0]
    return first.length > 45 ? first.slice(0, 42) + "..." : first
  }

  const cleanOutput = (text: string) => {
    try { return stripAnsi(text) } catch { return text }
  }

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
          <b>{`${allProcesses().length} process${allProcesses().length !== 1 ? "es" : ""}`}</b>
        </text>
        <box flexDirection="row" gap={1}>
          <For each={TERMINAL_FILTERS}>
            {(f) => {
              const count = () => f.mode === "running" ? runningCount() : f.mode === "done" ? doneCount() : allProcesses().length
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
      <Show when={processes().length === 0}>
        <box paddingLeft={1} paddingTop={1}>
          <text fg={theme.textMuted}>
            {allProcesses().length > 0 ? `No ${filterLabel()} processes` : "No bash processes"}
          </text>
        </box>
      </Show>
      <Show when={processes().length > 0}>
        <box flexGrow={1} flexDirection="row">
          {/* Process list - collapsible via width */}
          <box width={showList() ? "35%" : 0}>
            <Show when={showList()}>
              <scrollbox flexGrow={1}>
                <For each={processes()}>
                  {(proc, i) => {
                    const isSelected = () => i() === selected()
                    return (
                      <box
                        backgroundColor={isSelected() ? theme.backgroundElement : undefined}
                        onMouseDown={() => setSelected(i())}
                        paddingLeft={1}
                        paddingRight={1}
                      >
                        <box flexDirection="row" justifyContent="space-between">
                          <box flexDirection="row" gap={1}>
                            <text fg={stateColor(proc.state)}>{"\u25CF"}</text>
                            <text fg={isSelected() ? theme.text : theme.textMuted} wrapMode="none">
                              {shortCmd(proc.command)}
                            </text>
                          </box>
                          <text fg={theme.textMuted}>{elapsed(proc)}</text>
                        </box>
                      </box>
                    )
                  }}
                </For>
              </scrollbox>
            </Show>
          </box>
          <box width={showList() ? 1 : 0} border={showList() ? ["left"] : undefined} borderColor={theme.border} />
          {/* Terminal-style output */}
          <box flexGrow={1}>
            <Show when={current()}>
              {(proc) => (
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
                  >
                    <box flexDirection="row" gap={1}>
                      <text fg={stateColor(proc().state)}>{"\u25CF"}</text>
                      <text fg={theme.text} wrapMode="none"><b>{shortCmd(proc().command)}</b></text>
                    </box>
                    <text fg={theme.textMuted}>{elapsed(proc())}</text>
                  </box>
                  <scrollbox flexGrow={1} backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1} ref={(r: any) => {
                    createEffect(() => {
                      proc().output // track output changes
                      setTimeout(() => { try { r.scrollTo(r.scrollHeight) } catch {} }, 50)
                    })
                  }}>
                    <text>
                      <span style={{ fg: theme.success }}>{"$ "}</span>
                      <span style={{ fg: theme.text }}>{proc().command}</span>
                    </text>
                    <Show when={proc().output}>
                      <text fg={theme.text} wrapMode="word">{cleanOutput(proc().output)}</text>
                    </Show>
                    <Show when={!proc().output}>
                      <text fg={theme.textMuted}>
                        {proc().state === "running" ? "(waiting for output...)" : "(no output)"}
                      </text>
                    </Show>
                    <Show when={proc().exitCode !== undefined}>
                      <text fg={proc().exitCode === 0 ? theme.success : theme.error}>
                        {proc().exitCode === 0
                          ? "\u2500\u2500\u2500 exited (0)"
                          : `\u2500\u2500\u2500 exited (${proc().exitCode})`}
                      </text>
                    </Show>
                  </scrollbox>
                </box>
              )}
            </Show>
          </box>
        </box>
      </Show>
    </box>
  )
}
