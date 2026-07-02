// TODO(port): util/log.ts no longer exists — logging moved to Effect's Logger
// (packages/core/src/observability/logging.ts), which isn't reachable from this
// plain, non-Effect helper. Falls back to console.error so a redaction event is
// still observable during development.
const log = {
  warn: (message: string, extra?: Record<string, unknown>) => console.error(`[security.redact] ${message}`, extra ?? ""),
}

export namespace SecretRedaction {
  interface Pattern {
    name: string
    regex: RegExp
  }

  const PATTERNS: Pattern[] = [
    // AWS
    { name: "AWS Access Key", regex: /(?<![A-Za-z0-9/+=])AKIA[0-9A-Z]{16}(?![A-Za-z0-9/+=])/g },
    { name: "AWS Secret Key", regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g },

    // GitHub
    { name: "GitHub Token", regex: /ghp_[A-Za-z0-9]{36,}/g },
    { name: "GitHub OAuth", regex: /gho_[A-Za-z0-9]{36,}/g },
    { name: "GitHub App Token", regex: /(?:ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
    { name: "GitHub Fine-grained", regex: /github_pat_[A-Za-z0-9_]{22,}/g },

    // Generic API keys
    { name: "Generic API Key", regex: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/gi },
    { name: "Bearer Token", regex: /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/g },

    // Private keys
    { name: "Private Key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },

    // Connection strings
    { name: "Connection String", regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/g },

    // JWT
    { name: "JWT", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-+/=]{10,}/g },

    // Slack
    { name: "Slack Token", regex: /xox[bpors]-[A-Za-z0-9-]{10,}/g },

    // OpenAI / Anthropic
    { name: "OpenAI Key", regex: /sk-[A-Za-z0-9]{20,}/g },
    { name: "Anthropic Key", regex: /sk-ant-[A-Za-z0-9_\-]{20,}/g },

    // .env style values (KEY=value on its own line)
    { name: "Env Secret", regex: /(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY|AUTH)\s*=\s*['"]?[^\s'"]{8,}['"]?/gi },
  ]

  export interface RedactResult {
    text: string
    redacted: number
    findings: string[]
  }

  export function scan(text: string): RedactResult {
    let result = text
    let redacted = 0
    const findings: string[] = []

    for (const pattern of PATTERNS) {
      // Reset regex state
      pattern.regex.lastIndex = 0
      const matches = result.match(pattern.regex)
      if (matches) {
        for (const match of matches) {
          // Don't redact very short matches (false positives)
          if (match.length < 12) continue
          // Don't redact if it looks like a variable name or path
          if (/^[a-z_]+$/i.test(match)) continue

          const masked = match.slice(0, 4) + "***REDACTED***" + match.slice(-4)
          result = result.replace(match, masked)
          redacted++
          findings.push(`${pattern.name}: ${match.slice(0, 8)}...`)
        }
      }
    }

    if (redacted > 0) {
      log.warn("secrets redacted", { count: redacted, types: findings })
    }

    return { text: result, redacted, findings }
  }

  /**
   * Redact secrets from tool output before it gets stored/sent to LLM.
   * Returns the original text if no secrets found (no allocation).
   */
  export function redactOutput(text: string): string {
    const result = scan(text)
    return result.text
  }
}
