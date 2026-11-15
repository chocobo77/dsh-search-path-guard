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

  it('skips the content check above the byte budget', () => {
    const reason = editDenial({ path: target, workdir, oldString: 'const b = 2', replaceAll: false, maxBytes: 1 })
    expect(reason).toBeUndefined()
    expect(EDIT_PREFLIGHT_MAX_BYTES).toBeGreaterThan(1000)
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
