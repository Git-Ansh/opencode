import { useSync } from "@tui/context/sync"
import { createMemo, createEffect, untrack, For, Show, Switch, Match, createSignal, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"
import path from "path"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { useKeybind } from "../../context/keybind"
import { useKeyboard } from "@opentui/solid"
import { useDirectory } from "../../context/directory"
import { useLocal } from "../../context/local"
import { useKV } from "../../context/kv"
import { TodoItem } from "../../component/todo-item"
import { ProgressDashboard } from "../../component/progress-dashboard"
import { FileTree } from "../../component/file-tree"

function SidebarSection(props: ParentProps<{
  title: string
  badge?: string
  expanded?: boolean
  onToggle?: () => void
}>) {
  const { theme } = useTheme()
  return (
    <box>
      <box
        flexDirection="row"
        justifyContent="space-between"
        onMouseDown={() => props.onToggle?.()}
        paddingBottom={0}
      >
        <box flexDirection="row" gap={1}>
          <Show when={props.onToggle}>
            <text fg={theme.textMuted}>{props.expanded ? "\u25BC" : "\u25B6"}</text>
          </Show>
          <text fg={theme.text}><b>{props.title}</b></text>
        </box>
        <Show when={props.badge}>
          <text fg={theme.textMuted}>{props.badge}</text>
        </Show>
      </box>
      <Show when={props.expanded !== false}>
        <box
          backgroundColor={theme.backgroundElement}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          {props.children}
        </box>
      </Show>
    </box>
  )
}

interface UsageEntry {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  requests: number
}

interface SessionUsageEntry extends UsageEntry {
  title: string
}

interface UsageTracking {
  periodStart: number
  models: Record<string, UsageEntry>
  sessions: Record<string, SessionUsageEntry>
  processed: string[]
}

function defaultUsageTracking(): UsageTracking {
  return { periodStart: Date.now(), models: {}, sessions: {}, processed: [] }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)
}

function modelDisplayName(providerID: string, modelID: string, providers: any[]): string {
  const provider = providers.find((x: any) => x.id === providerID)
  const model = provider?.models[modelID]
  if (model?.name) return model.name
  // Strip common prefixes/paths from model IDs
  const parts = modelID.split("/")
  return parts[parts.length - 1]
}

function barSegment(fraction: number, width: number): string {
  const chars = Math.round(fraction * width)
  return chars > 0 ? "\u2588".repeat(chars) : ""
}

function emptySegment(used: number, width: number): string {
  const chars = width - Math.round(used * width)
  return chars > 0 ? "\u2591".repeat(chars) : ""
}

export function Sidebar(props: { sessionID: string; overlay?: boolean; onFileSelect?: (filepath: string) => void; splitPaneActive?: boolean }) {
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const [sidebarTab, setSidebarTab] = createSignal<"info" | "files">("info")

  // Ctrl+Y to cycle sidebar tabs
  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "y") {
      evt.preventDefault()
      setSidebarTab(t => t === "info" ? "files" : "info")
    }
  })

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: true,
    todo: true,
    lsp: true,
    usage: false,
    progress: true,
  })

  // Sort MCP servers alphabetically for consistent display order
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))

  // Count connected and error MCP servers for collapsed header display
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, item]) => item.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, item]) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const contextDetails = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && (x.tokens.output || 0) > 0) as AssistantMessage
    if (!last) return
    const input = last.tokens.input || 0
    const output = last.tokens.output || 0
    const reasoning = last.tokens.reasoning || 0
    const cache = (last.tokens.cache?.read || 0) + (last.tokens.cache?.write || 0)
    const total = input + output + reasoning + cache
    // Use currently selected model's context limit so it updates on model switch
    const current = local.model.current()
    const currentProvider = current ? sync.data.provider.find((x) => x.id === current.providerID) : undefined
    const currentModel = current ? currentProvider?.models[current.modelID] : undefined
    const lastModel = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    const activeModel = currentModel ?? lastModel
    const contextLimit = activeModel?.limit.context ?? 0
    const modelName = activeModel?.name ?? currentModel?.id ?? lastModel?.id ?? ""
    const percentage = contextLimit ? Math.round((total / contextLimit) * 100) : 0
    const used = contextLimit ? Math.min(total / contextLimit, 1) : 0
    return {
      input,
      output,
      reasoning,
      cache,
      total,
      contextLimit,
      modelName,
      percentage,
      inputFrac: contextLimit ? input / contextLimit : 0,
      cacheFrac: contextLimit ? cache / contextLimit : 0,
      outputFrac: contextLimit ? output / contextLimit : 0,
      reasoningFrac: contextLimit ? reasoning / contextLimit : 0,
      used,
    }
  })

  const directory = useDirectory()
  const kv = useKV()

  // Drop sessions that no longer exist in sync from the usage tracking KV.
  // Triggered whenever the session list changes (e.g. after a delete event).
  createEffect(() => {
    const liveIDs = new Set(sync.data.session.map((s) => s.id))
    untrack(() => {
      const stored = kv.get("usage_tracking", defaultUsageTracking())
      const tracking: UsageTracking = JSON.parse(JSON.stringify(stored))
      if (!tracking.sessions) return
      let changed = false
      for (const id of Object.keys(tracking.sessions)) {
        if (!liveIDs.has(id)) {
          delete tracking.sessions[id]
          changed = true
        }
      }
      if (changed) {
        // Also drop processed-message keys that point at deleted sessions
        // so the dedup list doesn't grow forever with dead entries.
        tracking.processed = tracking.processed.filter((k) => {
          const sid = k.split("::")[0]
          return liveIDs.has(sid)
        })
        kv.set("usage_tracking", tracking)
      }
    })
  })

  // Usage tracking: accumulate per-model and per-session token/cost data persistently.
  // Plain createEffect (not on()) so Solid tracks message completion properties.
  // This ensures the effect re-runs when a message transitions from streaming to completed.
  createEffect(() => {
    const msgs = messages()
    if (!msgs.length) return

    // Read session title reactively so it updates in tracking
    const sessionTitle = session()?.title ?? "Untitled"

    // Filter completed assistant messages — accessing .time.completed and .tokens.output
    // on each message creates reactive deps so the effect re-runs when these change
    const completed = msgs.filter((m) => {
      if (m.role !== "assistant") return false
      const am = m as AssistantMessage
      return am.time.completed && (am.tokens.output || 0) > 0
    }) as AssistantMessage[]

    if (!completed.length) return

    // Use untrack for KV reads/writes to avoid dependency loops
    untrack(() => {
      // Deep clone to avoid mutating Solid store proxy directly
      const stored = kv.get("usage_tracking", defaultUsageTracking())
      const tracking: UsageTracking = JSON.parse(JSON.stringify(stored))
      // Migrate old data that lacks sessions field
      if (!tracking.sessions) tracking.sessions = {}

      // Auto-reset if > 30 days since periodStart
      const thirtyDays = 30 * 24 * 60 * 60 * 1000
      if (Date.now() - tracking.periodStart > thirtyDays) {
        kv.set("usage_tracking", defaultUsageTracking())
        return
      }

      const processedSet = new Set(tracking.processed)
      let changed = false

      for (const am of completed) {
        const dedupKey = `${props.sessionID}::${am.id}`
        if (processedSet.has(dedupKey)) continue

        const emptyEntry = (): UsageEntry => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 })
        const tokIn = am.tokens.input || 0
        const tokOut = am.tokens.output || 0
        const tokReason = am.tokens.reasoning || 0
        const tokCacheR = am.tokens.cache?.read || 0
        const tokCacheW = am.tokens.cache?.write || 0
        const msgCost = am.cost || 0

        // Per-model accumulation
        const modelKey = `${am.providerID}::${am.modelID}`
        if (!tracking.models[modelKey]) tracking.models[modelKey] = emptyEntry()
        const me = tracking.models[modelKey]
        me.input += tokIn; me.output += tokOut; me.reasoning += tokReason
        me.cacheRead += tokCacheR; me.cacheWrite += tokCacheW
        me.cost += msgCost; me.requests += 1

        // Per-session accumulation
        if (!tracking.sessions[props.sessionID]) {
          tracking.sessions[props.sessionID] = { ...emptyEntry(), title: sessionTitle }
        }
        const se = tracking.sessions[props.sessionID]
        se.title = sessionTitle
        se.input += tokIn; se.output += tokOut; se.reasoning += tokReason
        se.cacheRead += tokCacheR; se.cacheWrite += tokCacheW
        se.cost += msgCost; se.requests += 1

        tracking.processed.push(dedupKey)
        processedSet.add(dedupKey)
        changed = true
      }

      // Prune processed list if too large
      if (tracking.processed.length > 10000) {
        tracking.processed = tracking.processed.slice(-5000)
      }

      if (changed) {
        kv.set("usage_tracking", tracking)
      }
    })
  })

  // Usage data for display — kv.get creates a reactive dep on the KV store key,
  // so these memos re-run whenever kv.set("usage_tracking", ...) is called
  const usageData = createMemo(() => {
    const raw = kv.get("usage_tracking", defaultUsageTracking())
    const tracking: UsageTracking = JSON.parse(JSON.stringify(raw))
    if (!tracking.sessions) tracking.sessions = {}

    const modelEntries: { displayName: string; entry: UsageEntry }[] = []
    for (const [key, entry] of Object.entries(tracking.models)) {
      const [providerID, modelID] = key.split("::")
      const name = modelDisplayName(providerID, modelID, sync.data.provider)
      modelEntries.push({ displayName: Locale.truncate(name, 26), entry })
    }
    modelEntries.sort((a, b) => b.entry.cost - a.entry.cost)

    const sessionEntries: { id: string; title: string; entry: SessionUsageEntry; isCurrent: boolean }[] = []
    for (const [id, entry] of Object.entries(tracking.sessions)) {
      sessionEntries.push({
        id,
        title: Locale.truncate(entry.title, 26),
        entry,
        isCurrent: id === props.sessionID,
      })
    }
    sessionEntries.sort((a, b) => b.entry.cost - a.entry.cost)

    return { modelEntries, sessionEntries, periodStart: tracking.periodStart }
  })

  const totalUsageCost = createMemo(() => {
    const raw = kv.get("usage_tracking", defaultUsageTracking())
    const tracking: UsageTracking = JSON.parse(JSON.stringify(raw))
    return Object.values(tracking.models).reduce((sum, e) => sum + e.cost, 0)
  })

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const gettingStartedDismissed = createMemo(() => kv.get("dismissed_getting_started", false))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <box paddingRight={1}>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>
            <box flexDirection="row" gap={2} paddingBottom={1}>
              <text
                fg={sidebarTab() === "info" ? theme.accent : theme.textMuted}
                onMouseDown={() => setSidebarTab("info")}
              >
                {sidebarTab() === "info" ? "\u25CF " : "  "}Info
              </text>
              <text
                fg={sidebarTab() === "files" ? theme.accent : theme.textMuted}
                onMouseDown={() => setSidebarTab("files")}
              >
                {sidebarTab() === "files" ? "\u25CF " : "  "}Project
              </text>
            </box>
            <Show when={sidebarTab() === "files"}>
              <FileTree
                width={36}
                modifiedFiles={diff().map((d) => d.file)}
                active={!props.splitPaneActive}
                onSelect={(filepath) => {
                  props.onFileSelect?.(filepath)
                }}
              />
            </Show>
            <Show when={sidebarTab() === "info"}>
            <SidebarSection title="Context" badge={cost()}>
              <Show when={contextDetails()} fallback={<text fg={theme.textMuted}>No data yet</text>}>
                {(ctx) => {
                  const BAR_WIDTH = 32
                  return (
                    <>
                      <text>
                        <span style={{ fg: theme.accent }}>{barSegment(ctx().inputFrac, BAR_WIDTH)}</span>
                        <span style={{ fg: theme.info }}>{barSegment(ctx().cacheFrac, BAR_WIDTH)}</span>
                        <span style={{ fg: theme.success }}>{barSegment(ctx().outputFrac, BAR_WIDTH)}</span>
                        <span style={{ fg: theme.warning }}>{barSegment(ctx().reasoningFrac, BAR_WIDTH)}</span>
                        <span style={{ fg: theme.textMuted }}>{emptySegment(ctx().used, BAR_WIDTH)}</span>
                      </text>
                      <text fg={theme.textMuted}>
                        {ctx().percentage}% of {Locale.number(ctx().contextLimit)} ctx{ctx().modelName ? ` (${ctx().modelName})` : ""}
                      </text>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>Input {Locale.number(ctx().input)}</text>
                        <text fg={theme.textMuted}>Cache {Locale.number(ctx().cache)}</text>
                      </box>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>Output {Locale.number(ctx().output)}</text>
                        <text fg={theme.textMuted}>Reason {Locale.number(ctx().reasoning)}</text>
                      </box>
                    </>
                  )
                }}
              </Show>
            </SidebarSection>
            <Show when={usageData().modelEntries.length > 0}>
              <SidebarSection
                title="Usage"
                badge={formatCurrency(totalUsageCost())}
                expanded={expanded.usage}
                onToggle={() => setExpanded("usage", !expanded.usage)}
              >
                  <text fg={theme.textMuted}>
                    Since {new Date(usageData().periodStart).toLocaleDateString()}
                  </text>

                  <text fg={theme.border}>{"\u2500".repeat(32)}</text>
                  <text fg={theme.text}><b>By Model</b></text>
                  <For each={usageData().modelEntries}>
                    {(item) => (
                      <box>
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.text}>{item.displayName}</text>
                          <text fg={theme.accent}>{formatCurrency(item.entry.cost)}</text>
                        </box>
                        <text fg={theme.textMuted}>
                          in {Locale.number(item.entry.input)} / out {Locale.number(item.entry.output)} / cache {Locale.number(item.entry.cacheRead + item.entry.cacheWrite)}
                        </text>
                      </box>
                    )}
                  </For>

                  <Show when={usageData().sessionEntries.length > 0}>
                    <text fg={theme.border}>{"\u2500".repeat(32)}</text>
                    <text fg={theme.text}><b>By Session</b></text>
                    <For each={usageData().sessionEntries}>
                      {(item) => (
                        <box>
                          <box flexDirection="row" justifyContent="space-between">
                            <text fg={item.isCurrent ? theme.accent : theme.text}>
                              {item.isCurrent ? "\u25CF " : "  "}{item.title}
                            </text>
                            <text fg={theme.accent}>{formatCurrency(item.entry.cost)}</text>
                          </box>
                          <text fg={theme.textMuted}>
                            {item.entry.requests} req / {Locale.number(item.entry.input + item.entry.output + item.entry.cacheRead + item.entry.cacheWrite)} tok
                          </text>
                        </box>
                      )}
                    </For>
                  </Show>

                  <text fg={theme.border}>{"\u2500".repeat(32)}</text>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.text}><b>Total</b></text>
                    <text fg={theme.text}><b>{formatCurrency(totalUsageCost())}</b></text>
                  </box>
              </SidebarSection>
            </Show>
            <Show when={mcpEntries().length > 0}>
              <SidebarSection
                title="MCP"
                badge={`${connectedMcpCount()}/${mcpEntries().length}`}
                expanded={mcpEntries().length <= 2 || expanded.mcp}
                onToggle={mcpEntries().length > 2 ? () => setExpanded("mcp", !expanded.mcp) : undefined}
              >
                  <For each={mcpEntries()}>
                    {([key, item]) => (
                      <box flexDirection="row" justifyContent="space-between">
                        <box flexDirection="row" gap={1}>
                          <text
                            flexShrink={0}
                            style={{
                              fg: (
                                {
                                  connected: theme.success,
                                  failed: theme.error,
                                  disabled: theme.textMuted,
                                  needs_auth: theme.warning,
                                  needs_client_registration: theme.error,
                                } as Record<string, typeof theme.success>
                              )[item.status],
                            }}
                          >
                            •
                          </text>
                          <text fg={theme.text}>{key}</text>
                        </box>
                        <text fg={theme.textMuted}>
                          <Switch fallback={item.status}>
                            <Match when={item.status === "connected"}>Connected</Match>
                            <Match when={item.status === "failed" && item}>{(val) => <i>{val().error}</i>}</Match>
                            <Match when={item.status === "disabled"}>Disabled</Match>
                            <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                            <Match when={(item.status as string) === "needs_client_registration"}>
                              Needs client ID
                            </Match>
                          </Switch>
                        </text>
                      </box>
                    )}
                  </For>
              </SidebarSection>
            </Show>
            <SidebarSection
              title="LSP"
              badge={`${sync.data.lsp.filter(l => l.status === "connected").length}/${sync.data.lsp.length}`}
              expanded={sync.data.lsp.length <= 2 || expanded.lsp}
              onToggle={sync.data.lsp.length > 2 ? () => setExpanded("lsp", !expanded.lsp) : undefined}
            >
                <Show when={sync.data.lsp.length === 0}>
                  <text fg={theme.textMuted}>
                    {sync.data.config.lsp === false
                      ? "LSPs have been disabled in settings"
                      : "LSPs will activate as files are read"}
                  </text>
                </Show>
                <For each={sync.data.lsp}>
                  {(item) => (
                    <box flexDirection="row" justifyContent="space-between">
                      <box flexDirection="row" gap={1}>
                        <text
                          flexShrink={0}
                          style={{
                            fg: {
                              connected: theme.success,
                              error: theme.error,
                            }[item.status],
                          }}
                        >
                          •
                        </text>
                        <text fg={theme.text}>{item.id}</text>
                      </box>
                      <text fg={theme.textMuted}>{item.root}</text>
                    </box>
                  )}
                </For>
            </SidebarSection>
            <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
              {(() => {
                const todoCompleted = () => todo().filter(t => t.status === "completed").length
                const todoTotal = () => todo().length
                const todoPct = () => todoTotal() > 0 ? Math.round(todoCompleted() / todoTotal() * 100) : 0
                const todoBar = () => {
                  const filled = Math.round((todoPct() / 100) * 30)
                  return "\u2588".repeat(filled) + "\u2591".repeat(30 - filled)
                }
                return (
                  <SidebarSection
                    title="Todo"
                    badge={`${todoCompleted()}/${todoTotal()} (${todoPct()}%)`}
                    expanded={todo().length <= 2 || expanded.todo}
                    onToggle={todo().length > 2 ? () => setExpanded("todo", !expanded.todo) : undefined}
                  >
                    <text>
                      <span style={{ fg: theme.success }}>{todoBar()}</span>
                    </text>
                    <For each={todo()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
                  </SidebarSection>
                )
              })()}
            </Show>
            <Show when={diff().length > 0}>
              <SidebarSection
                title="Modified Files"
                badge={`${diff().length}`}
                expanded={diff().length <= 2 || expanded.diff}
                onToggle={diff().length > 2 ? () => setExpanded("diff", !expanded.diff) : undefined}
              >
                  <For each={diff() || []}>
                    {(item) => {
                      return (
                        <box flexDirection="row" gap={1} justifyContent="space-between">
                          <text fg={theme.textMuted} wrapMode="none">
                            {item.file}
                          </text>
                          <box flexDirection="row" gap={1} flexShrink={0}>
                            <Show when={item.additions}>
                              <text fg={theme.diffAdded}>+{item.additions}</text>
                            </Show>
                            <Show when={item.deletions}>
                              <text fg={theme.diffRemoved}>-{item.deletions}</text>
                            </Show>
                          </box>
                        </box>
                      )
                    }}
                  </For>
              </SidebarSection>
            </Show>
            <ProgressDashboard sessionID={props.sessionID} />
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Show when={!hasProviders() && !gettingStartedDismissed()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} fg={theme.text}>
                ⬖
              </text>
              <box flexGrow={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Getting started</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                    ✕
                  </text>
                </box>
                <text fg={theme.textMuted}>OpenCode includes free models so you can start immediately.</text>
                <text fg={theme.textMuted}>
                  Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
                </text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme.text}>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <Show when={sidebarTab() === "files"}>
            <box flexDirection="row" gap={2} flexShrink={0}>
              <text fg={theme.text}>{"shift+\u2191\u2193"} <span style={{ fg: theme.textMuted }}>nav</span></text>
              <text fg={theme.text}>{"shift+\u2192"} <span style={{ fg: theme.textMuted }}>open</span></text>
              <text fg={theme.text}>click <span style={{ fg: theme.textMuted }}>select</span></text>
            </box>
          </Show>
          <box flexDirection="row" gap={2} flexShrink={0}>
            <text fg={theme.text}>ctrl+l <span style={{ fg: theme.textMuted }}>sidebar</span></text>
            <text fg={theme.text}>ctrl+y <span style={{ fg: theme.textMuted }}>tab</span></text>
            <text fg={theme.text}>ctrl+b <span style={{ fg: theme.textMuted }}>pane</span></text>
          </box>
          <text>
            <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
            <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
        </box>
      </box>
    </Show>
  )
}
