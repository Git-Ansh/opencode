import { For } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTerminalDimensions } from "@opentui/solid"

interface HelpSection {
  title: string
  items: Array<{ keys: string; label: string }>
}

const SECTIONS: HelpSection[] = [
  {
    title: "Sidebar",
    items: [
      { keys: "Ctrl+L", label: "Toggle sidebar" },
      { keys: "Ctrl+Y", label: "Cycle sidebar tabs (Info / Project)" },
      { keys: "Shift+↑↓", label: "Navigate file tree" },
      { keys: "Shift+→", label: "Open / select file" },
    ],
  },
  {
    title: "Split Pane",
    items: [
      { keys: "Ctrl+B", label: "Toggle split pane" },
      { keys: "Ctrl+Q", label: "Cycle tabs (Agents / Terminal / Files)" },
      { keys: "Ctrl+1/2/3", label: "Jump to specific tab" },
      { keys: "Ctrl+W", label: "Toggle list view in pane" },
      { keys: "Ctrl+F", label: "Cycle filter" },
      { keys: "Ctrl+↑↓", label: "Navigate list items" },
      { keys: "Ctrl+←→", label: "Resize pane" },
      { keys: "Ctrl+E", label: "Open file in editor" },
      { keys: "Ctrl+O", label: "Close opened file (Files view)" },
      { keys: "Ctrl+K", label: "Kill selected sub-agent / terminal" },
    ],
  },
  {
    title: "Plan Review pane",
    items: [
      { keys: "Click step / F1", label: "Cycle status (pending → accepted → rejected)" },
      { keys: "Shift+Enter", label: "Cycle (only some terminals send Shift+Enter as distinct)" },
      { keys: "Ctrl+↑↓", label: "Navigate steps" },
      { keys: "Click [Accept all] / Shift+A", label: "Accept all pending" },
      { keys: "Click [Reject all] / Shift+R", label: "Reject every step (then submit to send a full revision)" },
      { keys: "Click [add comment] / Shift+C", label: "Open comment input on selected step" },
      { keys: "Click [Submit] / F3", label: "Submit decision (approve & execute or revise)" },
      { keys: "Esc", label: "Close pane" },
    ],
  },
  {
    title: "General",
    items: [
      { keys: "Ctrl+G", label: "Toggle this help" },
      { keys: "Esc", label: "Close this help" },
    ],
  },
]

export function HelpOverlay(props: { onClose: () => void }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={dimensions().width}
      height={dimensions().height}
      justifyContent="center"
      alignItems="center"
      onMouseDown={() => props.onClose()}
    >
      <box
        border
        borderColor={theme.border}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        minWidth={50}
      >
        <text fg={theme.text}><b>Keybindings</b></text>
        <box paddingTop={1}>
          <For each={SECTIONS}>
            {(section, sectionIdx) => (
              <box marginTop={sectionIdx() === 0 ? 0 : 1}>
                <text fg={theme.accent}><b>{section.title}</b></text>
                <For each={section.items}>
                  {(item) => (
                    <box flexDirection="row" gap={2}>
                      <box width={14}>
                        <text fg={theme.text}>{item.keys}</text>
                      </box>
                      <text fg={theme.textMuted}>{item.label}</text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
        <box paddingTop={1}>
          <text fg={theme.textMuted}>Press Ctrl+G or Esc to close</text>
        </box>
      </box>
    </box>
  )
}
