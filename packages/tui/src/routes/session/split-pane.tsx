import { Show, type ParentProps, type Accessor, For } from "solid-js"
import { useTheme } from "../../context/theme"
import { useKeyboard } from "@opentui/solid"
import { SplitBorder } from "../../ui/border"

export type SecondaryMode = "files" | "terminal" | "agents" | "plan" | "none"

const TABS: { mode: SecondaryMode; label: string }[] = [
  { mode: "agents", label: "Agents" },
  { mode: "terminal", label: "Terminal" },
  { mode: "files", label: "Files" },
  { mode: "plan", label: "Plan" },
]

export function SplitPane(
  props: ParentProps<{
    width: number
    height: number
    secondary: Accessor<SecondaryMode>
    setSecondary: (mode: SecondaryMode | ((prev: SecondaryMode) => SecondaryMode)) => void
    ratio: Accessor<number>
    setRatio: (r: number | ((prev: number) => number)) => void
    secondaryContent?: any
    hasAgents?: boolean
    lastTab?: Accessor<Exclude<SecondaryMode, "none">>
  }>,
) {
  const { theme } = useTheme()

  const primaryWidth = () => {
    if (props.secondary() === "none") return props.width
    return Math.floor(props.width * props.ratio())
  }

  const secondaryWidth = () => props.width - primaryWidth() - 1

  useKeyboard((evt) => {
    // Ctrl+B to toggle pane
    if (evt.ctrl && evt.name === "b") {
      evt.preventDefault()
      if (props.secondary() === "none") {
        props.setSecondary(props.lastTab?.() ?? "terminal")
      } else {
        props.setSecondary("none")
      }
      return
    }

    if (props.secondary() === "none") return

    // Ctrl+Left/Right to resize
    if (evt.ctrl && evt.name === "left") {
      evt.preventDefault()
      props.setRatio(Math.max(0.2, props.ratio() - 0.05))
    }
    if (evt.ctrl && evt.name === "right") {
      evt.preventDefault()
      props.setRatio(Math.min(0.8, props.ratio() + 0.05))
    }
    // Ctrl+Tab to cycle tabs
    if (evt.ctrl && evt.name === "q") {
      evt.preventDefault()
      const visible = TABS.filter((t) => t.mode !== "agents" || props.hasAgents)
      const current = visible.findIndex((t) => t.mode === props.secondary())
      const next = (current + 1) % visible.length
      props.setSecondary(visible[next].mode)
    }
    // Ctrl+1/2/3/4 to jump to tab
    if (evt.ctrl && (evt.name === "1" || evt.name === "2" || evt.name === "3" || evt.name === "4")) {
      evt.preventDefault()
      const tab = TABS[Number(evt.name) - 1]
      if (tab && (tab.mode !== "agents" || props.hasAgents)) {
        props.setSecondary(tab.mode)
      }
    }
  })

  return (
    <box flexDirection="row" width={props.width} height={props.height}>
      <box width={primaryWidth()} height={props.height}>
        {props.children}
      </box>
      <Show when={props.secondary() !== "none"}>
        <box
          width={1}
          height={props.height}
          border={["left"]}
          borderColor={theme.border}
          customBorderChars={SplitBorder.customBorderChars}
        />
        <box width={secondaryWidth()} height={props.height}>
          {/* Tab bar */}
          <box
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            flexShrink={0}
            backgroundColor={theme.backgroundPanel}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            marginBottom={1}
          >
            <box flexDirection="row" gap={3}>
              <For each={TABS}>
                {(tab) => {
                  const active = () => props.secondary() === tab.mode
                  const show = () => tab.mode !== "agents" || props.hasAgents
                  return (
                    <Show when={show()}>
                      <text
                        fg={active() ? theme.accent : theme.textMuted}
                        onMouseDown={() => props.setSecondary(tab.mode)}
                      >
                        {active() ? `● ${tab.label}` : `  ${tab.label}`}
                      </text>
                    </Show>
                  )
                }}
              </For>
            </box>
            <text fg={theme.textMuted} onMouseDown={() => props.setSecondary("none")}>
              {"✕"}
            </text>
          </box>
          {/* Content */}
          <box flexGrow={1}>{props.secondaryContent}</box>
          {/* Footer with keybindings */}
          <box flexDirection="row" flexShrink={0} gap={2} paddingLeft={1} paddingRight={1}>
            <text fg={theme.text}>
              {"ctrl+↑↓"} <span style={{ fg: theme.textMuted }}>nav</span>
            </text>
            <text fg={theme.text}>
              ctrl+q <span style={{ fg: theme.textMuted }}>tab</span>
            </text>
            <text fg={theme.text}>
              ctrl+w <span style={{ fg: theme.textMuted }}>list</span>
            </text>
            <text fg={theme.text}>
              ctrl+f <span style={{ fg: theme.textMuted }}>filter</span>
            </text>
            <text fg={theme.text}>
              ctrl+o <span style={{ fg: theme.textMuted }}>close</span>
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}
