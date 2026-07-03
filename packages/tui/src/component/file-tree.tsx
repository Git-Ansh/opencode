import { createSignal, createEffect, For, Show, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useKeyboard } from "@opentui/solid"
import { useProject } from "../context/project"
import { useTuiPaths } from "../context/runtime"
import path from "path"
import { readdir } from "node:fs/promises"
import { watch, type FSWatcher } from "node:fs"

const IGNORED = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".next",
  "dist",
  ".cache",
  ".svn",
  ".hg",
  "vendor",
  "target",
  ".idea",
  ".vscode",
  ".DS_Store",
  "coverage",
  ".turbo",
  ".parcel-cache",
  ".nuxt",
  ".output",
])

interface TreeNode {
  name: string
  path: string
  isDir: boolean
}

export function FileTree(props: {
  width: number
  onSelect?: (filepath: string) => void
  modifiedFiles?: string[]
  active?: boolean
}) {
  const { theme } = useTheme()
  const project = useProject()
  const paths = useTuiPaths()
  const [topNodes, setTopNodes] = createSignal<TreeNode[]>([])
  const [childrenCache, setChildrenCache] = createStore<Record<string, TreeNode[]>>({})
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(true)

  const projectDir = () => {
    const d = project.instance.path().directory || paths.cwd
    return d.replace(/\\/g, "/")
  }

  async function loadDir(dirPath: string): Promise<TreeNode[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries
        .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith("."))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        .map((e) => ({
          name: e.name,
          path: path.join(dirPath, e.name).replace(/\\/g, "/"),
          isDir: e.isDirectory(),
        }))
    } catch {
      return []
    }
  }

  // Initial load of root directory
  createEffect(async () => {
    const dir = projectDir()
    if (!dir) return
    setLoading(true)
    const nodes = await loadDir(dir)
    setTopNodes(nodes)
    setLoading(false)
  })

  // Watch for external file changes
  let watcher: FSWatcher | undefined
  let rescanTimeout: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    const dir = projectDir()
    if (!dir) return
    if (watcher) {
      watcher.close()
      watcher = undefined
    }
    try {
      watcher = watch(dir, { recursive: true }, () => {
        if (rescanTimeout) clearTimeout(rescanTimeout)
        rescanTimeout = setTimeout(async () => {
          // Re-scan root
          const newTop = await loadDir(dir)
          setTopNodes(newTop)
          // Re-scan expanded directories
          for (const [dirPath, isExp] of Object.entries(expanded)) {
            if (isExp) {
              try {
                const children = await loadDir(dirPath)
                setChildrenCache(dirPath, children)
              } catch {
                setExpanded(dirPath, false)
              }
            }
          }
        }, 500)
      })
    } catch {}
  })

  onCleanup(() => {
    if (watcher) watcher.close()
    if (rescanTimeout) clearTimeout(rescanTimeout)
  })

  async function toggleDir(nodePath: string) {
    if (expanded[nodePath]) {
      setExpanded(nodePath, false)
    } else {
      if (!childrenCache[nodePath]) {
        const children = await loadDir(nodePath)
        setChildrenCache(nodePath, children)
      }
      setExpanded(nodePath, true)
    }
  }

  const flatNodes = createMemo(() => {
    const result: { node: TreeNode; depth: number }[] = []
    function flatten(nodes: TreeNode[], depth: number) {
      for (const node of nodes) {
        result.push({ node, depth })
        if (node.isDir && expanded[node.path]) {
          const children = childrenCache[node.path]
          if (children) flatten(children, depth + 1)
        }
      }
    }
    flatten(topNodes(), 0)
    return result
  })

  const isModified = (filepath: string) =>
    props.modifiedFiles?.some((f) => {
      const normF = f.replace(/\\/g, "/")
      const normP = filepath.replace(/\\/g, "/")
      return normP.endsWith(normF) || normF.endsWith(normP) || normF === normP
    }) ?? false

  useKeyboard((evt) => {
    if (!props.active) return
    const flat = flatNodes()
    if (!flat.length) return

    // Shift+Up/Down for file tree navigation (separate from Ctrl+Up/Down used by split pane)
    if (evt.shift && !evt.ctrl && evt.name === "up") {
      evt.preventDefault()
      setSelected((s) => Math.max(0, s - 1))
    }
    if (evt.shift && !evt.ctrl && evt.name === "down") {
      evt.preventDefault()
      setSelected((s) => Math.min(flat.length - 1, s + 1))
    }
    if (evt.shift && !evt.ctrl && evt.name === "right") {
      evt.preventDefault()
      const entry = flat[selected()]
      if (!entry) return
      if (entry.node.isDir) {
        toggleDir(entry.node.path)
      } else {
        props.onSelect?.(entry.node.path)
      }
    }
  })

  return (
    <box flexGrow={1}>
      <Show when={loading()}>
        <text fg={theme.textMuted}>Loading...</text>
      </Show>
      <Show when={!loading() && flatNodes().length === 0}>
        <text fg={theme.textMuted}>No files found</text>
      </Show>
      <Show when={!loading() && flatNodes().length > 0}>
        <scrollbox flexGrow={1}>
          <For each={flatNodes()}>
            {(entry, i) => {
              const indent = "  ".repeat(entry.depth)
              const icon = entry.node.isDir ? (expanded[entry.node.path] ? "▼ " : "▶ ") : "  "
              const modified = isModified(entry.node.path)

              return (
                <text
                  fg={
                    i() === selected()
                      ? theme.accent
                      : modified
                        ? theme.warning
                        : entry.node.isDir
                          ? theme.text
                          : theme.textMuted
                  }
                  bg={i() === selected() ? theme.backgroundElement : undefined}
                  wrapMode="none"
                  onMouseDown={() => {
                    setSelected(i())
                    if (entry.node.isDir) {
                      toggleDir(entry.node.path)
                    } else {
                      props.onSelect?.(entry.node.path)
                    }
                  }}
                >
                  {indent}
                  {icon}
                  {entry.node.name}
                </text>
              )
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}
