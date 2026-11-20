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

describe('apply — loop-guard streak hygiene', () => {
  it('counts ONE streak across path spellings, and quotes this call\'s spelling', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-streakkey-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx, { zeroResultBlock: 4 })
    const next = () => Promise.resolve({ kind: 'allow' })
    const agent = { session: {} }
    const abs = join(workdir, 'app.log')
    writeFileSync(abs, '')
    // Raw-string streak keys let each spelling carry its own counter: varying
    // the spelling dodged the guard and diluted a real streak.
    const spellings = ['app.log', './app.log', abs, abs.replace(/\\/gu, '/')]
    for (const path of spellings) {
      const exec = { name: 'grep', arguments: { pattern: 'x', path }, agent, signal: new AbortController().signal }
      expect(((await state.pre?.(exec, next)) as { kind: string }).kind).toBe('allow')
      await state.result?.(exec, { content: [{ type: 'text', text: 'No matches found' }] })
    }
    const denied = (await state.pre?.(
      { name: 'grep', arguments: { pattern: 'x', path: './app.log' }, agent, signal: new AbortController().signal },
      next,
    )) as { kind: string; reason?: string }
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('last 4 greps')
    expect(denied.reason).toContain('"./app.log"')
    if (process.platform === 'win32') {
      // The filesystem ignores case, so the key must too: same file, same streak.
      const upper = (await state.pre?.(
        { name: 'grep', arguments: { pattern: 'x', path: abs.toUpperCase() }, agent, signal: new AbortController().signal },
        next,
      )) as { kind: string }
      expect(upper.kind).toBe('deny')
    }
    rmSync(workdir, { recursive: true, force: true })
  })

  it('unlocks a locked target when an edit/write lands on it; a failed write leaves it locked', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-unlock-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx, { zeroResultBlock: 2 })
    const next = () => Promise.resolve({ kind: 'allow' })
    const agent = { session: {} }
    const abs = join(workdir, 'app.log')
    writeFileSync(abs, 'nothing here\n')
    const grep = { name: 'grep', arguments: { pattern: 'needle', path: abs }, agent, signal: new AbortController().signal }
    const noMatch = { content: [{ type: 'text', text: 'No matches found' }] }
    await state.pre?.(grep, next); await state.result?.(grep, noMatch)
    await state.pre?.(grep, next); await state.result?.(grep, noMatch)
    expect(((await state.pre?.(grep, next)) as { kind: string }).kind).toBe('deny')
    // A FAILED edit is not progress — the file did not change, still locked.
    await state.result?.(
      { name: 'edit', arguments: { file_path: 'app.log', old_string: 'a', new_string: 'b' }, agent, signal: new AbortController().signal },
      { content: [{ type: 'text', text: 'Error: edit failed: old_string was not found' }] },
    )
    expect(((await state.pre?.(grep, next)) as { kind: string }).kind).toBe('deny')
    // A SUCCESSFUL write (another spelling) can have put the needle there: unlock.
    await state.result?.(
      { name: 'write', arguments: { file_path: './app.log', content: 'needle is here now' }, agent, signal: new AbortController().signal },
      { content: [{ type: 'text', text: 'Wrote 19 bytes' }] },
    )
    expect(((await state.pre?.(grep, next)) as { kind: string }).kind).toBe('allow')
    rmSync(workdir, { recursive: true, force: true })
  })
})

describe('apply — config hygiene', () => {
  it('falls back to the defaults and warns when a numeric config is not a number', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-config-'))
    const { ctx, state } = makeContext(workdir)
    const warnings: string[] = []
    ;(ctx as { logger?: unknown }).logger = { warn: (msg: string) => warnings.push(msg) }
    // Realistic config typos: a quoted number in YAML/JSON, an unbounded
    // maxEditBytes. `Math.max(1, NaN)` is NaN (`streak >= NaN` never fires)
    // and `size > Infinity` is never true: both would silently disable a guard.
    apply(ctx, { zeroResultBlock: '3' as never, maxEditBytes: Number.POSITIVE_INFINITY })
    expect(warnings.some(w => w.includes('zeroResultBlock'))).toBe(true)
    expect(warnings.some(w => w.includes('maxEditBytes'))).toBe(true)
    const next = () => Promise.resolve({ kind: 'allow' })
    const agent = { session: {} }
    const abs = join(workdir, 'app.log')
    writeFileSync(abs, '')
    const grep = { name: 'grep', arguments: { pattern: 'x', path: abs }, agent, signal: new AbortController().signal }
    const noMatch = { content: [{ type: 'text', text: 'No matches found' }] }
    // fell back to the DEFAULT 5, not the typo'd '3': the 4th call is still
    // allowed, and the deny only arrives at the 6th (streak 5)
    for (let i = 0; i < 4; i++) {
      expect(((await state.pre?.(grep, next)) as { kind: string }).kind).toBe('allow')
      await state.result?.(grep, noMatch)
    }
    expect(((await state.pre?.(grep, next)) as { kind: string }).kind).toBe('allow')
    await state.result?.(grep, noMatch)
    expect(((await state.pre?.(grep, next)) as { kind: string }).kind).toBe('deny')
    rmSync(workdir, { recursive: true, force: true })
  })
})
