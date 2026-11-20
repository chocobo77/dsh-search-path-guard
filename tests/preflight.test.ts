import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchPathDenial, editDenial, countOccurrences, guardedTools, EDIT_PREFLIGHT_MAX_BYTES } from '../src/preflight.ts'

const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-'))
const existing = join(workdir, 'packages')
mkdirSync(existing)

describe('searchPathDenial — search tools (unchanged semantics)', () => {
  it('denies a nonexistent relative search root with a glob-near remedy', () => {
    const reason = searchPathDenial({ name: 'grep', path: 'definitely/missing', workdir })
    expect(reason).toContain('grep search failed')
    expect(reason).toContain('does not exist')
    expect(reason).toContain(`glob near "${join(workdir, 'definitely').replace(/\\/gu, '/')}"`)
    expect(reason.split('\n')).toHaveLength(1)
  })

  it('denies a nonexistent absolute search root before spawn', () => {
    expect(searchPathDenial({ name: 'glob', path: join(workdir, 'no-such-dir'), workdir })).toContain('glob search failed')
  })

  it('allows an existing path and a missing path argument', () => {
    expect(searchPathDenial({ name: 'grep', path: 'packages', workdir })).toBeUndefined()
    expect(searchPathDenial({ name: 'grep', path: existing, workdir })).toBeUndefined()
    expect(searchPathDenial({ name: 'glob', path: '', workdir })).toBeUndefined()
  })

  it('defers when the workdir itself does not exist and for unguarded tools', () => {
    expect(searchPathDenial({ name: 'grep', path: 'whatever', workdir: join(workdir, 'notional') })).toBeUndefined()
    expect(searchPathDenial({ name: 'run_code', path: 'whatever', workdir })).toBeUndefined()
  })
})

describe('searchPathDenial — read / read_image', () => {
  it('denies a nonexistent file_path with a glob-near remedy', () => {
    const reason = searchPathDenial({ name: 'read', path: join(workdir, 'no-such-file.txt'), workdir })
    expect(reason).toContain('read failed: file')
    expect(reason).toContain('does not exist')
    expect(reason).toContain('glob near')
  })

  it('allows an existing read target', () => {
    const target = join(existing, 'a.txt')
    writeFileSync(target, 'x')
    expect(searchPathDenial({ name: 'read', path: target, workdir })).toBeUndefined()
  })

  it('routes read_image through the same existence check', () => {
    const reason = searchPathDenial({ name: 'read_image', path: join(workdir, 'missing.png'), workdir })
    expect(reason).toContain('read_image failed: file')
  })

  it('denies read_image on an existing non-image file with a use-read hint', () => {
    const svg = join(existing, 'icon.svg')
    writeFileSync(svg, '<svg/>')
    const reason = searchPathDenial({ name: 'read_image', path: svg, workdir })
    expect(reason).toContain('SVG')
    expect(reason).toContain('use read')
  })

  it('allows read_image on a supported image extension', () => {
    const png = join(existing, 'img.png')
    writeFileSync(png, '')
    expect(searchPathDenial({ name: 'read_image', path: png, workdir })).toBeUndefined()
  })
})

describe('editDenial', () => {
  const target = join(existing, 'engine.ts')
  writeFileSync(target, 'const a = 1\nconst a = 1\n')

  it('denies a stale old_string with a re-read remedy', () => {
    const reason = editDenial({ path: target, workdir, oldString: 'const b = 2', replaceAll: false })
    expect(reason).toContain('edit blocked: old_string was not found')
    expect(reason).toContain('re-read')
  })

  it('reports the match count for ambiguous old_string without replace_all', () => {
    const reason = editDenial({ path: target, workdir, oldString: 'const a = 1', replaceAll: false })
    expect(reason).toContain('matches 2 times')
    expect(editDenial({ path: target, workdir, oldString: 'const a = 1', replaceAll: true })).toBeUndefined()
  })

  it('allows a unique old_string and defers on a vanished file', () => {
    expect(editDenial({ path: target, workdir, oldString: 'const a = 1\nconst a = 1\n', replaceAll: false })).toBeUndefined()
    expect(editDenial({ path: join(existing, 'gone.ts'), workdir, oldString: 'x', replaceAll: false })).toBeUndefined()
  })

  it('defers an empty old_string to the tool schema instead of a misleading not-found', () => {
    expect(editDenial({ path: target, workdir, oldString: '', replaceAll: false })).toBeUndefined()
  })

  it('defers a binary/non-UTF-8 target instead of a misleading not-found', () => {
    const bin = join(existing, 'blob.bin')
    writeFileSync(bin, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01]))
    expect(editDenial({ path: bin, workdir, oldString: 'const b = 2', replaceAll: false })).toBeUndefined()
  })

  it('skips the content check above the byte budget', () => {
    const reason = editDenial({ path: target, workdir, oldString: 'const b = 2', replaceAll: false, maxBytes: 1 })
    expect(reason).toBeUndefined()
    expect(EDIT_PREFLIGHT_MAX_BYTES).toBeGreaterThan(1000)
  })

  it('matches a CRLF file with an LF-shaped old_string, exactly as the kernel fold does', () => {
    const crlf = join(existing, 'crlf.ts')
    writeFileSync(crlf, 'const a = 1\r\nconst b = 2\r\n')
    // The kernel (fsio normalizeLineEndings) folds \r\n in BOTH the content
    // and old_string before matching; the guard must count the same match, or
    // it denies an edit the kernel would apply and feeds the denial spiral.
    expect(editDenial({ path: crlf, workdir, oldString: 'const b = 2', replaceAll: false })).toBeUndefined()
    expect(editDenial({ path: crlf, workdir, oldString: 'const a = 1\nconst b = 2', replaceAll: false })).toBeUndefined()
    // and the AMBIGUOUS count is taken on folded text too
    expect(editDenial({ path: crlf, workdir, oldString: 'const', replaceAll: false })).toContain('matches 2 times')
  })

  it('matches an LF file against a CRLF-shaped old_string, and lone CR stays literal', () => {
    const lf = join(existing, 'lf.ts')
    writeFileSync(lf, 'const a = 1\n')
    expect(editDenial({ path: lf, workdir, oldString: 'const a = 1\r\n', replaceAll: false })).toBeUndefined()
    expect(editDenial({ path: lf, workdir, oldString: 'const q = 1\r\n', replaceAll: false })).toContain('was not found')
    // fsio folds only \r\n — a lone \r must NOT fold on either side
    const loneCr = join(existing, 'cr.ts')
    writeFileSync(loneCr, 'const a = 1\rconst b = 2\n')
    expect(editDenial({ path: loneCr, workdir, oldString: 'const a = 1\nconst b = 2', replaceAll: false })).toContain('was not found')
    expect(editDenial({ path: loneCr, workdir, oldString: 'const a = 1\rconst b = 2', replaceAll: false })).toBeUndefined()
  })
})

describe('countOccurrences', () => {
  it('counts non-overlapping matches and handles the empty needle', () => {
    expect(countOccurrences('aaa', 'aa')).toBe(1)
    expect(countOccurrences('abab', 'ab')).toBe(2)
    expect(countOccurrences('abc', '')).toBe(0)
  })
})

describe('workspace hygiene', () => {
  it('removes the scratch workdir', () => {
    rmSync(workdir, { recursive: true, force: true })
    expect(existsSync(workdir)).toBe(false)
  })
})

expect(guardedTools).toEqual(['grep', 'glob', 'read', 'read_image', 'edit'])
