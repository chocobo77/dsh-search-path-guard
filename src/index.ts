/**
 * `tools/pre-execute` guard, four families of provably-dead or provably-
 * dangerous calls:
 * 1. a `grep`/`glob`/`read` target that does not exist (one-line self-healing
 *    denial instead of a mojibake-prone tool error);
 * 2. an `edit` whose `old_string` is not in the current file, or matches
 *    ambiguously (the stale-edit spiral after concurrent writes);
 * 3. a `grep` whose target has burned `zeroResultBlock` consecutive
 *    "No matches found" searches (the measured runaway loop: 370
 *    pattern-variations on one file across turns);
 * 4. a call whose own arguments are large enough to risk being cut off
 *    mid-stream (`MALFORMED_RESPONSE`, measured: an escaped-CJK `edit`
 *    truncated at char 772 and the whole turn died) — denied over the hard
 *    limit with split instructions, reminded after success under it, and
 *    met with a bounded retry plus corrective context when the truncation
 *    actually happens (see ./args-guard.ts);
 * 5. a previous assistant message whose TEXT leaked dead tool-call markup
 *    (`<tool_call>`/`<function=…>` written as prose — the PTC hybrid shape:
 *    a legal run_code block doing real work beside markup that never runs;
 *    measured: 5 leaks in one session, zero corrections, because the host
 *    defense exempts any message carrying a real call block) — corrected by
 *    a budgeted user message spliced in at `agent/pre-step`, plus a standing
 *    PTC call-convention note in the per-step system-reminder snapshot
 *    (see ./markup-guard.ts).
 * Registered as a monotonic pre-execute listener, a `tools/result` observer,
 * and a budgeted `agent/pre-step` corrective injector; a denial cannot be
 * un-done by listener ordering, and everything the guard cannot prove falls
 * through to `next()` unchanged.
 * @module dsh-search-path-guard
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulling dsh-agent/dsh-llm/dsh-session into the program also
// registers their declaration-merged Events (`agent/request-error`,
// `agent/error`, `agent/pre-step`, `session/event`) and message types for
// the payload and markup guards.
import type { PreToolDecision, PostToolDecision } from '@deepseek-ai/dsh-tools'
import type { PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_ARGS_HARD_TOKENS,
  DEFAULT_ARGS_SOFT_TOKENS,
  DEFAULT_MALFORMED_RETRY,
  DEFAULT_PRESSURE_HARD_FACTOR,
  DEFAULT_PRESSURE_RATIO,
  MALFORMED_CODE,
  MalformedStreak,
  NudgedTurns,
  argsHardDenial,
  argsSoftReminder,
  estimateArgsTokens,
  malformedNudge,
} from './args-guard.ts'
import {
  DEFAULT_MARKUP_BLOCK,
  DEFAULT_MARKUP_MIN_CHARS,
  LeakStreak,
  MarkupTurnBudget,
  PTC_CALL_CONVENTION,
  detectMarkupLeak,
  markupNudge,
} from './markup-guard.ts'
import { EDIT_PREFLIGHT_MAX_BYTES, editDenial, pathKeyFor, searchPathDenial } from './preflight.ts'
import { DenialEscalation, ZeroResultTracker, escalatedReason, zeroResultDenial } from './repeat-guard.ts'

export const name = 'search-path-guard'

/** Optional plugin configuration. */
export interface GuardConfig {
  /** Set true to unload the guard while keeping the bundle installed. */
  disabled?: boolean
  /** Skip the edit content check above this file size (default 2 MB). A non-numeric value falls back to the default with a warning. */
  maxEditBytes?: number
  /** Consecutive zero-result greps on one target before the loop guard denies. Default 5; values below 1 are clamped to 1. A non-numeric value falls back to the default with a warning. */
  zeroResultBlock?: number
  /** Tool-call arguments estimated at or above this many tokens are denied with split instructions (the MALFORMED_RESPONSE risk shape). Default 8000 (the host compaction meter's per-tool-block cap); 0 disables the hard cap. A non-numeric value falls back to the default with a warning. */
  argsHardTokens?: number
  /** A successful call at or above this many argument tokens gets a split-reminder on the NEXT request. Default 2500; 0 disables; values above `argsHardTokens` are clamped to it. A non-numeric value falls back to the default with a warning. */
  argsSoftTokens?: number
  /** Context fill ratio (last usage totalTokens / routed context window) at or above which the hard limit tightens. Default 0.75; 0 disables pressure scaling. A non-numeric value falls back to the default with a warning. */
  pressureRatio?: number
  /** Multiplier applied to the hard limit while under context pressure. Default 0.5 (8000 → 4000); like the other payload-guard keys, 0 disables (no tightening), as does any value ≥ 1. A non-numeric value falls back to the default with a warning. */
  pressureHardFactor?: number
  /** Bounded automatic retries for a MALFORMED_RESPONSE (each with corrective inbox context). Default 1; 0 means nudge-only, no retry. Streaks reset on any completed turn. A non-numeric value falls back to the default with a warning. */
  malformedRetry?: number
  /** Corrective messages injected per turn when the previous assistant message leaked dead-call markup. Default 2; 0 disables the markup guard. A non-numeric value falls back to the default with a warning. */
  markupBlock?: number
  /** Shortest leaked-markup fragment that still counts as an attempt (the host defense's minimum). Default 40. A non-numeric value falls back to the default with a warning. */
  markupMinChars?: number
}

/**
 * The working-directory service, typed structurally: this plugin only needs
 * `ensure`, and depending on the concrete package type would drag the whole
 * service surface into the shim.
 */
interface WorkingDirectoryLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

/**
 * The live session handle as the payload guard needs it: identity for
 * streak/pressure keys, and the routing accessor that answers the model's
 * context window. Typed structurally, like `WorkingDirectoryLike`.
 */
interface SessionLike {
  readonly id: unknown
  requestContext?(): { contextWindow?: number } | undefined
}

/**
 * The system-prompt service as the PTC-convention note needs it: only
 * `context()`. Typed structurally, like `WorkingDirectoryLike`, so the
 * plugin stays free of dsh-system-prompt's full surface.
 */
interface SystemPromptLike {
  context(entry: {
    name: string
    order: number
    text: (input: { agent?: { session?: unknown } }) => string
  }): () => void
}

/** The agent handle's session identity, or undefined when unprovable. */
function sessionOf(agent: unknown): SessionLike | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const session = (agent as { session?: unknown }).session
  return typeof session === 'object' && session !== null ? (session as SessionLike) : undefined
}

/** Stable streak key for a session handle. */
function sessionIdOf(session: SessionLike | undefined): string | undefined {
  if (session === undefined) return undefined
  const id = session.id
  return id === undefined || id === null ? undefined : String(id)
}

/**
 * A user-role context message shaped like the host's own `createUserMessage`
 * (which is just `deepFreeze(structuredClone({ ...input, role: 'user', id:
 * uuid }))`; this plugin keeps runtime imports at node builtins only). The
 * `source.kind` is the plugin's own — the source sum type is merge-
 * extensible and consumers fall through unknown kinds, the same move the
 * host's degenerate-turn nudge makes.
 */
function pluginUserMessage(text: string): UserMessage {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin:dsh-search-path-guard' }),
  }) as unknown as UserMessage
}

/** Pull the model-facing text out of a frozen tool result snapshot. */
function resultText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return ''
  const blocks = (result as { content?: unknown }).content
  if (!Array.isArray(blocks)) return ''
  return blocks.map(b => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('')
}

/**
 * Streak identity for the loop guard. Keyed on the RAW model string, `x`,
 * `./x`, `C:\x` and `c:/x` each carried their own counter: varying the
 * spelling both dodged the guard and diluted a real streak — exactly the
 * pathology the tracker exists to count. Resolve once against the workdir,
 * fold separators, case-fold on Windows (the filesystem does not
 * distinguish); the denial message still quotes the model's own spelling.
 */
function streakKey(rawPath: string, workdir: string): string {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(workdir, rawPath)
  const folded = abs.replace(/\\/gu, '/')
  return process.platform === 'win32' ? folded.toLowerCase() : folded
}

export const inject = ['workingDirectory']

/**
 * Register the pre-execute listener and the result observer for the plugin
 * lifetime. Cordis detaches listeners registered inside `apply` when the
 * plugin unloads, so no explicit effect bookkeeping is needed.
 * @param ctx - the plugin context.
 * @param config - the optional plugin configuration.
 */
export function apply(ctx: Context, config?: GuardConfig): void {
  if (config?.disabled === true) return
  const workingDirectory = (ctx as unknown as { workingDirectory: WorkingDirectoryLike }).workingDirectory
  // Config hygiene: a typo'd number must not SILENTLY disable a guard.
  // `Math.max(1, NaN)` is NaN and `streak >= NaN` is never true, so a typo in
  // `zeroResultBlock` sits the loop guard out for the whole session;
  // `size > NaN` is never true either, so `maxEditBytes` reads every file
  // whole. Warn and fall back to the default (the logger is optional: test
  // contexts construct a bare ctx).
  const numeric = (value: unknown, fallback: number, label: string): number => {
    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const logger = (ctx as unknown as { logger?: { warn?: (msg: string) => void } }).logger
    logger?.warn?.(`search-path-guard: config "${label}"=${String(value)} is not a finite number; using default ${fallback}`)
    return fallback
  }
  const zeroResultBlock = Math.max(1, numeric(config?.zeroResultBlock, 5, 'zeroResultBlock'))
  const maxEditBytes = numeric(config?.maxEditBytes, EDIT_PREFLIGHT_MAX_BYTES, 'maxEditBytes')
  const argsHardTokens = Math.max(0, numeric(config?.argsHardTokens, DEFAULT_ARGS_HARD_TOKENS, 'argsHardTokens'))
  const argsSoftRaw = Math.max(0, numeric(config?.argsSoftTokens, DEFAULT_ARGS_SOFT_TOKENS, 'argsSoftTokens'))
  // A soft reminder above the hard limit is unreachable: the hard guard
  // denies such calls before any result exists. Clamping keeps a typo from
  // silently dead-coding the reminder.
  const argsSoftTokens = argsHardTokens > 0 && argsSoftRaw > argsHardTokens ? argsHardTokens : argsSoftRaw
  const pressureRatio = Math.min(1, Math.max(0, numeric(config?.pressureRatio, DEFAULT_PRESSURE_RATIO, 'pressureRatio')))
  // Clamped to [0,1]; `effectiveHardLimit` treats ≤ 0 as "no tightening" so
  // `0` keeps the family-wide "0 = off" semantics instead of collapsing the
  // limit to 1 token and denying everything under pressure.
  const pressureHardFactor = Math.min(1, Math.max(0, numeric(config?.pressureHardFactor, DEFAULT_PRESSURE_HARD_FACTOR, 'pressureHardFactor')))
  const malformedRetry = Math.max(0, numeric(config?.malformedRetry, DEFAULT_MALFORMED_RETRY, 'malformedRetry'))
  const markupBlock = Math.max(0, numeric(config?.markupBlock, DEFAULT_MARKUP_BLOCK, 'markupBlock'))
  const markupMinChars = Math.max(1, numeric(config?.markupMinChars, DEFAULT_MARKUP_MIN_CHARS, 'markupMinChars'))
  const tracker = new ZeroResultTracker()
  const escalation = new DenialEscalation()
  // Payload-guard state. Streaks key on session ID (the request-error,
  // agent/error and turn/end events all answer it, so `turn/end(completed)`
  // can clear without an agent↔session reverse index); the turn-open and
  // usage maps key on the session HANDLE (identity shared across events).
  const malformed = new MalformedStreak()
  const nudged = new NudgedTurns()
  const lastContextTokens = new WeakMap<object, number>()
  const openTurn = new WeakMap<object, number>()
  // Soft-reminder budget: at most 2 per agent per open turn — a session
  // churning 3k-token payloads gets nudged twice, then silence.
  const softBudget = new WeakMap<object, { turn: number | undefined; count: number }>()
  // Markup-guard state: the newest assistant message per session (turn + text
  // blocks) is what the pre-step detector reads; the budget bounds the
  // corrections per turn and the streak drives their escalation wording.
  const lastAssistant = new WeakMap<object, { turn: number; text: string }>()
  const markupBudget = new MarkupTurnBudget()
  const leakStreak = new LeakStreak()

  /**
   * The hard limit tightened under context pressure. The measured incident
   * truncated at ~74% window fill: long generations degrade as the window
   * fills, so a payload that passes cheap in a fresh session is a coin flip
   * near the ceiling. When the fill cannot be PROVEN (no usage yet, no
   * window accessor), no scaling — the guard asserts only what it can see.
   */
  const effectiveHardLimit = (agent: unknown): number => {
    if (pressureRatio <= 0 || pressureHardFactor <= 0 || pressureHardFactor >= 1) return argsHardTokens
    const session = sessionOf(agent)
    if (session === undefined) return argsHardTokens
    const lastTotal = lastContextTokens.get(session)
    if (lastTotal === undefined) return argsHardTokens
    let contextWindow: number | undefined
    try {
      contextWindow = typeof session.requestContext === 'function'
        ? session.requestContext()?.contextWindow
        : undefined
    } catch {
      contextWindow = undefined // a partial handle is a missing decision input, not a crash
    }
    if (typeof contextWindow !== 'number' || !(contextWindow > 0)) return argsHardTokens
    if (lastTotal / contextWindow >= pressureRatio) return Math.max(1, Math.floor(argsHardTokens * pressureHardFactor))
    return argsHardTokens
  }

  /** The split guidance as a durable user-role message (same shape the nudge needs on both channels). */
  const malformedNudgeMessage = (): UserMessage => pluginUserMessage(malformedNudge(argsSoftTokens))

  /** Queue the nudge for the retry's following step. A failed append never cancels the bounded retry. */
  const appendMalformedNudge = (agent: unknown): void => {
    const inbox = (agent as { inbox?: { append?: (target: string, message: unknown) => unknown } } | undefined)?.inbox
    if (typeof inbox?.append !== 'function') return
    try {
      inbox.append('next-step', malformedNudgeMessage())
    } catch {
      // Nudge absence only means the retry is blind; the streak still bounds it.
    }
  }

  /** Inject the nudge for the next pre-step (next user push). Old hosts without `inject` are skipped. */
  const injectMalformedNudge = (agent: unknown): void => {
    const inject = (agent as { inject?: (message: unknown) => unknown } | undefined)?.inject
    if (typeof inject !== 'function') return
    try {
      inject.call(agent, malformedNudgeMessage())
    } catch {
      // Guidance is best-effort; an observer must never throw into the emitter.
    }
  }

  /** Deny with the escalation wording; any allowed call later resets the streak. */
  const deny = (exec: { readonly agent?: unknown }, reason: string): PreToolDecision =>
    ({ kind: 'deny', reason: escalatedReason(reason, escalation.note(exec.agent)) })

  /**
   * Every allowed dispatch — guarded or not — is progress the model can see,
   * so it resets the consecutive-denial streak. Only an unbroken run of
   * denials escalates.
   */
  const allow = (exec: { readonly agent?: unknown }, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    escalation.clear(exec.agent)
    return next()
  }

  /**
   * The workdir last resolved for an agent, set by the pre-execute path.
   * `tools/result` listeners are SYNCHRONOUS (cordis types them to return
   * `undefined` and does not await one), so the observer reads the streak key
   * from this cache instead of re-`ensure()`ing — an `await` here would also
   * land the streak update one microtask AFTER the next pre-execute reads
   * it. The pipeline always runs pre-execute before the call's result, so the
   * cache is warm for every tracked call; a cold cache skips tracking (with
   * no workdir there is no path to normalize against).
   */
  const workdirCache = new WeakMap<object, string>()

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (typeof agent !== 'object' || agent === null) return
    const workdir = workdirCache.get(agent)
    if (workdir === undefined) return
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return
    const pathKey = pathKeyFor(exec.name) ?? (exec.name === 'write' ? 'file_path' : undefined)
    if (pathKey === undefined) return
    const target = (args as Record<string, unknown>)[pathKey]
    if (typeof target !== 'string') return
    const text = resultText(result)
    if (exec.name === 'edit' || exec.name === 'write') {
      // A successful write to the searched target is external evidence the
      // dead end may no longer be dead (the content the greps kept missing
      // could now exist), so it unlocks that target's streak. A failed write
      // is not progress and leaves the streak untouched.
      if (text.startsWith('Error:')) return
      tracker.clear(agent, streakKey(target, workdir))
      return
    }
    if (exec.name !== 'grep') return
    // A denied call still reaches this event: the pipeline emits an
    // `Error: …` result for pre-execute denials, and the loop-guard denial
    // quotes the zero-result marker. That denial is not a search outcome —
    // observing it would inflate the very streak the message reports (and a
    // payload-guard denial would CLEAR a real streak as a "nonzero result") —
    // so guard denials are ignored here, neither extending nor clearing.
    if (text.startsWith('Error: loop-guard') || text.startsWith('Error: payload-guard')) return
    tracker.observe(agent, streakKey(target, workdir), text)
  })

  // Usage/turn observation for the payload guard: the newest reported context
  // size drives pressure scaling, the open turn number drives the
  // soft-reminder budget, and a COMPLETED turn is visible progress that
  // resets any MALFORMED_RESPONSE streak.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      const total = event.data.usage?.totalTokens
      if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
        lastContextTokens.set(session as unknown as object, total)
      }
      // Markup-guard capture: the frozen message's text blocks and its turn,
      // so the next pre-step can detect a leak in THIS turn's own output.
      // The turn is kept with the text — a leak from a finished turn is
      // stale intent by the time the user has spoken again, and re-flagging
      // it at every future turn's first step would be the guard becoming
      // the noise it exists to prevent.
      const leakedTurn = event.data.turn
      const message = event.data.message
      if (typeof leakedTurn === 'number' && typeof message === 'object' && message !== null && Array.isArray(message.content)) {
        const text = message.content
          .map(block => (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
          .join('\n')
        lastAssistant.set(session as unknown as object, { turn: leakedTurn, text })
      }
      return
    }
    if (event.type === 'turn/start') {
      const turn = event.data.turn
      if (typeof turn === 'number' && Number.isFinite(turn)) openTurn.set(session as unknown as object, turn)
      return
    }
    if (event.type === 'turn/end') {
      if (event.data.reason?.kind === 'completed') {
        // The first `session/event` argument IS the session — no sessionOf hop.
        const key = sessionIdOf(session as unknown as SessionLike)
        if (key !== undefined) malformed.clear(key)
      }
    }
  })

  // Post-dispatch soft channel: a call that SUCCEEDED but streamed large
  // gets its split-reminder attached to the NEXT request (additionalContexts
  // is the host's own "attach context for the next request" slot — the
  // repeat-tool-reminder shape). Shaping the next generation is the only
  // lever a stream-side truncation has before it happens.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    if (argsSoftTokens <= 0 || decision.kind !== 'accept' || result.isError === true) return decision
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return decision
    // Cap the walk just above the hard limit: ≥ hard was denied at
    // pre-execute, and a cap-crossing estimate only proves "> cap", so such
    // calls get no reminder rather than a made-up token figure.
    const cap = argsHardTokens > 0 ? argsHardTokens + 1 : Math.max(argsSoftTokens * 8, 10_000)
    const estimated = estimateArgsTokens(args, cap)
    if (estimated < argsSoftTokens || (argsHardTokens > 0 && estimated > argsHardTokens)) return decision
    const agent = exec.agent
    if (typeof agent !== 'object' || agent === null) return decision
    const turn = openTurn.get(sessionOf(agent) ?? {})
    const spent = softBudget.get(agent)
    const count = spent === undefined || spent.turn !== turn ? 1 : spent.count + 1
    if (count > 2) return decision
    softBudget.set(agent, { turn, count })
    const reminder = pluginUserMessage(argsSoftReminder(exec.name, estimated, argsSoftTokens))
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), reminder] }
  })

  // The MALFORMED_RESPONSE code is built-in and marked retryable by the
  // host, yet measured sessions showed the turn simply dying on it. A
  // bounded, per-session streak of ONE re-issue is the recovery; the inbox
  // nudge makes the following step smaller instead of identical. (If
  // dsh-llm-retry is also installed, do NOT add this code to its
  // retryableCodes — that would double-retry through two owners.)
  ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    if (malformedRetry <= 0) return next()
    if (payload.failure?.code !== MALFORMED_CODE) return next()
    const key = sessionIdOf(sessionOf(payload.agent))
    if (key === undefined) return next() // unprovable session: no streak to bound the retry by
    const streak = malformed.note(key)
    if (streak > malformedRetry) return next() // budget spent: hand back, agent/error carries the guidance
    const turn = typeof payload.turn === 'number' ? payload.turn : undefined
    if (turn !== undefined) nudged.claim(key, turn) // this turn already has its nudge
    appendMalformedNudge(payload.agent)
    return { kind: 'retry' }
  })

  // The failure surface of a turn that ended on the truncation (also reached
  // when the bounded retry itself failed). Claiming the turn keeps the
  // request-error nudge and this inject from stacking two copies inside one
  // turn; with `malformedRetry: 0` this is the guidance channel alone.
  ctx.on('agent/error', (payload) => {
    const code = typeof payload.error === 'object' && payload.error !== null
      ? (payload.error as { code?: unknown }).code
      : undefined
    if (code !== MALFORMED_CODE) return
    const key = sessionIdOf(sessionOf(payload.agent))
    if (key === undefined) return
    const turn = typeof payload.turn === 'number' ? payload.turn : undefined
    if (turn !== undefined && !nudged.claim(key, turn)) return
    injectMalformedNudge(payload.agent)
  })

  // 方案 A2 (prompt layer): a standing PTC call-convention note in the
  // per-step runtime-context snapshot — the same semantics as the host's
  // static `tools:ptc-only` section, but refreshed at every step so it sits
  // adjacent to where a leak is about to happen instead of decaying at the
  // top of a long context. Registered through the service-injection seam
  // (the sandbox-policy shape); a host without `systemPrompt` (or a bare
  // test context) simply skips it. Order 118 slots the note between
  // APPROVAL_POLICY (115) and SUBAGENT_DELEGATION (120), keeping the policy
  // cluster together.
  const injectable = ctx as unknown as {
    inject?: (services: string[], register: (scope: { systemPrompt?: SystemPromptLike }) => void) => void
  }
  injectable.inject?.(['systemPrompt'], (scope) => {
    scope.systemPrompt?.context({
      name: 'search-path-guard:ptc-call-convention',
      order: 118,
      text: (input) => (input.agent?.session === undefined ? '' : PTC_CALL_CONVENTION),
    })
  })

  // 方案 B (markup guard): every pre-step, look at the newest assistant
  // message of THIS turn; if its text carries dead call markup, splice one
  // budgeted corrective user message after the step's admitted messages —
  // adjacent to the leak, so the model never has to relate across steps.
  // The host defense's tool-call-block exemption is exactly the blind spot
  // here (hybrid PTC blocks), so this detector runs on text alone; the
  // per-turn budget keeps the correction from becoming the noise.
  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    if (markupBlock <= 0) return next()
    const agent = payload.agent
    if (typeof agent !== 'object' || agent === null) return next()
    const turn = payload.turn
    if (typeof turn !== 'number') return next()
    const session = sessionOf(agent)
    const leaked = session === undefined ? undefined : lastAssistant.get(session)
    if (leaked === undefined || leaked.turn !== turn) return next()
    const attempt = detectMarkupLeak(leaked.text, markupMinChars)
    if (attempt === undefined) {
      leakStreak.clear(agent) // a clean message is visible progress
      return next()
    }
    if (markupBudget.count(agent, turn) >= markupBlock) return next()
    const decision = await next()
    if (decision.kind === 'reject') return decision
    // Counted only when the correction actually ships: a rejected decision
    // must not spend the turn's budget on a step that never happened.
    const repeat = leakStreak.note(agent)
    markupBudget.note(agent, turn)
    return { ...decision, messages: [...decision.messages, pluginUserMessage(markupNudge(attempt, repeat))] }
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    // The payload guard runs AHEAD of the path gate: oversized arguments are
    // a model-side risk, and the tools that carry them (`write`, `bash`,
    // PTC payloads…) are not in the path-key set at all.
    if (argsHardTokens > 0 && typeof exec.arguments === 'object' && exec.arguments !== null) {
      const hard = effectiveHardLimit(exec.agent)
      const estimated = estimateArgsTokens(exec.arguments, hard + 1)
      if (estimated >= hard) return deny(exec, argsHardDenial(exec.name, estimated, hard))
    }
    const pathKey = pathKeyFor(exec.name)
    if (pathKey === undefined) return allow(exec, next)
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return allow(exec, next)
    const rawPath = (args as Record<string, unknown>)[pathKey]
    if (typeof rawPath !== 'string') return allow(exec, next)
    let workdir: string
    try {
      workdir = await workingDirectory.ensure(exec.agent, exec.signal)
    } catch {
      // An unresolvable workdir is the tool's own failure to report; defer.
      return allow(exec, next)
    }
    if (typeof exec.agent === 'object' && exec.agent !== null) workdirCache.set(exec.agent, workdir)
    if (exec.name === 'grep') {
      const streak = tracker.streakFor(exec.agent, streakKey(rawPath, workdir))
      if (streak >= zeroResultBlock) return deny(exec, zeroResultDenial(rawPath, streak))
    }
    const editArgs = args as { old_string?: unknown; replace_all?: unknown }
    const reason = exec.name === 'edit'
      ? (typeof editArgs.old_string === 'string'
        ? editDenial({
            path: rawPath,
            workdir,
            oldString: editArgs.old_string,
            replaceAll: editArgs.replace_all === true,
            maxBytes: maxEditBytes,
          })
        : undefined) // old_string validation belongs to the tool's schema
      : searchPathDenial({ name: exec.name, path: rawPath, workdir })
    if (reason === undefined) return allow(exec, next)
    return deny(exec, reason)
  })
}
