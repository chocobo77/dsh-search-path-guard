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

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { editDenial, pathKeyFor, searchPathDenial } from './preflight.ts'
import { ZeroResultTracker, zeroResultDenial } from './repeat-guard.ts'

export const name = 'search-path-guard'

/** Optional plugin configuration. */
export interface GuardConfig {
  /** Set true to unload the guard while keeping the bundle installed. */
  disabled?: boolean
  /** Skip the edit content check above this file size (default 2 MB). */
  maxEditBytes?: number
  /** Consecutive zero-result greps on one target before the loop guard denies. Default 5. */
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
  const zeroResultBlock = config?.zeroResultBlock ?? 5
  const tracker = new ZeroResultTracker()

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'grep') return
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return
    const path = (args as Record<string, unknown>).path
    if (typeof path !== 'string') return
    tracker.observe(exec.agent, path, resultText(result))
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const pathKey = pathKeyFor(exec.name)
    if (pathKey === undefined) return next()
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return next()
    const rawPath = (args as Record<string, unknown>)[pathKey]
    if (typeof rawPath !== 'string') return next()
    let workdir: string
    try {
      workdir = await workingDirectory.ensure(exec.agent, exec.signal)
    } catch {
      // An unresolvable workdir is the tool's own failure to report; defer.
      return next()
    }
    if (exec.name === 'grep') {
      const streak = tracker.streakFor(exec.agent, rawPath)
      if (streak >= zeroResultBlock) return { kind: 'deny', reason: zeroResultDenial(rawPath, streak) }
    }
    const editArgs = args as { old_string?: unknown; replace_all?: unknown }
    const reason = exec.name === 'edit'
      ? (typeof editArgs.old_string === 'string'
        ? editDenial({
            path: rawPath,
            workdir,
            oldString: editArgs.old_string,
            replaceAll: editArgs.replace_all === true,
            ...(config?.maxEditBytes !== undefined ? { maxBytes: config.maxEditBytes } : {}),
          })
        : undefined) // old_string validation belongs to the tool's schema
      : searchPathDenial({ name: exec.name, path: rawPath, workdir })
    if (reason === undefined) return next()
    return { kind: 'deny', reason }
  })
}
