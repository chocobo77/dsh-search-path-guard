import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

/** Minimal cordis-like context: captures the pre-execute listener. */
function makeContext(workdir: string) {
  const state = { listener: undefined as ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined }
  const ctx = {
    on: (_event: string, handler: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) => { state.listener = handler },
    workingDirectory: { ensure: () => Promise.resolve(workdir) },
  }
  return { ctx: ctx as never, state }
}

function execOf(name: string, args: unknown) {
  return { name, arguments: args, agent: undefined, signal: new AbortController().signal }
}

describe('apply', () => {
  it('registers a tools/pre-execute listener and denies a bad grep path', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-listener-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx)
    expect(state.listener).toBeTypeOf('function')
    const next = () => Promise.resolve({ kind: 'allow' })
    const decision = await state.listener?.(execOf('grep', { pattern: 'x', path: 'missing-dir' }), next) as { kind: string }
    expect(decision.kind).toBe('deny')
    rmSync(workdir, { recursive: true, force: true })
  })

  it('falls through to next() for other tools and for existing paths', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-listener-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx)
    const next = () => Promise.resolve({ kind: 'allow' })
    const read = await state.listener?.(execOf('read', { file_path: 'missing.txt' }), next) as { kind: string }
    const good = await state.listener?.(execOf('grep', { pattern: 'x', path: '.' }), next) as { kind: string }
    const noPath = await state.listener?.(execOf('glob', { pattern: '*' }), next) as { kind: string }
    expect(read.kind).toBe('allow')
    expect(good.kind).toBe('allow')
    expect(noPath.kind).toBe('allow')
    rmSync(workdir, { recursive: true, force: true })
  })

  it('respects the disabled config by registering nothing', () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx, { disabled: true })
    expect(state.listener).toBeUndefined()
  })
})
