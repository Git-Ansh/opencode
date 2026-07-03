import { createSignal, For, Show, createMemo, Switch, Match, type Accessor, createEffect } from "solid-js"
import { useTheme } from "../../context/theme"
import { useKeyboard } from "@opentui/solid"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import type { ToolPart } from "@opencode-ai/sdk/v2"

// Strip markdown formatting for clean display
function cleanMd(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "") // headers
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/\*(.+?)\*/g, "$1") // italic
    .replace(/`{3}[\s\S]*?`{3}/g, "[code]") // code blocks
    .replace(/`(.+?)`/g, "$1") // inline code
    .replace(/^\s*[-*+]\s+/gm, "  • ") // list items
    .replace(/^\s*\d+\.\s+/gm, "  ") // numbered lists
    .trim()
}

type PartItem = {
  type: "text" | "thinking" | "tool-running" | "tool-done" | "tool-error"
  content: string
  toolName?: string
  toolOutput?: string
}

type FilterMode = "all" | "active" | "done"
const AGENT_FILTERS: { mode: FilterMode; label: string }[] = [
  { mode: "active", label: "Active" },
  { mode: "done", label: "Done" },
  { mode: "all", label: "All" },
]

// Tool state varies by status (pending/running/completed/error) — narrow before reading
// status-specific fields like title/output/error (see ToolPart in @opencode-ai/sdk/v2).
function toolItem(part: ToolPart): PartItem | undefined {
  const state = part.state
  if (state.status === "running") {
    const title = state.title ?? part.tool
    return { type: "tool-running", toolName: title, content: title }
  }
  if (state.status === "completed") {
    const title = state.title ?? part.tool
    const output = (state.output ?? "").slice(0, 200)
    return { type: "tool-done", toolName: title, toolOutput: output, content: title }
  }
  if (state.status === "error") {
    return { type: "tool-error", content: `${part.tool}: ${state.error ?? "error"}` }
  }
  return undefined
}

export function AgentsView(props: {
  sessionID: string
  filterMode?: Accessor<FilterMode>
  setFilterMode?: (m: FilterMode) => void
  showList?: Accessor<boolean>
  setShowList?: (v: boolean) => void
}) {
  const { theme } = useTheme()
  const sync = useSync()
  const sdk = useSDK()
  const [selected, setSelected] = createSignal(0)
  const [localFilter, setLocalFilter] = createSignal<FilterMode>("active")
  const filterMode = () => (props.filterMode ? props.filterMode() : localFilter())
  const setFilterMode = (m: FilterMode) => (props.setFilterMode ? props.setFilterMode(m) : setLocalFilter(m))
  const [localShowList, setLocalShowList] = createSignal(true)
  const showList = () => (props.showList ? props.showList() : localShowList())
  const setShowList = (v: boolean) => (props.setShowList ? props.setShowList(v) : setLocalShowList(v))

  const allAgents = createMemo(() => {
    const all = sync.data.session.filter((s) => s.parentID === props.sessionID)
    const byTitle = new Map<string, (typeof all)[0]>()
    for (const s of all) {
      const title = s.title ?? s.id
      const existing = byTitle.get(title)
      if (!existing || s.time.created > existing.time.created) {
        byTitle.set(title, s)
      }
    }
    return Array.from(byTitle.values()).sort((a, b) => a.time.created - b.time.created)
  })

  const isBusy = (agentId: string) => sync.data.session_status[agentId]?.type === "busy"

  const agents = createMemo(() => {
    const mode = filterMode()
    if (mode === "all") return allAgents()
    if (mode === "active") return allAgents().filter((a) => isBusy(a.id))
    return allAgents().filter((a) => !isBusy(a.id))
  })

  const cycleFilter = () => {
    const order: FilterMode[] = ["active", "done", "all"]
    const idx = order.indexOf(filterMode())
    setFilterMode(order[(idx + 1) % order.length])
    setSelected(0)
  }

  const activeCount = createMemo(() => allAgents().filter((a) => isBusy(a.id)).length)

  const current = createMemo(() => agents()[selected()])

  const currentParts = createMemo((): PartItem[] => {
    const agent = current()
    if (!agent) return []
    const agentMsgs = sync.data.message[agent.id] ?? []
    const items: PartItem[] = []
    for (const msg of agentMsgs) {
      const msgParts = sync.data.part[msg.id] ?? []
      for (const p of msgParts) {
        if (p.type === "text" && !p.synthetic && p.text) {
          items.push({ type: "text", content: cleanMd(p.text) })
        } else if (p.type === "reasoning" && p.text) {
          items.push({ type: "thinking", content: p.text.slice(0, 200) })
        } else if (p.type === "tool" && p.tool) {
          const item = toolItem(p)
          if (item) items.push(item)
        }
      }
    }
    return items
  })

  const filterLabel = () => {
    const mode = filterMode()
    if (mode === "all") return "all"
    if (mode === "active") return "active"
    return "done"
  }

  const doneCount = createMemo(() => allAgents().filter((a) => !isBusy(a.id)).length)

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
      cycleFilter()
      return
    }
    const count = agents().length
    if (!count) return
    if (evt.ctrl && evt.name === "up") {
      evt.preventDefault()
      setSelected((s) => Math.max(0, s - 1))
    }
    if (evt.ctrl && evt.name === "down") {
      evt.preventDefault()
      setSelected((s) => Math.min(count - 1, s + 1))
    }
    // Ctrl+K to kill selected agent
    if (evt.ctrl && evt.name === "k") {
      evt.preventDefault()
      const agent = current()
      if (agent && isBusy(agent.id)) {
        sdk.client.session.abort({ sessionID: agent.id }).catch(() => {})
      }
    }
  })

  const elapsed = (agent: { time: { created: number } }) => {
    const ms = Date.now() - agent.time.created
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
  }

  return (
    <box flexGrow={1}>
      <Show when={allAgents().length === 0}>
        <box paddingLeft={1} paddingTop={1}>
          <text fg={theme.textMuted}>No sub-agents</text>
        </box>
      </Show>
      <Show when={allAgents().length > 0}>
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
            <b>
              {activeCount() > 0
                ? `${activeCount()} active / ${allAgents().length} total`
                : `${allAgents().length} completed`}
            </b>
          </text>
          <box flexDirection="row" gap={1}>
            <For each={AGENT_FILTERS}>
              {(f) => {
                const count = () =>
                  f.mode === "active" ? activeCount() : f.mode === "done" ? doneCount() : allAgents().length
                return (
                  <text
                    fg={filterMode() === f.mode ? theme.accent : theme.textMuted}
                    onMouseDown={() => {
                      setFilterMode(f.mode)
                      setSelected(0)
                    }}
                  >
                    {filterMode() === f.mode ? `● ${f.label}` : `  ${f.label}`} {count()}
                  </text>
                )
              }}
            </For>
          </box>
        </box>
        <Show when={agents().length === 0}>
          <box paddingLeft={1} paddingTop={1}>
            <text fg={theme.textMuted}>{`No ${filterLabel()} agents`}</text>
          </box>
        </Show>
        <Show when={agents().length > 0}>
          <box flexGrow={1} flexDirection="row">
            {/* Agent list - collapsible via width */}
            <box width={showList() ? "30%" : 0}>
              <Show when={showList()}>
                <scrollbox flexGrow={1}>
                  <For each={agents()}>
                    {(agent, i) => {
                      const busy = () => isBusy(agent.id)
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
                              <text fg={busy() ? theme.warning : theme.success}>{"●"}</text>
                              <text fg={isSelected() ? theme.text : theme.textMuted} wrapMode="none">
                                {(agent.title ?? agent.id.slice(0, 12)).slice(0, 25)}
                              </text>
                            </box>
                            <text fg={theme.textMuted}>{elapsed(agent)}</text>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </scrollbox>
              </Show>
            </box>
            <box width={showList() ? 1 : 0} border={showList() ? ["left"] : undefined} borderColor={theme.border} />
            {/* Agent output */}
            <box flexGrow={1}>
              <Show when={current()}>
                {(agent) => (
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
                      gap={1}
                    >
                      <text fg={isBusy(agent().id) ? theme.warning : theme.success}>{"●"}</text>
                      <text fg={theme.text} wrapMode="none">
                        <b>{(agent().title ?? agent().id).slice(0, 40)}</b>
                      </text>
                    </box>
                    <scrollbox
                      flexGrow={1}
                      paddingLeft={1}
                      ref={(r: any) => {
                        createEffect(() => {
                          currentParts().length // track changes
                          setTimeout(() => {
                            try {
                              r.scrollTo(r.scrollHeight)
                            } catch {}
                          }, 50)
                        })
                      }}
                    >
                      <Show when={currentParts().length === 0}>
                        <text fg={theme.textMuted}>(waiting for output...)</text>
                      </Show>
                      <For each={currentParts()}>
                        {(item) => (
                          <Switch>
                            <Match when={item.type === "text"}>
                              <box paddingBottom={1}>
                                <text fg={theme.text} wrapMode="word">
                                  {item.content}
                                </text>
                              </box>
                            </Match>
                            <Match when={item.type === "thinking"}>
                              <box paddingBottom={1}>
                                <text fg={theme.textMuted} wrapMode="word">
                                  <i>{item.content}</i>
                                </text>
                              </box>
                            </Match>
                            <Match when={item.type === "tool-running"}>
                              <box flexDirection="row" gap={1} paddingBottom={1}>
                                <text fg={theme.warning}>{"●"}</text>
                                <text fg={theme.warning} wrapMode="none">
                                  {item.toolName}
                                </text>
                              </box>
                            </Match>
                            <Match when={item.type === "tool-done"}>
                              <box paddingBottom={1}>
                                <box flexDirection="row" gap={1}>
                                  <text fg={theme.success}>{"●"}</text>
                                  <text fg={theme.text} wrapMode="none">
                                    {item.toolName}
                                  </text>
                                </box>
                                <Show when={item.toolOutput}>
                                  <box paddingLeft={2}>
                                    <text fg={theme.textMuted} wrapMode="word">
                                      {item.toolOutput}
                                    </text>
                                  </box>
                                </Show>
                              </box>
                            </Match>
                            <Match when={item.type === "tool-error"}>
                              <box flexDirection="row" gap={1} paddingBottom={1}>
                                <text fg={theme.error}>{"●"}</text>
                                <text fg={theme.error} wrapMode="word">
                                  {item.content}
                                </text>
                              </box>
                            </Match>
                          </Switch>
                        )}
                      </For>
                    </scrollbox>
                  </box>
                )}
              </Show>
            </box>
          </box>
        </Show>
      </Show>
    </box>
  )
}
