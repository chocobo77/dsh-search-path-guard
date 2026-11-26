/**
 * Markup-guard: text-form tool-call markup that LEAKS into an otherwise
 * productive step. The host's own defense (agent-loop/text-tool-call.ts,
 * itself a local patch that was lost once in a checkout update) exempts any
 * message carrying a real tool-call block — "leftover markup is narration
 * around it". Under PTC (programmatic tool calling) the API surface exposes
 * only `run_code`, and the model's native-call syntax can only become text;
 * the measured failure (session f2415117, 2026-11-26) is exactly the hybrid
 * shape: a legal run_code block doing real work PLUS dead `<tool_call>`/
 * `<function=…>` markup trying to call a native tool directly. 5/5 leaks in
 * that session fell in the host's blind spot and were never corrected — the
 * model repeated the error across 20 steps because nothing ever told it the
 * calls never ran. This module reuses the host's detection idioms (marker
 * regexes, body test, min length, code-fence excision — its conclusions are
 * battle-tested) but drops the tool-call exemption, and adds a per-turn
 * injection budget so a correction cannot itself become noise.
 * Detection semantics: see docs/TEXT-TOOL-CALL-LEAK.md §方案 B.
 * @module dsh-search-path-guard/markup-guard
 */

/** Defaults for the new config keys; also the warn-and-default fallbacks. */
export const DEFAULT_MARKUP_BLOCK = 2
export const DEFAULT_MARKUP_MIN_CHARS = 40

/**
 * The standing PTC call-convention note (方案 A2): the same semantics as the
 * host's static `tools:ptc-only` section, but carried in the per-step
 * system-reminder snapshot — adjacent to where a leak is about to happen,
 * against instruction decay in long contexts. The measured session leaked
 * 5 native calls (`skill`/`read`/`todo_write`) that were ALL listed in a
 * direct-call-style tool list while 34/34 executed calls were `run_code`:
 * the pretraining inertia of "listed ⇒ callable" is what this text names.
 */
export const PTC_CALL_CONVENTION = '[ptc-call-convention] `run_code` is the ONLY tool you can call directly'
  + ' on the tool-call channel. Every other tool in any list you see is declared for use INSIDE a run_code program:'
  + ' call it as `await tools.name(args)` in the program body. A tool call written as text markup'
  + ' (`<tool_call>`, `<function=…>`, `<invoke name="…">`) is never executed — it is prose,'
  + ' no result is pending, and the intent is lost.'

/** Opening tags of the call syntaxes seen in the wild (host MARKUP_START). */
const MARKUP_START = /<(?:tool_call[\s>]|function=|invoke\s+name=|antml:)/

/**
 * A real call body carries nested tags or an arguments payload; a passing
 * mention (`use <tool_call> syntax`) has neither and must not fire.
 */
const MARKUP_BODY = /<\/(?:antml:)?(?:parameter|function|tool_call|invoke)[\s>]|<(?:antml:)?parameter[\s>]|"(?:arguments|name)"\s*:/

/** Where a call syntax states its tool name, bounded against runaway captures. */
const NAME_PATTERNS = [
  /<function=([^\s>]{1,64})>/,
  /<invoke\s+name=["']([^"']{1,64})["']/,
  /<(?:antml:)?tool_call[^>]*>\s*\{[\s\S]{0,400}?"name"\s*:\s*"([^"]{1,64})"/,
]

/** How far one leaked call revealed what it wanted to call. */
export interface MarkupLeakAttempt {
  /** Tool the markup named, when it named one. */
  readonly name?: string
}

/**
 * Excise fenced blocks and inline code spans before the markup search —
 * byte-for-byte the host's `withoutCodeFormatting` semantics. Markup inside
 * code formatting is documentation: a report quoting the broken shape it
 * diagnosed is not an attempt, and nudging it would interrupt legitimate
 * prose. An unclosed fence swallows the rest: an unterminated block is a
 * sample, not a setup.
 */
export function withoutCodeFormatting(text: string): string {
  const kept: string[] = []
  let closer: RegExp | undefined
  for (const line of text.split('\n')) {
    if (closer !== undefined) {
      if (closer.test(line)) closer = undefined
      continue
    }
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (opener !== null) {
      closer = new RegExp(`^ {0,3}\\${String(opener[1])}{3,}\\s*$`)
      continue
    }
    kept.push(line.replace(/`[^`\n]+`/g, ' '))
  }
  return kept.join('\n')
}

/**
 * Decide whether assistant TEXT contains a dead tool call written as markup.
 * Unlike the host's `detectTextToolCall` there is deliberately NO tool-call
 * block exemption — the hybrid block (real call + leaked markup) is the
 * exact shape this guard exists to catch. Callers pass only the joined text
 * of the message's text blocks.
 * @param text - the assistant message's text blocks, joined.
 * @param minChars - shortest markup fragment that still counts (default 40).
 * @returns the attempt, or undefined when the text names no dead call.
 */
export function detectMarkupLeak(text: string, minChars: number = DEFAULT_MARKUP_MIN_CHARS): MarkupLeakAttempt | undefined {
  const stripped = withoutCodeFormatting(text)
  const start = stripped.search(MARKUP_START)
  if (start < 0) return undefined
  const markup = stripped.slice(start)
  if (!MARKUP_BODY.test(markup) || markup.length < minChars) return undefined
  const name = NAME_PATTERNS
    .map(pattern => markup.match(pattern)?.[1])
    .find(value => value !== undefined)
  return name === undefined ? {} : { name }
}

/**
 * The corrective user message for one detected leak. Names the dead end and
 * the PTC remedy (`await tools.name(…)` inside run_code) — "vary the markup"
 * is exactly the move that stays dead, so the message leaves no alternative
 * except the code channel or plain prose. Past the first hit of a streak,
 * the wording names the repetition count and its cause: the model keeps
 * treating directly-listed tool names as directly callable.
 */
export function markupNudge(attempt: MarkupLeakAttempt, repeat: number): string {
  const lines = [
    '[Guard check — the tool call in your previous message never ran]',
    'Your previous message contained a tool call written as text markup'
      + ' (<tool_call>…, <function=…>, <invoke name="…">). Markup inside an answer is never executed:'
      + ' nothing ran, no result is pending, and the intent was lost.',
    attempt.name === undefined
      ? 'Re-issue that intent from inside a run_code program, or finish in plain prose.'
      : `"${attempt.name}" is not directly callable in this session — the only directly callable tool is \`run_code\`.`
        + ` Re-issue the intent from inside a run_code program: \`await tools.${attempt.name}({ … })\`.`,
  ]
  if (repeat >= 2) {
    lines.push(`This is markup-leak #${repeat} in this session. The cause is always the same:`
      + ' a tool name appearing in a list is a declaration for use INSIDE run_code, not a directly callable tool.'
      + ' Writing the call as markup again will stay dead.')
  }
  return lines.join('\n')
}

/**
 * Per-agent per-turn injection budget, keyed on the agent handle. A turn's
 * budget is fresh (`turn/start` moves the turn number); `markupBlock`
 * injections per turn, then silence — a correcting guard must not itself
 * become the noise it exists to prevent.
 */
export class MarkupTurnBudget {
  readonly #spent = new WeakMap<object, { turn: number; count: number }>()

  /** How many corrections this agent has already received in `turn`. */
  count(agent: unknown, turn: number): number {
    if (typeof agent !== 'object' || agent === null) return 0
    const entry = this.#spent.get(agent)
    return entry !== undefined && entry.turn === turn ? entry.count : 0
  }

  /** Record one correction; returns the new count for the turn. */
  note(agent: unknown, turn: number): number {
    const count = this.count(agent, turn) + 1
    if (typeof agent === 'object' && agent !== null) this.#spent.set(agent, { turn, count })
    return count
  }
}

/**
 * Consecutive-leak counter per agent, in the DenialEscalation idiom: it
 * drives `markupNudge`'s repeat wording and clears the moment a step's last
 * assistant message is clean — visible progress resets the streak.
 */
export class LeakStreak {
  readonly #streaks = new WeakMap<object, number>()

  /** Count one corrected leak for this agent; returns the running total. */
  note(agent: unknown): number {
    if (typeof agent !== 'object' || agent === null) return 1
    const next = (this.#streaks.get(agent) ?? 0) + 1
    this.#streaks.set(agent, next)
    return next
  }

  /** A clean assistant message is progress the model can see: reset. */
  clear(agent: unknown): void {
    if (typeof agent !== 'object' || agent === null) return
    this.#streaks.delete(agent)
  }
}
