/**
 * `tools/pre-execute` guard: deny `grep`/`glob` calls whose search root does
 * not exist, with a one-line self-healing reason, before ripgrep spawns.
 * Registered as a monotonic pre-execute listener, so a denial cannot be
 * un-done by listener ordering. No allow result — everything this guard does
 * not recognize falls through to `next()` unchanged.
 * @module dsh-search-path-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { searchPathDenial } from './preflight.ts'

export const name = 'search-path-guard'

/** Optional plugin configuration. */
export interface GuardConfig {
  /** Set true to unload the guard while keeping the bundle installed. */
  disabled?: boolean
}

/**
 * The working-directory service, typed structurally: this plugin only needs
 * `ensure`, and depending on the concrete package type would drag the whole
 * service surface into the shim.
 */
interface WorkingDirectoryLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

export const inject = ['workingDirectory']

/**
 * Register the pre-execute listener for the plugin lifetime. Cordis detaches
 * listeners registered inside `apply` when the plugin unloads, so no explicit
 * effect bookkeeping is needed.
 * @param ctx - the plugin context.
 * @param config - the optional plugin configuration.
 */
export function apply(ctx: Context, config?: GuardConfig): void {
  if (config?.disabled === true) return
  // The working-directory service augments Context only where its own package
  // is on the type path; read it structurally off the runtime context.
  const workingDirectory = (ctx as unknown as { workingDirectory: WorkingDirectoryLike }).workingDirectory
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== 'grep' && exec.name !== 'glob') return next()
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return next()
    const path = (args as { path?: unknown }).path
    if (typeof path !== 'string') return next()
    let workdir: string
    try {
      workdir = await workingDirectory.ensure(exec.agent, exec.signal)
    } catch {
      // An unresolvable workdir is the tool's own failure to report; defer.
      return next()
    }
    const reason = searchPathDenial({ name: exec.name, path, workdir })
    if (reason === undefined) return next()
    return { kind: 'deny', reason }
  })
}
