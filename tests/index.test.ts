import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

/** Minimal cordis-like context: captures both registered listeners. */
function makeContext(workdir: string) {
  const state = {
    pre: undefined as ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined,
    result: undefined as ((exec: unknown, result: unknown) => unknown) | undefined,
  }
  const ctx = {
    on: (event: string, handler: (a: unknown, b?: unknown) => unknown) => {
      if (event === 'tools/pre-execute') state.pre = handler as never
      if (event === 'tools/result') state.result = handler as never
    },
    workingDirectory: { ensure: () => Promise.resolve(workdir) },
  }
  return { ctx: ctx as never, state }
}

function execOf(name: string, args: unknown) {
  return { name, arguments: args, agent: { session: {} }, signal: new AbortController().signal }
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
    expect(state.pre).toBeTypeOf('function')
    const next = () => Promise.resolve({ kind: 'allow' })
    const run = (name: string, args: unknown) =>
      state.pre?.(execOf(name, args), next) as Promise<{ kind: string }>
    expect((await run('grep', { pattern: 'x', path: 'missing-dir' })).kind).toBe('deny')
    expect((await run('edit', { file_path: target, old_string: 'const b = 2', new_string: 'c' })).kind).toBe('deny')
    expect((await run('edit', { file_path: target, old_string: 'const a = 1', new_string: 'c' })).kind).toBe('deny')
    expect((await run('edit', { file_path: target, old_string: 'const a = 1\nconst a = 1', new_string: 'c' })).kind).toBe('allow')
    expect((await run('read', { file_path: join(sub, 'nope.txt') })).kind).toBe('deny')
    expect((await run('read_image', { file_path: join(sub, 'icon.svg') })).kind).toBe('deny')
    expect((await run('grep', { pattern: 'x', path: 'sub' })).kind).toBe('allow')
    expect((await run('glob', { pattern: '*' })).kind).toBe('allow')
    expect((await run('write', { file_path: 'x.txt', content: 'y' })).kind).toBe('allow')
    rmSync(workdir, { recursive: true, force: true })
  })

  it('denies a grep after zeroResultBlock consecutive no-match searches on one path', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-loop-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx, { zeroResultBlock: 3 })
    const next = () => Promise.resolve({ kind: 'allow' })
    const path = join(workdir, 'app.log')
    writeFileSync(path, '')
    // 生产中同一 Agent 运行时对象穿透 pre 与 result 两个事件，这里同样共享
    const agent = { session: {} }
    const call = async () =>
      (await state.pre?.({ name: 'grep', arguments: { pattern: 'speed', path }, agent, signal: new AbortController().signal }, next)) as { kind: string; reason?: string }
    const execOfSelf = () =>
      ({ name: 'grep', arguments: { pattern: 'speed', path }, agent, signal: new AbortController().signal })
    const observe = () =>
      state.result?.(execOfSelf(), { content: [{ type: 'text', text: 'No matches found' }] })
    // 阈值 3：第 1~3 次调用放行（streak 0→3），第 4 次 deny
    expect((await call()).kind).toBe('allow'); observe()
    expect((await call()).kind).toBe('allow'); observe()
    expect((await call()).kind).toBe('allow'); observe()
    const denied = await call()
    expect(denied.kind).toBe('deny')
    // 生产管线对被拒调用同样发出 result 事件（`Error: ` 前缀），而守卫自己的
    // 拒绝文案里引用了零结果标记；该事件不得计入 streak，否则文案计数随重试虚增
    state.result?.(execOfSelf(), { content: [{ type: 'text', text: `Error: ${denied.reason ?? ''}` }] })
    const deniedAgain = await call()
    expect(deniedAgain.kind).toBe('deny')
    expect(deniedAgain.reason).toContain('last 3 greps')
    expect(deniedAgain.reason).not.toContain('last 4 greps')
    // 有匹配结果后清零，恢复放行
    state.result?.({ name: 'grep', arguments: { pattern: 'speed', path }, agent, signal: new AbortController().signal }, { content: [{ type: 'text', text: 'Found 1 match' }] })
    expect((await call()).kind).toBe('allow')
    rmSync(workdir, { recursive: true, force: true })
  })

  it('respects the disabled config by registering nothing', () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx, { disabled: true })
    expect(state.pre).toBeUndefined()
    expect(state.result).toBeUndefined()
  })
})

describe('apply — denial escalation', () => {
  it('escalates the third consecutive denial and resets after an allowed call', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-escalate-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx)
    const next = () => Promise.resolve({ kind: 'allow' })
    const agent = { session: {} }
    const bad = () => state.pre?.({ name: 'grep', arguments: { pattern: 'x', path: 'missing' }, agent, signal: new AbortController().signal }, next) as Promise<{ kind: string; reason?: string }>
    const good = () => state.pre?.({ name: 'grep', arguments: { pattern: 'x' }, agent, signal: new AbortController().signal }, next) as Promise<{ kind: string; reason?: string }>
    const d1 = await bad()
    const d2 = await bad()
    const d3 = await bad()
    expect(d1.kind).toBe('deny')
    expect(d1.reason).not.toContain('escalation')
    expect(d2.reason).not.toContain('escalation')
    expect(d3.reason).toContain('escalation')
    expect(d3.reason).toContain('denial #3')
    expect(d3.reason).toContain('text-form calls are never executed')
    // 一次放行后计数清零：下一次 deny 不再升级
    expect((await good()).kind).toBe('allow')
    expect((await bad()).reason).not.toContain('escalation')
    rmSync(workdir, { recursive: true, force: true })
  })
})
