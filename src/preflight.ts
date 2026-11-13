/**
 * Pure preflight decision for the `grep` and `glob` search roots. The
 * dominant measured failure (27 of 287 tool errors across 74 historical
 * sessions) is a guessed path reaching ripgrep, whose localized exit-2
 * stderr — often mojibake on this deployment — then enters the model
 * context. This module turns such a call into a one-line denial that names
 * the remedy: glob the parent, then retry with an existing path.
 * @module dsh-search-path-guard/preflight
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** The tool names this guard inspects. */
export const guardedTools = ['grep', 'glob'] as const

/**
 * Compute the denial reason for one pending `grep`/`glob` call, or
 * `undefined` when the call should proceed.
 *
 * Deliberately lenient — every doubt defers to the tool:
 * - no `path` argument ⇒ rg searches the workdir, which the working-directory
 *   service guarantees;
 * - a non-string or blank `path` ⇒ the tool's own schema validation reports it;
 * - a `workdir` that cannot be confirmed to exist ⇒ skip (scripted test
 *   fixtures use notional workdirs; production `ensure` guarantees one);
 * - an existing path ⇒ allow, including paths that exist but may still fail
 *   (a locked file, a denied directory) — existence is the only claim this
 *   guard makes.
 *
 * @param params - the tool name, the model-supplied path, and the agent's workdir.
 * @returns the one-line denial reason, or `undefined` to allow the call.
 */
export function searchPathDenial(params: { name: string; path: string; workdir: string }): string | undefined {
  if (!(guardedTools as readonly string[]).includes(params.name)) return undefined
  if (params.path.trim().length === 0) return undefined
  const resolvedPath = isAbsolute(params.path) ? params.path : resolve(params.workdir, params.path)
  // Only judge relative claims against a workdir that exists; production
  // `workingDirectory.ensure` guarantees one, scripted fixtures may not.
  if (!existsSync(params.workdir)) return undefined
  if (existsSync(resolvedPath)) return undefined
  const near = resolve(resolvedPath, '..').replace(/\\/gu, '/')
  return `${params.name} search failed: path "${params.path}" does not exist`
    + ` — glob near "${near}" to list existing candidates, then retry with an existing path`
}
