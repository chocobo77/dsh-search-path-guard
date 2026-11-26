import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

/** Minimal cordis-like context: captures every registered listener. */
function makeContext(workdir: string) {
  const state = {
    pre: undefined as ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined,
    result: undefined as ((exec: unknown, result: unknown) => unknown) | undefined,
    sessionEvent: undefined as ((session: unknown, event: unknown) => unknown) | undefined,
    post: undefined as ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined,
    requestError: undefined as ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined,
    agentError: undefined as ((payload: unknown) => unknown) | undefined,
    preStep: undefined as ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined,
    systemPromptRegister: undefined as ((scope: unknown) => void) | undefined,
  }
  const ctx = {
    on: (event: string, handler: (...args: never[]) => unknown) => {
      if (event === 'tools/pre-execute') state.pre = handler as never
      if (event === 'tools/result') state.result = handler as never
      if (event === 'session/event') state.sessionEvent = handler as never
      if (event === 'tools/post-execute') state.post = handler as never
      if (event === 'agent/request-error') state.requestError = handler as never
      if (event === 'agent/error') state.agentError = handler as never
      if (event === 'agent/pre-step') state.preStep = handler as never
    },
    inject: (services: string[], register: (scope: unknown) => void) => {
      if (services.includes('systemPrompt')) state.systemPromptRegister = register
    },
    workingDirectory: { ensure: () => Promise.resolve(workdir) },
  }
  return { ctx: ctx as never, state }
}

function execOf(name: string, args: unknown, agent?: unknown) {
  return { name, arguments: args, agent: agent ?? { session: {} }, signal: new AbortController().signal }
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
    expect(state.sessionEvent).toBeUndefined()
    expect(state.post).toBeUndefined()
    expect(state.requestError).toBeUndefined()
    expect(state.agentError).toBeUndefined()
    expect(state.preStep).toBeUndefined()
    expect(state.systemPromptRegister).toBeUndefined()
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

/** `n` Han characters ≈ n estimated tokens — the incident's payload shape. */
const han = (n: number): string => '漢'.repeat(n)

/** Pull the model-facing text out of a guard-pushed UserMessage. */
function messageText(message: unknown): string {
  const blocks = (message as { content?: { text?: string }[] }).content
  return Array.isArray(blocks) ? (blocks[0]?.text ?? '') : ''
}

describe('apply — payload guard (MALFORMED_RESPONSE defense)', () => {
  it('denies oversized arguments on path-less tools, ahead of the path gate', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-hard-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx) // default hard limit 8000 tokens
    const next = () => Promise.resolve({ kind: 'allow' })
    const run = async (name: string, args: unknown) =>
      (await state.pre?.(execOf(name, args), next)) as { kind: string; reason?: string }
    const denied = await run('write', { file_path: 'notes.md', content: han(8000) })
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('payload-guard:')
    expect(denied.reason).toContain('MALFORMED_RESPONSE')
    expect((denied.reason ?? '').split('\n')).toHaveLength(1)
    // `bash` has no path gate at all: the payload guard runs before it.
    expect((await run('bash', { command: `cat <<EOF\n${han(9000)}\nEOF` })).kind).toBe('deny')
    // Comfortably below the limit it passes (path gate included, for `write`).
    expect((await run('write', { file_path: 'notes.md', content: han(7000) })).kind).toBe('allow')
    rmSync(workdir, { recursive: true, force: true })
  })

  it('tightens the hard limit under context pressure (proven by usage + window)', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-pressure-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx)
    const next = () => Promise.resolve({ kind: 'allow' })
    const session = { id: 's-pressure', requestContext: () => ({ contextWindow: 10_000 }) }
    const agent = { session }
    const run = async () =>
      (await state.pre?.(execOf('write', { file_path: 'a.md', content: han(5000) }, agent), next)) as { kind: string; reason?: string }
    // No usage observed yet: no scaling, the call passes.
    expect((await run()).kind).toBe('allow')
    // 8000/10000 fill ≥ 0.75 → effective limit 8000×0.5 = 4000 → same call denied.
    state.sessionEvent?.(session, { type: 'assistant/message', data: { usage: { totalTokens: 8000 } } })
    const denied = await run()
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('limit 4000')
    rmSync(workdir, { recursive: true, force: true })
  })

  it('treats pressureHardFactor: 0 as "no tightening", like every other 0-off key', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-pressure-off-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx, { pressureHardFactor: 0 })
    const next = () => Promise.resolve({ kind: 'allow' })
    const session = { id: 's-pressure-off', requestContext: () => ({ contextWindow: 10_000 }) }
    const agent = { session }
    state.sessionEvent?.(session, { type: 'assistant/message', data: { usage: { totalTokens: 8000 } } })
    // 80% fill arms the scaling path, but a 0 factor must mean OFF — never a
    // hard limit of 1 token denying every argument-carrying call.
    const passed = (await state.pre?.(execOf('write', { file_path: 'a.md', content: han(5000) }, agent), next)) as { kind: string }
    expect(passed.kind).toBe('allow')
    rmSync(workdir, { recursive: true, force: true })
  })

  it('attaches a split-reminder to the next request after a successful large call, max two per turn', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-soft-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx)
    const next = () => Promise.resolve({ kind: 'allow' })
    const postNext = () => Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] })
    const reminderOf = (d: unknown) => (d as { additionalContexts?: unknown[] }).additionalContexts
    const session = { id: 's-soft' }
    const agent = { session }
    const bigCall = () => execOf('write', { file_path: 'b.md', content: han(3000) }, agent)
    const ok = { isError: false, content: [{ type: 'text', text: 'Wrote 9000 bytes' }] }
    state.sessionEvent?.(session, { type: 'turn/start', data: { turn: 1 } })
    const d1 = await state.post?.(bigCall(), ok, postNext)
    expect(reminderOf(d1)).toHaveLength(1)
    expect(messageText(reminderOf(d1)?.[0])).toContain('payload-guard note')
    expect(reminderOf(await state.post?.(bigCall(), ok, postNext))).toHaveLength(1)
    // Budget spent for this turn: silent from the third big call on.
    expect(reminderOf(await state.post?.(bigCall(), ok, postNext))).toBeUndefined()
    // A new turn renews the budget.
    state.sessionEvent?.(session, { type: 'turn/start', data: { turn: 2 } })
    expect(reminderOf(await state.post?.(bigCall(), ok, postNext))).toHaveLength(1)
    // Failed calls never nag; small args are not worth nagging about.
    expect(reminderOf(await state.post?.(bigCall(), { isError: true, content: [], error: { message: 'disk full' } }, postNext))).toBeUndefined()
    expect(reminderOf(await state.post?.(execOf('write', { file_path: 'b.md', content: 'tiny' }, agent), ok, postNext))).toBeUndefined()
    // The accept decision itself (content) passes through untouched.
    const kept = (await state.post?.(execOf('write', { file_path: 'b.md', content: 'tiny' }, agent), ok, postNext)) as { kind: string; content?: { text?: string }[] }
    expect(kept.kind).toBe('accept')
    expect(kept.content?.[0]?.text).toBe('ok')
    void next
    rmSync(workdir, { recursive: true, force: true })
  })

  it('retries MALFORMED_RESPONSE once with inbox context, then hands back; completed turns reset the budget', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-malformed-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx, { malformedRetry: 1 })
    const next = () => Promise.resolve({ kind: 'allow' })
    const appended: [string, unknown][] = []
    const session = { id: 's-mal' }
    const agent = { session, inbox: { append: (target: string, message: unknown) => appended.push([target, message]) } }
    const payload = (turn: number) => ({
      agent,
      turn,
      step: 2,
      provider: 'p',
      failure: { code: 'MALFORMED_RESPONSE', message: 'Unterminated string in JSON at position 772' },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    })
    expect(await state.requestError?.(payload(7), next)).toEqual({ kind: 'retry' })
    expect(appended).toHaveLength(1)
    expect(appended[0][0]).toBe('next-step')
    expect(messageText(appended[0][1])).toContain('MALFORMED_RESPONSE')
    // Budget spent: the next MALFORMED in the same episode hands back to the host.
    expect(await state.requestError?.(payload(7), next)).toEqual({ kind: 'allow' })
    // The turn already got its nudge: agent/error never stacks a second copy.
    const injected: unknown[] = []
    const agent2 = { session, inject: (m: unknown) => injected.push(m) }
    state.agentError?.({ agent: agent2, turn: 7, step: 2, error: { code: 'MALFORMED_RESPONSE' } })
    expect(injected).toHaveLength(0)
    // A completed turn is visible progress: the retry budget is restored.
    state.sessionEvent?.(session, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
    expect(await state.requestError?.(payload(8), next)).toEqual({ kind: 'retry' })
    rmSync(workdir, { recursive: true, force: true })
  })

  it('nudges via inject once per turn when retry is disabled (malformedRetry: 0)', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-nudge-only-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx, { malformedRetry: 0 })
    const next = () => Promise.resolve({ kind: 'allow' })
    const injected: unknown[] = []
    const agent = { session: { id: 's-nudge' }, inject: (m: unknown) => injected.push(m) }
    // Retry channel fully off: the failure hands straight back…
    expect(await state.requestError?.({ agent, turn: 3, failure: { code: 'MALFORMED_RESPONSE' } }, next)).toEqual({ kind: 'allow' })
    expect(injected).toHaveLength(0)
    // …and agent/error is the guidance channel: once per turn.
    state.agentError?.({ agent, turn: 3, error: { code: 'MALFORMED_RESPONSE' } })
    expect(injected).toHaveLength(1)
    expect(messageText(injected[0])).toContain('did NOT land')
    state.agentError?.({ agent, turn: 3, error: { code: 'MALFORMED_RESPONSE' } })
    expect(injected).toHaveLength(1)
    // Other failure codes are not the payload guard's business.
    state.agentError?.({ agent, turn: 4, error: { code: 'RATE_LIMIT' } })
    expect(injected).toHaveLength(1)
    // A new episode nudges again.
    state.agentError?.({ agent, turn: 4, error: { code: 'MALFORMED_RESPONSE' } })
    expect(injected).toHaveLength(2)
    rmSync(workdir, { recursive: true, force: true })
  })

  it('a payload-guard denial on grep leaves the zero-result streak untouched', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-payload-streak-'))
    const { ctx, state } = makeContext(workdir)
    apply(ctx, { zeroResultBlock: 2 })
    const next = () => Promise.resolve({ kind: 'allow' })
    const agent = { session: {} }
    const abs = join(workdir, 'app.log')
    writeFileSync(abs, '')
    const grep = () => ({ name: 'grep', arguments: { pattern: 'needle', path: abs }, agent, signal: new AbortController().signal })
    await state.pre?.(grep(), next)
    await state.result?.(grep(), { content: [{ type: 'text', text: 'No matches found' }] })
    // A payload-guard denial (Error: payload-guard: …) is not a search
    // outcome: observing it as "nonzero" would CLEAR the real streak.
    const huge = { name: 'grep', arguments: { pattern: 'x', path: abs, filter: han(8000) }, agent, signal: new AbortController().signal }
    const denied = (await state.pre?.(huge, next)) as { kind: string; reason?: string }
    expect(denied.kind).toBe('deny')
    await state.result?.(huge, { content: [{ type: 'text', text: `Error: ${denied.reason ?? ''}` }] })
    // Streak survived at 1: the next no-match grep locks the target.
    await state.pre?.(grep(), next)
    await state.result?.(grep(), { content: [{ type: 'text', text: 'No matches found' }] })
    expect(((await state.pre?.(grep(), next)) as { kind: string }).kind).toBe('deny')
    rmSync(workdir, { recursive: true, force: true })
  })

  it('warns and defaults on malformed payload-guard numeric config', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'search-path-guard-payload-config-'))
    const { ctx, state } = makeContext(workdir)
    const warnings: string[] = []
    ;(ctx as { logger?: unknown }).logger = { warn: (msg: string) => warnings.push(msg) }
    apply(ctx, { argsHardTokens: '8000' as never, pressureRatio: Number.POSITIVE_INFINITY })
    expect(warnings.some(w => w.includes('argsHardTokens'))).toBe(true)
    expect(warnings.some(w => w.includes('pressureRatio'))).toBe(true)
    const next = () => Promise.resolve({ kind: 'allow' })
    // Defaults stay in force: 8000 CJK tokens deny, 7000 pass.
    const denied = (await state.pre?.(execOf('write', { file_path: 'x.md', content: han(8000) }), next)) as { kind: string }
    expect(denied.kind).toBe('deny')
    const passed = (await state.pre?.(execOf('write', { file_path: 'x.md', content: han(7000) }), next)) as { kind: string }
    expect(passed.kind).toBe('allow')
    rmSync(workdir, { recursive: true, force: true })
  })
})

describe('apply — markup guard (pre-step)', () => {
  const LEAK = 'Loading the skill now.\n<function=skill>\n<parameter=command>official-plugins</parameter>\n</function>'
  /** Feed one assistant/message session event (the frozen-message shape the session emits). */
  const assistantMessage = (sessionEvent: NonNullable<ReturnType<typeof makeContext>['state']['sessionEvent']>, session: object, turn: number, text: string) =>
    sessionEvent(session, {
      type: 'assistant/message',
      data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: { totalTokens: 1000 } },
    })
  /** One pre-step call: the base decision admits the claimed messages plus runtime context. */
  const preStep = (preStepHandler: NonNullable<ReturnType<typeof makeContext>['state']['preStep']>, agent: object, turn: number, admitted: string[]) =>
    preStepHandler(
      { agent, messages: admitted.map(text => ({ role: 'user', content: [{ type: 'text', text }] })), turn, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [...admitted.map(text => ({ role: 'user', content: [{ type: 'text', text }] })), { role: 'user', content: [{ type: 'text', text: '<runtime-context>' }] }] }),
    ) as Promise<{ kind: string; messages: Array<{ content: Array<{ text?: string }> }> }>

  it('injects one correction after a leaky same-turn assistant message', async () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx)
    const session = {}
    const agent = { session }
    assistantMessage(state.sessionEvent!, session, 1, LEAK)
    const decision = await preStep(state.preStep!, agent, 1, ['the user ask'])
    expect(decision.kind).toBe('enter')
    // base admitted messages + runtime context + OUR correction appended last
    expect(decision.messages).toHaveLength(3)
    const correction = decision.messages[2]
    expect(correction.content[0]?.text).toContain('never ran')
    expect(correction.content[0]?.text).toContain('"skill"')
    expect(correction.content[0]?.text).toContain('await tools.skill({ … })')
    expect(correction.content[0]?.text).not.toContain('#1') // first hit: no escalation
  })

  it('stays silent when the leak is from a finished turn', async () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx)
    const session = {}
    const agent = { session }
    assistantMessage(state.sessionEvent!, session, 1, LEAK)
    const decision = await preStep(state.preStep!, agent, 2, ['next turn ask'])
    expect(decision.messages).toHaveLength(2) // admitted + runtime context only
  })

  it('stays silent on a clean assistant message and resets the escalation', async () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx)
    const session = {}
    const agent = { session }
    assistantMessage(state.sessionEvent!, session, 1, LEAK)
    const first = await preStep(state.preStep!, agent, 1, ['ask'])
    expect(first.messages).toHaveLength(3)
    assistantMessage(state.sessionEvent!, session, 1, 'All done — the file is at docs/x.md.')
    const clean = await preStep(state.preStep!, agent, 1, ['ask'])
    expect(clean.messages).toHaveLength(2)
    // streak was cleared: the NEXT leak escalates from 1, not 2
    assistantMessage(state.sessionEvent!, session, 1, LEAK)
    const second = await preStep(state.preStep!, agent, 1, ['ask'])
    expect(second.messages).toHaveLength(3)
    expect(second.messages[2]?.content[0]?.text).not.toContain('#')
  })

  it('escalates the second consecutive leak with the repeat wording', async () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx)
    const session = {}
    const agent = { session }
    assistantMessage(state.sessionEvent!, session, 1, LEAK)
    await preStep(state.preStep!, agent, 1, ['ask'])
    assistantMessage(state.sessionEvent!, session, 1, LEAK)
    const second = await preStep(state.preStep!, agent, 1, ['ask'])
    expect(second.messages).toHaveLength(3)
    expect(second.messages[2]?.content[0]?.text).toContain('markup-leak #2')
    expect(second.messages[2]?.content[0]?.text).toContain('will stay dead')
  })

  it('spends the per-turn budget then falls silent (default 2)', async () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx)
    const session = {}
    const agent = { session }
    for (const round of [1, 2, 3]) {
      assistantMessage(state.sessionEvent!, session, 1, LEAK)
      const decision = await preStep(state.preStep!, agent, 1, ['ask'])
      expect(decision.messages).toHaveLength(round <= 2 ? 3 : 2)
    }
  })

  it('markupBlock: 0 disables detection entirely; markupMinChars applies', async () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx, { markupBlock: 0 })
    const session = {}
    const agent = { session }
    assistantMessage(state.sessionEvent!, session, 1, LEAK)
    const decision = await preStep(state.preStep!, agent, 1, ['ask'])
    expect(decision.messages).toHaveLength(2)

    const tight = makeContext(tmpdir())
    apply(tight.ctx, { markupMinChars: 500 })
    assistantMessage(tight.state.sessionEvent!, session, 1, LEAK)
    const small = await preStep(tight.state.preStep!, agent, 1, ['ask'])
    expect(small.messages).toHaveLength(2)
  })

  it('rejects decisions pass through without spending the budget', async () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx)
    const session = {}
    const agent = { session }
    assistantMessage(state.sessionEvent!, session, 1, LEAK)
    await state.preStep?.(
      { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' }),
    )
    // budget untouched: the next leaky step still gets its correction
    const decision = await preStep(state.preStep!, agent, 1, ['ask'])
    expect(decision.messages).toHaveLength(3)
  })
})

describe('apply — PTC call convention (system-prompt context)', () => {
  it('registers a per-step context entry through the systemPrompt service', async () => {
    const { ctx, state } = makeContext(tmpdir())
    apply(ctx)
    expect(state.systemPromptRegister).toBeTypeOf('function')
    const registered: Array<{ name: string; order: number; text: (input: { agent?: { session?: unknown } }) => string }> = []
    state.systemPromptRegister?.({
      systemPrompt: { context: (entry: { name: string; order: number; text: (input: { agent?: { session?: unknown } }) => string }) => { registered.push(entry); return () => {} } },
    })
    expect(registered).toHaveLength(1)
    const entry = registered[0]!
    expect(entry.name).toBe('search-path-guard:ptc-call-convention')
    expect(entry.order).toBe(118)
    // per-agent gating like sandbox-policy: no session → no contribution
    expect(entry.text({})).toBe('')
    expect(entry.text({ agent: { session: {} } })).toContain('[ptc-call-convention]')
    expect(entry.text({ agent: { session: {} } })).toContain('ONLY tool you can call directly')
  })
})
