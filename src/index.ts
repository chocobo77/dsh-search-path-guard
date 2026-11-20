/**
 * `tools/pre-execute` guard, three families of provably-dead calls:
 * 1. a `grep`/`glob`/`read` target that does not exist (one-line self-healing
 *    denial instead of a mojibake-prone tool error);
 * 2. an `edit` whose `old_string` is not in the current file, or matches
 *    ambiguously (the stale-edit spiral after concurrent writes);
 * 3. a `grep` whose target has burned `zeroResultBlock` consecutive
 *    "No matches found" searches (the measured runaway loop: 370
 *    pattern-variations on one file across turns).
 * Registered as a monotonic pre-execute listener plus a `tools/result`
 * observer; a denial cannot be un-done by listener ordering, and everything
 * the guard cannot prove falls through to `next()` unchanged.
 * @module dsh-search-path-guard
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
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
}

/**
 * The working-directory service, typed structurally: this plugin only needs
 * `ensure`, and depending on the concrete package type would drag the whole
 * service surface into the shim.
 */
interface WorkingDirectoryLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
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
  const tracker = new ZeroResultTracker()
  const escalation = new DenialEscalation()

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
    // observing it would inflate the very streak the message reports — so it
    // is ignored here, neither extending nor clearing the streak.
    if (text.startsWith('Error: loop-guard')) return
    tracker.observe(agent, streakKey(target, workdir), text)
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
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
