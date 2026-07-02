import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"

export function ProgressDashboard(props: { sessionID: string }) {
  const { theme } = useTheme()
  const sync = useSync()

  // Deduplicate sub-agents by title, keeping the most recent one
  const subAgents = createMemo(() => {
    const all = sync.data.session.filter(s => s.parentID === props.sessionID)
    const byTitle = new Map<string, typeof all[0]>()
    for (const s of all) {
      const title = s.title ?? s.id
      const existing = byTitle.get(title)
      if (!existing || s.time.created > existing.time.created) {
        byTitle.set(title, s)
      }
    }
    return Array.from(byTitle.values()).sort((a, b) => a.time.created - b.time.created)
  })

  const activeAgents = createMemo(() =>
    subAgents().filter(s => {
      const status = sync.data.session_status[s.id]
      return status?.type === "busy"
    })
  )

  // Only show when there are active sub-agents
  const hasActive = createMemo(() => activeAgents().length > 0)

  function agentElapsed(agent: { time: { created: number } }): string {
    const ms = Date.now() - agent.time.created
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
  }

  return (
    <Show when={hasActive()}>
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text}><b>Sub-agents</b></text>
          <text fg={theme.textMuted}>{activeAgents().length} active</text>
        </box>

        <box
          backgroundColor={theme.backgroundElement}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <For each={activeAgents()}>
            {(agent) => {
              return (
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <span style={{ fg: theme.warning }}>{"\u25CF"}</span> {agent.title ?? agent.id.slice(0, 8)}
                  </text>
                  <text fg={theme.textMuted}>
                    {agentElapsed(agent)}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </box>
    </Show>
  )
}
