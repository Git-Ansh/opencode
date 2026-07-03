import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const BAR_WIDTH = 32

function barSegment(fraction: number, width: number) {
  const chars = Math.round(fraction * width)
  return chars > 0 ? "█".repeat(chars) : ""
}

function emptySegment(used: number, width: number) {
  const chars = width - Math.round(used * width)
  return chars > 0 ? "░".repeat(chars) : ""
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  // Breaks total context usage down by token category (input/cache/output/reasoning)
  // so the bar below can be color-coded per category, not just a single percentage.
  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return undefined
    }

    const input = last.tokens.input || 0
    const output = last.tokens.output || 0
    const reasoning = last.tokens.reasoning || 0
    const cache = (last.tokens.cache?.read || 0) + (last.tokens.cache?.write || 0)
    const total = input + output + reasoning + cache
    // TODO(port): the original used the *currently selected* model's context limit
    // (via useLocal().model.current()) so the bar updates immediately on model
    // switch, before the next message completes. That needs useLocal() to be safe
    // to call from a plugin view, which wasn't verified for this phase — falling
    // back to the last message's own model, matching this file's pre-existing behavior.
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const contextLimit = model?.limit.context ?? 0
    const percentage = contextLimit ? Math.round((total / contextLimit) * 100) : 0
    const used = contextLimit ? Math.min(total / contextLimit, 1) : 0

    return {
      input,
      output,
      reasoning,
      cache,
      total,
      contextLimit,
      modelName: model?.name ?? last.modelID,
      percentage,
      used,
      inputFrac: contextLimit ? input / contextLimit : 0,
      cacheFrac: contextLimit ? cache / contextLimit : 0,
      outputFrac: contextLimit ? output / contextLimit : 0,
      reasoningFrac: contextLimit ? reasoning / contextLimit : 0,
    }
  })

  return (
    <box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Context</b>
        </text>
        <text fg={theme().textMuted}>{money.format(cost())}</text>
      </box>
      <Show when={state()} fallback={<text fg={theme().textMuted}>No data yet</text>}>
        {(ctx) => (
          <>
            <text>
              <span style={{ fg: theme().accent }}>{barSegment(ctx().inputFrac, BAR_WIDTH)}</span>
              <span style={{ fg: theme().info }}>{barSegment(ctx().cacheFrac, BAR_WIDTH)}</span>
              <span style={{ fg: theme().success }}>{barSegment(ctx().outputFrac, BAR_WIDTH)}</span>
              <span style={{ fg: theme().warning }}>{barSegment(ctx().reasoningFrac, BAR_WIDTH)}</span>
              <span style={{ fg: theme().textMuted }}>{emptySegment(ctx().used, BAR_WIDTH)}</span>
            </text>
            <text fg={theme().textMuted}>
              {ctx().percentage}% of {ctx().contextLimit.toLocaleString()} ctx
              {ctx().modelName ? ` (${ctx().modelName})` : ""}
            </text>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}>Input {ctx().input.toLocaleString()}</text>
              <text fg={theme().textMuted}>Cache {ctx().cache.toLocaleString()}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}>Output {ctx().output.toLocaleString()}</text>
              <text fg={theme().textMuted}>Reason {ctx().reasoning.toLocaleString()}</text>
            </box>
          </>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
