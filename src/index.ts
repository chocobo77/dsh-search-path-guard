/**
 * `tools/pre-execute` guard: deny guarded calls whose claims are already
 * false — a `grep`/`glob`/`read` target that does not exist, an `edit` whose
 * `old_string` is not in the current file — with a one-line self-healing
 * reason, before the tool body runs. Registered as a monotonic pre-execute
 * listener, so a denial cannot be un-done by listener ordering. No allow
 * result: everything this guard does not recognize falls through to `next()`
 * unchanged.
 * @module dsh-search-path-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { editDenial, pathKeyFor, searchPathDenial } from './preflight.ts'

export const name = 'search-path-guard'

/** Optional plugin configuration. */
export interface GuardConfig {
  /** Set true to unload the guard while keeping the bundle installed. */
  disabled?: boolean
  /** Skip the edit content check above this file size (default 2 MB). */
  maxEditBytes?: number
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
  const workingDirectory = (ctx as unknown as { workingDirectory: WorkingDirectoryLike }).workingDirectory
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
