/**
 * Zero-result escalation for `grep`: the measured runaway-loop pathology is
 * not exact-duplicate calls (those were rare) but 370 pattern-variations on
 * one file that all returned "No matches found" — the model treats each
 * empty result as an invitation to tweak the pattern and try again, across
 * turns. This tracker counts consecutive zero-result greps per agent+target
 * and hands the pre-execute guard a strategy-forcing denial once the streak
 * crosses its threshold.
 * @module dsh-search-path-guard/repeat-guard
 */

/**
 * The exact zero-result wording emitted by `@deepseek-ai/dsh-tool-fs-search`
 * (its src/grep.ts). This is a cross-package text contract: if the tool ever
 * rewords its empty output, streaks silently stop growing and this guard
 * disables itself — keep the constant in sync with the tool.
 */
const ZERO_RESULT_MARKER = 'No matches found'

/** Bounded per-agent streak state. */
export class ZeroResultTracker {
  readonly #limit: number
  readonly #agents = new WeakMap<object, Map<string, number>>()

  constructor(limit = 64) {
    this.#limit = limit
  }

  /** Pure lookup/creation; reads never evict. */
  #mapFor(agent: unknown): Map<string, number> {
    if (typeof agent !== 'object' || agent === null) {
      // No agent (direct tool call): track nothing, deny nothing.
      return new Map()
    }
    let map = this.#agents.get(agent)
    if (map === undefined) {
      map = new Map()
      this.#agents.set(agent, map)
    }
    return map
  }

  /** How many consecutive zero-result greps this agent has on this path. */
  streakFor(agent: unknown, path: string): number {
    return this.#mapFor(agent).get(path) ?? 0
  }

  /**
   * Observe one finished grep outcome. A zero-result output extends the
   * streak; any other outcome (matches, error, cancellation) clears it —
   * the file changed, or the attempt was not a comparable search. A guard
   * denial also re-emits through `tools/result` and is filtered out by the
   * plugin's observer first: it is not a search outcome, so it must neither
   * extend nor clear the streak.
   */
  observe(agent: unknown, path: string, resultText: string): void {
    const map = this.#mapFor(agent)
    if (!resultText.includes(ZERO_RESULT_MARKER)) {
      map.delete(path)
      return
    }
    const prior = map.get(path)
    // delete+set re-keys the entry at the tail of Map's insertion order, so a
    // target under active search stays out of eviction reach (recency refresh).
    map.delete(path)
    if (prior === undefined && map.size >= this.#limit) {
      // Bound per-agent key growth: evict only when inserting a NEW key
      // (an update above just refreshed recency); Map preserves insertion
      // order, so the first key is the least-recently-touched.
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(path, (prior ?? 0) + 1)
  }
}

/**
 * The strategy-forcing denial for one pending grep whose target has burned
 * `streak` consecutive zero-result searches. The wording names the dead end
 * and the three ways out, because "vary the pattern" is exactly the move
 * this guard exists to stop.
 */
export function zeroResultDenial(path: string, streak: number): string {
  return `loop-guard: your last ${streak} greps on "${path}" all returned "${ZERO_RESULT_MARKER}"`
    + ' — varying the pattern again will stay blocked, because repeating a search that cannot match yields nothing new.'
    + ' Read the target range directly to see what the file actually contains, switch to a different file or source,'
    + ' or report the negative finding to the user instead of searching'
}

/**
 * Consecutive-denial counter per agent. A guard that only ever says "no" can
 * be read as a transient glitch worth retrying; measured sessions show a
 * model under pressure (429 storms, context compaction) retrying the same
 * blocked shape instead of changing approach, and eventually degrading into
 * writing tool calls as prose markup that never executes. Escalating the
 * denial wording at the repeat count is how the guard says "this is not
 * transient — change the approach or stop".
 */
export class DenialEscalation {
  /** Consecutive denials before the wording escalates. */
  static readonly THRESHOLD = 3
  readonly #agents = new WeakMap<object, number>()

  /** Count one denial for this agent and return the running total. */
  note(agent: unknown): number {
    if (typeof agent !== 'object' || agent === null) return 1
    const next = (this.#agents.get(agent) ?? 0) + 1
    this.#agents.set(agent, next)
    return next
  }

  /** Any allowed call means the model is making progress: reset the streak. */
  clear(agent: unknown): void {
    if (typeof agent !== 'object' || agent === null) return
    this.#agents.delete(agent)
  }
}

/**
 * Append the escalation guidance once consecutive denials cross the threshold.
 * Past the threshold the model is told, verbatim, that text-form tool calls
 * never execute — the measured degradation when a model cannot get a call
 * through the tool channel.
 */
export function escalatedReason(reason: string, denialCount: number): string {
  if (denialCount < DenialEscalation.THRESHOLD) return reason
  return `${reason}`
    + ` | escalation: this is denial #${denialCount} in a row for this session`
    + ' — the guard does not yield to retries, so repeating the blocked shape will keep failing;'
    + ' change the target or the approach, or stop and tell the user what is blocking you.'
    + ' If tool calls are being lost at the tool layer (rate limits, context pressure), do NOT write the call as text markup'
    + ' — text-form calls are never executed; report the blockage to the user instead'
}
