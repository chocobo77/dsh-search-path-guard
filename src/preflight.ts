/**
 * Pure preflight decisions for the pre-execute guard. Born from the measured
 * failure modes across historical DSH sessions:
 * - 27/287 errors were grep/glob on nonexistent search roots whose localized
 *   ripgrep stderr (mojibake-prone) entered the model context;
 * - 7+ were `read` on nonexistent files with a bare "not found" and no remedy;
 * - a recurring evening of `edit` failures came from stale `old_string`s after
 *   concurrent sessions rewrote the same files.
 * Every doubt defers to the tool: the guard only asserts what it can prove.
 * @module dsh-search-path-guard/preflight
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** The tool names this guard inspects. */
export const guardedTools = ['grep', 'glob', 'read', 'read_image', 'edit'] as const

/** Tools whose target rides in `path` vs `file_path`. */
const PATH_KEY: Record<string, 'path' | 'file_path'> = {
  grep: 'path',
  glob: 'path',
  read: 'file_path',
  read_image: 'file_path',
  edit: 'file_path',
}

/** read_image only accepts these raster formats; everything else is text-ish. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

/** Preflight budget above which an edit target is not read at all. */
export const EDIT_PREFLIGHT_MAX_BYTES = 2_000_000

/**
 * Compute the denial reason for one guarded call, or `undefined` to allow.
 *
 * Lenient by design — every doubt defers to the tool:
 * - a missing/blank target ⇒ schema validation's job;
 * - an unstatable workdir ⇒ scripted fixtures may use notional directories,
 *   and production `ensure` guarantees one;
 * - an existing path ⇒ allowed, including existing-but-locked (the guard
 *   asserts existence and nothing else);
 * - an `edit` whose file is over the preflight budget ⇒ skip the content
 *   check entirely rather than read megabytes on every call.
 *
 * @param params - tool name, model-supplied target path, agent workdir, and
 *   the full arguments for the edit content check.
 * @returns the one-line denial reason, or `undefined` when the call may proceed.
 */
export function searchPathDenial(params: {
  name: string
  path: string
  workdir: string
  replaceAll?: boolean
  maxEditBytes?: number
}): string | undefined {
  if (!(guardedTools as readonly string[]).includes(params.name)) return undefined
  if (params.path.trim().length === 0) return undefined
  const resolvedPath = isAbsolute(params.path) ? params.path : resolve(params.workdir, params.path)
  // Only judge claims against a workdir that exists (production guarantees
  // one; scripted fixtures may not).
  if (!existsSync(params.workdir)) return undefined
  if (existsSync(resolvedPath)) {
    if (params.name === 'read_image') return imageExtensionDenial(params.path)
    return undefined
  }
  const near = resolve(resolvedPath, '..').replace(/\\/gu, '/')
  if (params.name === 'read' || params.name === 'read_image') {
    return `${params.name} failed: file "${params.path}" does not exist`
      + ` — glob near "${near}" to locate the correct path, or check whether the step that was supposed to create it actually succeeded`
  }
  return `${params.name} search failed: path "${params.path}" does not exist`
    + ` — glob near "${near}" to list existing candidates, then retry with an existing path`
}

/** read_image on an existing non-image file: point at `read` instead of restating the format list. */
function imageExtensionDenial(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return undefined // no extension: let the tool report
  const ext = path.slice(dot).toLowerCase()
  if (IMAGE_EXTENSIONS.includes(ext)) return undefined
  if (ext === '.svg') {
    return `read_image only accepts PNG/JPEG/WebP/GIF — "${path}" is SVG, which is text: use read`
  }
  return `read_image only accepts PNG/JPEG/WebP/GIF — "${path}" (extension "${ext}") is not a supported image format; use read for text files`
}

/**
 * Decide the denial for one pending `edit` before the tool computes a diff:
 * the dominant stale-edit failure (`old_string was not found`) is a symptom
 * of the file having changed since the model last read it — often a
 * concurrent session — and a bare "not found" sends the model into blind
 * retries. This check reads the current content and reports what is actually
 * there instead.
 *
 * @param params - the edit arguments plus the resolved absolute target path.
 * @returns the one-line denial reason, or `undefined` when the edit should proceed.
 */
export function editDenial(params: {
  path: string
  workdir: string
  oldString: string
  replaceAll: boolean
  maxBytes?: number
}): string | undefined {
  // 空白/空 old_string 是 schema 违规，工具自己有精确报错；本守卫的
  // "not found / 并发修改" 文案对它是不成立的误导。
  if (params.oldString.length === 0) return undefined
  const maxBytes = params.maxBytes ?? EDIT_PREFLIGHT_MAX_BYTES
  const resolvedPath = isAbsolute(params.path) ? params.path : resolve(params.workdir, params.path)
  let stats
  try {
    stats = statSync(resolvedPath)
  } catch {
    return undefined // vanished between the existence check and now: let the tool report
  }
  if (!stats.isFile() || stats.size > maxBytes) return undefined
  let content: string
  try {
    content = readFileSync(resolvedPath, 'utf8')
  } catch {
    return undefined // unreadable (locked/permissions): the tool's own error is the right one
  }
  if (content.includes('\uFFFD')) {
    // 解码出现替换符：文件是二进制或非 UTF-8 编码，"并发修改"提示会误导。
    return undefined
  }
  const matches = countOccurrences(content, params.oldString)
  if (matches === 0) {
    return `edit blocked: old_string was not found in "${params.path}"`
      + ' — the file has likely changed since your last read (concurrent edits are common in this workspace):'
      + ' re-read the relevant range (read with offset/limit) and build old_string from what is there now'
  }
  if (!params.replaceAll && matches > 1) {
    return `edit blocked: old_string matches ${matches} times in "${params.path}"`
      + ' — extend old_string with surrounding lines to make it unique, or pass replace_all: true only if every occurrence should change'
  }
  return undefined
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/** The argument key each guarded tool uses for its target path. */
export function pathKeyFor(name: string): 'path' | 'file_path' | undefined {
  return PATH_KEY[name as keyof typeof PATH_KEY]
}
