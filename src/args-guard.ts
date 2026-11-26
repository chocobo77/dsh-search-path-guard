/**
 * Payload-size defense for the `MALFORMED_RESPONSE` failure family: the
 * measured incident streamed an `edit` whose huge escaped-CJK `new_string`
 * died mid-JSON at char 772 ("Unterminated string in JSON"), and the turn
 * ended with nobody retrying and nothing telling the model why. The failure
 * happens while the RESPONSE STREAM is assembled — the arguments never reach
 * the tool pipeline, and the host forbids pre-dispatch argument rewriting —
 * so this module cannot fix a truncated call. What it CAN do:
 * 1. deny an oversized-but-well-formed call before it runs (the same call
 *    shape one sampling run luckier would have produced), with split
 *    instructions;
 * 2. attach a reminder to the NEXT request after a successful large call,
 *    so the model shrinks its payloads before anything truncates;
 * 3. count MALFORMED_RESPONSE per session to bound a finite retry, and carry
 *    corrective guidance into the next step/turn either way.
 * The estimator is the CJK-aware heuristic from dsh-infinite-context's
 * token-budget (Han ≈ 1 token, other ≈ 1/4): the incident's payload was
 * exactly the case a Latin-biased estimate would undercount 4x.
 * @module dsh-search-path-guard/args-guard
 */

/** Defaults for the new config keys; also the warn-and-default fallbacks. */
export const DEFAULT_ARGS_HARD_TOKENS = 8_000
export const DEFAULT_ARGS_SOFT_TOKENS = 2_500
export const DEFAULT_PRESSURE_RATIO = 0.75
export const DEFAULT_PRESSURE_HARD_FACTOR = 0.5
export const DEFAULT_MALFORMED_RETRY = 1

/** The built-in LLM failure code this defense consumes (`LLM_FAILURE_CODES`). */
export const MALFORMED_CODE = 'MALFORMED_RESPONSE'

/** Maximum recursion depth when walking arguments (schemas nest; cycles are impossible in JSON-serializable values). */
const MAX_DEPTH = 64

/**
 * CJK-aware token estimate, byte-for-byte the same ranges as
 * dsh-infinite-context's `estimateTokens` (its src/token-budget.ts). Kept as
 * a local copy: this plugin stays dependency-free (type-only imports only),
 * and the estimator is twenty lines of ranges, not a library.
 * @param text - the text to estimate.
 * @returns an estimated token count (>= 0), deliberately conservative.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0xac00 && code <= 0xd7af)
    if (isCjk) cjk++
    else other++
  }
  return Math.ceil(cjk * 1.0 + other / 4)
}

/**
 * Estimate the token cost of a parsed tool-call's arguments — the same bytes
 * the model had to STREAM to produce them, which is what gets truncated.
 * String values dominate; structure (keys, brackets) is ignored, which only
 * undercounts by a few percent against the payloads this guard targets.
 * Walking stops once `cap` is exceeded: pre-execute runs on EVERY call, so
 * the cost stays O(cap) regardless of argument size. The returned value is
 * then the running total at the crossing point (always > cap), enough for a
 * `≈` figure in the denial wording.
 * @param value - the (deep-frozen, JSON-serializable) arguments.
 * @param cap - stop above this estimate; use the effective hard limit.
 * @returns the estimated tokens, or the crossing total when `cap` is passed.
 */
export function estimateArgsTokens(value: unknown, cap: number): number {
  let total = 0
  const walk = (v: unknown, depth: number): boolean => {
    if (typeof v === 'string') {
      total += estimateTokens(v)
      return total <= cap
    }
    if (depth >= MAX_DEPTH) return true // unproven depth: charge nothing rather than blow the stack
    if (Array.isArray(v)) {
      for (const item of v) {
        if (!walk(item, depth + 1)) return false
      }
      return true
    }
    if (typeof v === 'object' && v !== null) {
      for (const item of Object.values(v)) {
        if (!walk(item, depth + 1)) return false
      }
    }
    return true
  }
  walk(value, 0)
  return total
}

/**
 * The one-line self-healing denial for a call whose arguments cross the hard
 * limit: states the measurement, the limit, and the remedy (sequential
 * smaller calls), and names the failure it is preventing. It deliberately
 * never contains the zero-result marker — this text re-enters the model
 * context as an `Error:` result and the plugin's own result observer would
 * otherwise misread it as a search outcome.
 */
export function argsHardDenial(name: string, estimated: number, limit: number): string {
  return `payload-guard: ${name} arguments are ≈${estimated} tokens (limit ${limit})`
    + ` — split the work into sequential ${name} calls of ≤${limit} tokens each;`
    + ' one oversized call risks being cut off mid-stream (MALFORMED_RESPONSE) and losing the whole turn'
}

/**
 * The nudge attached to the NEXT request after a successful-but-large call
 * (via `additionalContexts`), before any truncation has happened. Shaping
 * the next generation is the only lever the stream-side failure has.
 */
export function argsSoftReminder(name: string, estimated: number, soft: number): string {
  return `payload-guard note: that ${name} call carried ≈${estimated} tokens of arguments`
    + ` — keep later tool-call payloads under ~${soft} tokens by splitting into sequential calls;`
    + ' large single payloads are what get truncated mid-stream (MALFORMED_RESPONSE)'
}

/**
 * The corrective context injected when a MALFORMED_RESPONSE actually
 * happened: what the model sees on the retry's next step (inbox append) or
 * on the next turn (inject), so a re-attempt is smaller, not identical.
 * Self-guarding wording: the same nudge reaches the NEXT step even when the
 * retry succeeded, so it must tell the model to leave an already-landed
 * change alone rather than redo it.
 */
export function malformedNudge(soft: number): string {
  return '[payload-guard check — a tool-call response was cut off mid-stream (MALFORMED_RESPONSE)] '
    + 'The stream died inside the call\'s own arguments, so that call may not have run. '
    + `If the change did NOT land, re-issue it as SEVERAL smaller tool calls, each with arguments under ~${soft} tokens; `
    + 'sending the same oversized call again will likely truncate at the same place. '
    + 'If it did land, ignore this and continue.'
}

/**
 * Per-session MALFORMED_RESPONSE streak, keyed on `String(session.id)`:
 * the request-error, agent/error, and turn/end events all reach the session
 * identity, and keying the streak there lets `turn/end(completed)` clear it
 * without an agent↔session reverse index. LRU-bounded in the ZeroResultTracker
 * idiom (insertion-order eviction only on NEW keys; reads never evict).
 */
export class MalformedStreak {
  readonly #limit: number
  readonly #sessions = new Map<string, number>()

  constructor(limit = 32) {
    this.#limit = limit
  }

  /** How many unrecovered MALFORMED_RESPONSE attempts this session has. */
  streakFor(sessionId: string): number {
    return this.#sessions.get(sessionId) ?? 0
  }

  /** Count one attempt; returns the running streak. */
  note(sessionId: string): number {
    const next = this.streakFor(sessionId) + 1
    this.#sessions.delete(sessionId)
    if (!this.#sessions.has(sessionId) && this.#sessions.size >= this.#limit) {
      const oldest = this.#sessions.keys().next().value
      if (oldest !== undefined) this.#sessions.delete(oldest)
    }
    this.#sessions.set(sessionId, next)
    return next
  }

  /** A completed turn is progress the model can see: the streak resets. */
  clear(sessionId: string): void {
    this.#sessions.delete(sessionId)
  }
}

/**
 * Which turns of a session already received a MALFORMED nudge (via inbox or
 * inject), so the request-error nudge and the agent/error nudge never stack
 * two copies inside one turn. LRU-bounded like MalformedStreak.
 */
export class NudgedTurns {
  readonly #limit: number
  readonly #turns = new Map<string, number>()

  constructor(limit = 32) {
    this.#limit = limit
  }

  /** Claim the turn: true when this is the first nudge for it. */
  claim(sessionId: string, turn: number): boolean {
    const key = `${sessionId}`
    if (this.#turns.get(key) === turn) return false
    this.#turns.delete(key)
    if (this.#turns.size >= this.#limit) {
      const oldest = this.#turns.keys().next().value
      if (oldest !== undefined) this.#turns.delete(oldest)
    }
    this.#turns.set(key, turn)
    return true
  }
}
