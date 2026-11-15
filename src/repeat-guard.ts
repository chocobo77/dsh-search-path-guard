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

/** Bounded per-agent streak state. */
export class ZeroResultTracker {
  readonly #limit: number
  readonly #agents = new WeakMap<object, Map<string, { streak: number; lastHead: string }>>()

  constructor(limit = 64) {
    this.#limit = limit
  }

  #mapFor(agent: unknown): Map<string, { streak: number; lastHead: string }> {
    if (typeof agent !== 'object' || agent === null) {
      // No agent (direct tool call): track nothing, deny nothing.
      return new Map()
    }
    let map = this.#agents.get(agent)
    if (map === undefined) {
      map = new Map()
      this.#agents.set(agent, map)
    }
    if (map.size >= this.#limit) {
      // Bound per-agent key growth: evict the least-recently-touched target
      // (Map preserves insertion order, so the first key is the oldest).
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    return map
  }

  /** How many consecutive zero-result greps this agent has on this path. */
  streakFor(agent: unknown, path: string): number {
    return this.#mapFor(agent).get(path)?.streak ?? 0
  }

  /** The tail of the last zero-result output, quoted in the denial message. */
  lastHeadFor(agent: unknown, path: string): string {
    return this.#mapFor(agent).get(path)?.lastHead ?? ''
  }

  /**
   * Observe one finished grep outcome. A zero-result output extends the
   * streak; any other outcome (matches, error, cancellation) clears it —
   * the file changed, or the attempt was not a comparable search.
   */
  observe(agent: unknown, path: string, resultText: string): void {
    const map = this.#mapFor(agent)
    if (!resultText.includes('No matches found')) {
      map.delete(path)
      return
    }
    const entry = map.get(path) ?? { streak: 0, lastHead: '' }
    entry.streak += 1
    entry.lastHead = resultText.slice(0, 80)
    map.set(path, entry)
  }
}

/**
 * The strategy-forcing denial for one pending grep whose target has burned
 * `streak` consecutive zero-result searches. The wording names the dead end
 * and the three ways out, because "vary the pattern" is exactly the move
 * this guard exists to stop.
 */
export function zeroResultDenial(path: string, streak: number): string {
  return `loop-guard: your last ${streak} greps on "${path}" all returned "No matches found"`
    + ' — varying the pattern again will stay blocked, because repeating a search that cannot match yields nothing new.'
    + ' Read the target range directly to see what the file actually contains, switch to a different file or source,'
    + ' or report the negative finding to the user instead of searching'
}
