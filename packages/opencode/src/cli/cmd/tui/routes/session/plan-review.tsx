import { createSignal, For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../component/border"
import { usePromptRef } from "../../context/prompt"
import { useDialog } from "../../ui/dialog"

export interface PlanStep {
  id: number
  text: string
  status: "pending" | "accepted" | "rejected"
  files?: string[]
  rationale?: string
  comment?: string
}

export function PlanReview(props: {
  summary?: string
  steps: PlanStep[]
  onAccept?: () => void
  onRevise?: (rejected: Array<{ stepIndex: number; stepText: string; comment?: string }>) => void
  onClose?: () => void
}) {
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)
  const [commenting, setCommenting] = createSignal(false)
  const [commentDraft, setCommentDraft] = createSignal("")
  const [store, setStore] = createStore({
    steps: props.steps.map((s) => ({ ...s })),
  })

  const acceptedCount = createMemo(() => store.steps.filter((s) => s.status === "accepted").length)
  const rejectedCount = createMemo(() => store.steps.filter((s) => s.status === "rejected").length)
  const pendingCount = createMemo(() => store.steps.filter((s) => s.status === "pending").length)
  const allAccepted = createMemo(() => pendingCount() === 0 && rejectedCount() === 0)
  const hasRejection = createMemo(() => rejectedCount() > 0)
  const canSubmit = createMemo(() => pendingCount() === 0)

  function accept(index: number) {
    setStore("steps", index, "status", "accepted")
    if (selected() < store.steps.length - 1) setSelected(selected() + 1)
  }

  function reject(index: number) {
    setStore("steps", index, "status", "rejected")
  }

  function startComment() {
    const cur = store.steps[selected()]
    if (cur.status !== "rejected") {
      // Auto-reject so commenting makes sense
      setStore("steps", selected(), "status", "rejected")
    }
    setCommentDraft(store.steps[selected()].comment ?? "")
    setCommenting(true)
  }

  function saveComment() {
    setStore("steps", selected(), "comment", commentDraft())
    setCommenting(false)
    setCommentDraft("")
  }

  function cancelComment() {
    setCommenting(false)
    setCommentDraft("")
  }

  function submit() {
    if (!canSubmit()) return
    if (allAccepted()) {
      props.onAccept?.()
      return
    }
    const rejected = store.steps
      .map((s, i) => ({ status: s.status, stepIndex: i, stepText: s.text, comment: s.comment }))
      .filter((s) => s.status === "rejected")
      .map(({ stepIndex, stepText, comment }) => ({ stepIndex, stepText, comment }))
    props.onRevise?.(rejected)
  }

  const promptRef = usePromptRef()
  const dialog = useDialog()

  // Defer to other UI when plan-pane keys would steal expected input.
  // Dialogs (model picker, command palette, etc.) own the keyboard.
  // Prompt input owns the keyboard while it has focus AND has typed text.
  const shouldDefer = () => {
    if (dialog.stack.length > 0) return true
    const pr = promptRef.current
    if (pr?.focused && (pr.current?.input ?? "").length > 0) return true
    return false
  }

  useKeyboard((evt) => {
    if (commenting()) {
      if (evt.name === "return") {
        evt.preventDefault()
        saveComment()
        return
      }
      if (evt.name === "escape") {
        evt.preventDefault()
        cancelComment()
        return
      }
      if (evt.name === "backspace") {
        evt.preventDefault()
        setCommentDraft((d) => d.slice(0, -1))
        return
      }
      // Append printable single-char keys to the draft
      if (evt.sequence && evt.sequence.length === 1 && evt.sequence >= " " && evt.sequence !== "") {
        evt.preventDefault()
        setCommentDraft((d) => d + evt.sequence)
        return
      }
      return
    }

    // Esc closes the pane (esc never types a character so it's safe globally).
    if (evt.name === "escape") {
      evt.preventDefault()
      props.onClose?.()
      return
    }

    // Shift combos for plan actions. Gated via shouldDefer() so capital-letter
    // typing in the prompt still works.
    if (evt.shift && !evt.ctrl && !evt.alt) {
      if (shouldDefer()) return
      if (evt.name === "return") {
        evt.preventDefault()
        cycleStatus(selected())
        return
      }
      if (evt.name === "a") {
        evt.preventDefault()
        acceptAllPending()
        return
      }
      if (evt.name === "r") {
        evt.preventDefault()
        rejectAll()
        return
      }
      if (evt.name === "c") {
        evt.preventDefault()
        startComment()
        return
      }
    }

    // F-keys as terminal-agnostic alternatives. Shift+Enter / Ctrl+S / etc. are
    // unreliable on Windows: many terminals don't differentiate Shift+Enter
    // from Enter, and Ctrl+S is XOFF (intercepted for output flow control by
    // PowerShell/conhost and never delivered).
    //   F1 = cycle status   F3 = submit
    // F2 is `model_cycle_recent` (already taken).
    if (evt.name === "f1") {
      if (shouldDefer()) return
      evt.preventDefault()
      cycleStatus(selected())
      return
    }
    if (evt.name === "f3") {
      if (shouldDefer()) return
      evt.preventDefault()
      submit()
      return
    }

    if (!evt.ctrl) return

    // Ctrl+↑↓ for nav (only reliable single-Ctrl combo here).
    // Other Ctrl letters collide with global keybinds (command_list,
    // session_rename, variant_cycle, etc.) dispatched by the master
    // command-keybind handler at dialog-command.tsx:73 which fires before
    // this and ignores defaultPrevented. Submission is click-driven /
    // F3 instead — Ctrl+S is XOFF on Windows.
    if (shouldDefer()) return

    if (evt.name === "up") {
      evt.preventDefault()
      setSelected(Math.max(0, selected() - 1))
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      setSelected(Math.min(store.steps.length - 1, selected() + 1))
      return
    }
  })

  function cycleStatus(index: number) {
    const cur = store.steps[index].status
    const next = cur === "pending" ? "accepted" : cur === "accepted" ? "rejected" : "pending"
    setStore("steps", index, "status", next)
    setSelected(index)
  }

  function acceptAllPending() {
    for (let i = 0; i < store.steps.length; i++) {
      if (store.steps[i].status === "pending") {
        setStore("steps", i, "status", "accepted")
      }
    }
  }

  function rejectAll() {
    for (let i = 0; i < store.steps.length; i++) {
      setStore("steps", i, "status", "rejected")
    }
  }

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box paddingLeft={1} paddingRight={1} paddingTop={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.accent} bold>
            Plan Review
          </text>
          <text fg={theme.textMuted}>
            {acceptedCount()}/{store.steps.length} accepted
            <Show when={hasRejection()}>
              <span style={{ fg: theme.error }}>{`, ${rejectedCount()} rejected`}</span>
            </Show>
          </text>
        </box>
        <Show when={props.summary}>
          <box paddingTop={1}>
            <text fg={theme.textMuted}>{props.summary}</text>
          </box>
        </Show>
        <box flexDirection="row" gap={2} paddingTop={1} flexWrap="wrap" flexShrink={0}>
          <box onMouseDown={() => acceptAllPending()}>
            <text fg={pendingCount() > 0 ? theme.accent : theme.textMuted}>
              [ Accept all pending ]
            </text>
          </box>
          <box onMouseDown={() => rejectAll()}>
            <text fg={store.steps.length > 0 ? theme.error : theme.textMuted}>
              [ Reject all ]
            </text>
          </box>
          <box onMouseDown={() => submit()}>
            <text fg={canSubmit() ? theme.accent : theme.textMuted}>
              [ {allAccepted() ? "Approve & execute" : hasRejection() ? "Send revision" : "Submit (review remaining)"} ]
            </text>
          </box>
        </box>
      </box>

      <box paddingLeft={1} paddingRight={1} paddingTop={1} flexGrow={1}>
        <scrollbox>
          <For each={store.steps}>
            {(step, i) => {
              const isActive = () => i() === selected()
              const statusIcon = () => {
                switch (step.status) {
                  case "accepted":
                    return "✓"
                  case "rejected":
                    return "✗"
                  default:
                    return "○"
                }
              }
              const statusColor = () => {
                switch (step.status) {
                  case "accepted":
                    return theme.success
                  case "rejected":
                    return theme.error
                  default:
                    return theme.textMuted
                }
              }

              return (
                <box
                  backgroundColor={isActive() ? theme.backgroundElement : undefined}
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseDown={() => cycleStatus(i())}
                >
                  <box flexDirection="row" gap={1}>
                    <text fg={statusColor()}>{statusIcon()}</text>
                    <text fg={isActive() ? theme.text : step.status === "rejected" ? theme.textMuted : theme.text}>
                      {`${i() + 1}. ${step.text}`}
                    </text>
                  </box>
                  <Show when={step.rationale}>
                    <box paddingLeft={3}>
                      <text fg={theme.textMuted}>{step.rationale}</text>
                    </box>
                  </Show>
                  <Show when={step.files && step.files.length > 0}>
                    <box paddingLeft={3} flexDirection="row" gap={1} flexWrap="wrap">
                      <For each={step.files}>
                        {(file) => (
                          <text fg={theme.secondary}>{file}</text>
                        )}
                      </For>
                    </box>
                  </Show>
                  <Show when={step.comment}>
                    <box paddingLeft={3}>
                      <text fg={theme.warning}>{">"} {step.comment}</text>
                    </box>
                  </Show>
                  <Show when={isActive() && !commenting()}>
                    <box
                      paddingLeft={3}
                      paddingTop={1}
                      flexDirection="row"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        startComment()
                      }}
                    >
                      <text fg={theme.accent}>
                        [ {step.comment ? "edit" : "add"} comment ]
                      </text>
                    </box>
                  </Show>
                  <Show when={isActive() && commenting()}>
                    <box paddingLeft={3} paddingTop={1}>
                      <text fg={theme.accent}>
                        comment: <span style={{ fg: theme.text }}>{commentDraft()}</span>
                        <span style={{ fg: theme.textMuted }}>{" ▏"}</span>
                      </text>
                      <text fg={theme.textMuted}>enter save · esc cancel</text>
                    </box>
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </box>

      <Show when={!commenting()}>
        <box
          flexDirection="row"
          flexShrink={0}
          gap={2}
          paddingLeft={2}
          paddingRight={2}
          paddingBottom={1}
          paddingTop={1}
          flexWrap="wrap"
        >
          <text fg={theme.text}>
            click step / F1 <span style={{ fg: theme.textMuted }}>cycle ✓/✗/○</span>
          </text>
          <text fg={theme.text}>
            {"Ctrl+↑↓"} <span style={{ fg: theme.textMuted }}>nav</span>
          </text>
          <text fg={theme.text}>
            Shift+A <span style={{ fg: theme.textMuted }}>accept all</span>
          </text>
          <text fg={theme.text}>
            Shift+R <span style={{ fg: theme.textMuted }}>reject all</span>
          </text>
          <text fg={theme.text}>
            Shift+C <span style={{ fg: theme.textMuted }}>comment</span>
          </text>
          <text fg={canSubmit() ? theme.accent : theme.textMuted}>
            click [Submit] / F3 <span style={{ fg: theme.textMuted }}>submit</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>close</span>
          </text>
        </box>
      </Show>
    </box>
  )
}

/**
 * Parse a plan text into individual steps.
 * Looks for numbered lists like "1. Step text" or "- Step text".
 * Used as a fallback when the model writes plans into chat instead of calling plan_propose.
 */
export function parsePlanSteps(planText: string): PlanStep[] {
  const lines = planText.split("\n")
  const steps: PlanStep[] = []
  let currentStep = ""
  let stepId = 0

  for (const line of lines) {
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)/)
    const bulleted = line.match(/^\s*[-*]\s+(.+)/)

    if (numbered || bulleted) {
      if (currentStep) {
        steps.push({ id: stepId++, text: currentStep.trim(), status: "pending" })
      }
      currentStep = numbered ? numbered[2] : bulleted![1]
    } else if (currentStep && line.trim()) {
      currentStep += " " + line.trim()
    }
  }

  if (currentStep) {
    steps.push({ id: stepId++, text: currentStep.trim(), status: "pending" })
  }

  return steps
}
