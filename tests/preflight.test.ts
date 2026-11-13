import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchPathDenial, guardedTools } from '../src/preflight.ts'

const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-'))
const existing = join(workdir, 'packages')
mkdirSync(existing)

describe('searchPathDenial', () => {
  it('denies a nonexistent relative path with a glob-near remedy', () => {
    const reason = searchPathDenial({ name: 'grep', path: 'definitely/missing', workdir })
    expect(reason).toContain('grep search failed')
    expect(reason).toContain('does not exist')
    expect(reason).toContain(`glob near "${join(workdir, 'definitely').replace(/\\/gu, '/')}"`)
    expect(reason.split('\n')).toHaveLength(1)
  })

  it('denies a nonexistent absolute path', () => {
    const reason = searchPathDenial({ name: 'glob', path: join(workdir, 'no-such-dir'), workdir })
    expect(reason).toContain('glob search failed')
    expect(reason).toContain('does not exist')
  })

  it('allows an existing path and a missing path argument', () => {
    expect(searchPathDenial({ name: 'grep', path: 'packages', workdir })).toBeUndefined()
    expect(searchPathDenial({ name: 'grep', path: existing, workdir })).toBeUndefined()
    expect(searchPathDenial({ name: 'glob', path: '', workdir })).toBeUndefined()
    expect(searchPathDenial({ name: 'grep', path: '   ', workdir })).toBeUndefined()
  })

  it('defers when the workdir itself does not exist and for unguarded tools', () => {
    expect(searchPathDenial({ name: 'grep', path: 'whatever', workdir: join(workdir, 'notional') })).toBeUndefined()
    expect(searchPathDenial({ name: 'read', path: 'whatever', workdir })).toBeUndefined()
    expect(guardedTools).toEqual(['grep', 'glob'])
  })

  it('is lenient about an existing-but-problematic path (existence is the only claim)', () => {
    // A denied/locked file cannot be proven here; the contract only promises
    // that an EXISTING path passes the guard.
    expect(searchPathDenial({ name: 'grep', path: '.', workdir })).toBeUndefined()
  })
})

describe('workspace hygiene', () => {
  it('removes the scratch workdir', () => {
    rmSync(workdir, { recursive: true, force: true })
    expect(existsSync(workdir)).toBe(false)
  })
})
