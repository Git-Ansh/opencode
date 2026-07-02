import { Log } from "../util/log"

export namespace Workspace {
  const log = Log.create({ service: "workspace" })

  interface State {
    modified: string[]
    errors: string[]
    testResults: { passed: number; failed: number; output?: string } | null
    buildStatus: "ok" | "fail" | null
  }

  const sessions = new Map<string, State>()

  function get(sessionID: string): State {
    let state = sessions.get(sessionID)
    if (!state) {
      state = { modified: [], errors: [], testResults: null, buildStatus: null }
      sessions.set(sessionID, state)
    }
    return state
  }

  export function trackFile(sessionID: string, filepath: string) {
    const state = get(sessionID)
    if (!state.modified.includes(filepath)) {
      state.modified.push(filepath)
    }
  }

  export function trackError(sessionID: string, error: string) {
    const state = get(sessionID)
    state.errors.push(error)
    if (state.errors.length > 10) state.errors.shift()
  }

  export function trackTestResult(sessionID: string, passed: number, failed: number, output?: string) {
    get(sessionID).testResults = { passed, failed, output }
  }

  export function trackBuild(sessionID: string, success: boolean) {
    get(sessionID).buildStatus = success ? "ok" : "fail"
  }

  export function parseToolOutput(sessionID: string, tool: string, output: string) {
    // Detect test results in bash output
    if (tool === "bash") {
      // Common test output patterns
      const vitestMatch = output.match(/Tests\s+(\d+)\s+passed.*?(\d+)\s+failed/i)
      const jestMatch = output.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed/i)
      const pytestMatch = output.match(/(\d+)\s+passed.*?(\d+)\s+failed/i)
      const match = vitestMatch || jestMatch || pytestMatch
      if (match) {
        trackTestResult(sessionID, parseInt(match[1]), parseInt(match[2]))
      }

      // Detect build errors
      if (output.includes("error TS") || output.includes("Build failed") || output.includes("ERROR in")) {
        trackBuild(sessionID, false)
      } else if (
        output.includes("Build completed") ||
        output.includes("compiled successfully") ||
        output.includes("\u2713")
      ) {
        trackBuild(sessionID, true)
      }
    }
  }

  export function summary(sessionID: string): string {
    const state = sessions.get(sessionID)
    if (!state) return ""

    const parts: string[] = []
    if (state.modified.length) {
      parts.push(`Modified: ${state.modified.length} files`)
    }
    if (state.testResults) {
      const t = state.testResults
      parts.push(`Tests: ${t.passed} pass, ${t.failed} fail`)
    }
    if (state.buildStatus) {
      parts.push(`Build: ${state.buildStatus === "ok" ? "OK" : "FAIL"}`)
    }
    if (state.errors.length) {
      parts.push(`Errors: ${state.errors.length} recent`)
    }

    if (!parts.length) return ""
    return `<workspace>${parts.join(" | ")}</workspace>`
  }

  export function clear(sessionID: string) {
    sessions.delete(sessionID)
  }
}
