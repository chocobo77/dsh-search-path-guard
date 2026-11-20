import { describe, expect, it } from 'vitest'
import { ZeroResultTracker, zeroResultDenial, DenialEscalation, escalatedReason } from '../src/repeat-guard.ts'

const agent = { session: {} } // any stable object identity
const other = { session: {} }
const ZERO = 'No matches found'
const MATCHED = 'Found 3 matches'

describe('ZeroResultTracker', () => {
  it('counts consecutive zero-result greps per agent+path', () => {
    const t = new ZeroResultTracker()
    expect(t.streakFor(agent, 'log.txt')).toBe(0)
    t.observe(agent, 'log.txt', ZERO)
    t.observe(agent, 'log.txt', ZERO)
    expect(t.streakFor(agent, 'log.txt')).toBe(2)
  })

  it('clears the streak on any result that is not a zero-match', () => {
    const t = new ZeroResultTracker()
    t.observe(agent, 'log.txt', ZERO)
    t.observe(agent, 'log.txt', MATCHED)
    expect(t.streakFor(agent, 'log.txt')).toBe(0)
  })

  it('keeps streaks isolated per agent and per path', () => {
    const t = new ZeroResultTracker()
    t.observe(agent, 'a.log', ZERO)
    expect(t.streakFor(other, 'a.log')).toBe(0)
    expect(t.streakFor(agent, 'b.log')).toBe(0)
  })

  it('ignores an agentless observation (direct tool call)', () => {
    const t = new ZeroResultTracker()
    t.observe(undefined, 'log.txt', ZERO)
    expect(t.streakFor(undefined, 'log.txt')).toBe(0)
  })

  it('bounds per-agent key growth', () => {
    const t = new ZeroResultTracker(4)
    for (let i = 0; i < 10; i++) t.observe(agent, `f${i}.log`, ZERO)
    let live = 0
    for (let i = 0; i < 10; i++) if (t.streakFor(agent, `f${i}.log`) > 0) live += 1
    expect(live).toBeLessThanOrEqual(4)
  })

  it('refreshes recency on update: a target under active search survives eviction', () => {
    const t = new ZeroResultTracker(4)
    for (const p of ['a', 'b', 'c', 'd']) t.observe(agent, p, ZERO)
    t.observe(agent, 'a', ZERO) // streak 2，并移到插入序尾部
    t.observe(agent, 'e', ZERO) // 容量已满：淘汰最旧的 'b'，而不是活跃的 'a'
    expect(t.streakFor(agent, 'a')).toBe(2)
    expect(t.streakFor(agent, 'b')).toBe(0)
    expect(t.streakFor(agent, 'c')).toBe(1)
    expect(t.streakFor(agent, 'e')).toBe(1)
  })

  it('never evicts on a read: checking a streak must not destroy it', () => {
    const t = new ZeroResultTracker(4)
    for (const p of ['a', 'b', 'c', 'd']) t.observe(agent, p, ZERO)
    // 'a' 是插入序最旧的键；读取它自身多次，条目必须原样保留
    for (let i = 0; i < 5; i++) expect(t.streakFor(agent, 'a')).toBe(1)
    expect(t.streakFor(agent, 'd')).toBe(1)
  })
})

describe('zeroResultDenial', () => {
  it('states the streak, forbids pattern-tweaking, and names three exits', () => {
    const m = zeroResultDenial('C:/x/log.txt', 5)
    expect(m).toContain('loop-guard')
    expect(m).toContain('last 5 greps')
    expect(m).toContain('No matches found')
    expect(m).toContain('Read the target range directly')
    expect(m.split('\n')).toHaveLength(1)
  })
})

describe('DenialEscalation', () => {
  it('counts consecutive denials per agent and resets on an allowed call', () => {
    const e = new DenialEscalation()
    expect(e.note(agent)).toBe(1)
    expect(e.note(agent)).toBe(2)
    e.clear(agent)
    expect(e.note(agent)).toBe(1)
  })

  it('is per-agent isolated', () => {
    const e = new DenialEscalation()
    e.note(agent); e.note(agent)
    expect(e.note(other)).toBe(1)
  })

  it('ignores an agentless denial', () => {
    const e = new DenialEscalation()
    expect(e.note(undefined)).toBe(1)
    expect(() => e.clear(undefined)).not.toThrow()
  })
})

describe('escalatedReason', () => {
  it('leaves the reason untouched below the threshold', () => {
    expect(escalatedReason('base', 1)).toBe('base')
    expect(escalatedReason('base', 2)).toBe('base')
  })

  it('appends non-yielding and text-form-call warnings at the threshold', () => {
    const m = escalatedReason('base', 3)
    expect(m.startsWith('base')).toBe(true)
    expect(m).toContain('denial #3 in a row')
    expect(m).toContain('does not yield to retries')
    expect(m).toContain('do NOT write the call as text markup')
    expect(m).toContain('never executed')
  })
})
