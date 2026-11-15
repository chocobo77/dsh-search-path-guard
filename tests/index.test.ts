import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('denies a bad grep path and a stale edit, allows everything else through', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-listener-'))
    const sub = join(workdir, 'sub')
    mkdirSync(sub)
    const target = join(sub, 'engine.ts')
    writeFileSync(target, 'const a = 1\nconst a = 1\n')
    const { ctx, state } = makeContext(workdir)
    apply(ctx)
    expect(state.listener).toBeTypeOf('function')
    const next = () => Promise.resolve({ kind: 'allow' })
    const badGrep = await state.listener?.(execOf('grep', { pattern: 'x', path: 'missing-dir' }), next) as { kind: string }
    const staleEdit = await state.listener?.(execOf('edit', { file_path: target, old_string: 'const b = 2', new_string: 'c' }), next) as { kind: string }
    const ambiguousEdit = await state.listener?.(execOf('edit', { file_path: target, old_string: 'const a = 1', new_string: 'c' }), next) as { kind: string }
    const uniqueEdit = await state.listener?.(execOf('edit', { file_path: target, old_string: 'const a = 1\nconst a = 1', new_string: 'c' }), next) as { kind: string }
    const readTool = await state.listener?.(execOf('read', { file_path: join(sub, 'nope.txt') }), next) as { kind: string }
    const good = await state.listener?.(execOf('grep', { pattern: 'x', path: 'sub' }), next) as { kind: string }
    const noPath = await state.listener?.(execOf('glob', { pattern: '*' }), next) as { kind: string }
    const other = await state.listener?.(execOf('write', { file_path: 'x.txt', content: 'y' }), next) as { kind: string }
    expect(badGrep.kind).toBe('deny')
    expect(staleEdit.kind).toBe('deny')
    expect(ambiguousEdit.kind).toBe('deny')
    expect(uniqueEdit.kind).toBe('allow')
    expect(readTool.kind).toBe('deny')
    expect(good.kind).toBe('allow')
    expect(noPath.kind).toBe('allow')
    expect(other.kind).toBe('allow')
    rmSync(workdir, { recursive: true, force: true })
  })

  it('respects the disabled config by registering nothing', () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx, { disabled: true })
    expect(state.listener).toBeUndefined()
  })
})
