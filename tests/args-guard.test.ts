import { describe, expect, it } from 'vitest'
import {
  MALFORMED_CODE,
  MalformedStreak,
  NudgedTurns,
  argsHardDenial,
  argsSoftReminder,
  estimateArgsTokens,
  estimateTokens,
  malformedNudge,
} from '../src/args-guard.ts'

/** `n` Han characters: 1 estimated token each — the incident's payload shape. */
const han = (n: number): string => '漢'.repeat(n)

describe('estimateTokens', () => {
  it('charges Han at ~1 token and other text at ~1/4', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens(han(10))).toBe(10)
    expect(estimateTokens('a'.repeat(20))).toBe(5)
    // 10 Han + 8 ASCII: 10 + ceil(8/4) — the Latin-biased estimate would call
    // this 4-5 tokens; the incident's escaped-CJK CHANGELOG is exactly this.
    expect(estimateTokens(`${han(10)}abcdefgh`)).toBe(12)
  })

  it('counts the CJK extension blocks, not just the base Han range', () => {
    // 0x3400-0x4DBF extension, 0x3040-0x30ff kana, 0xAC00-0xD7AF hangul.
    expect(estimateTokens('\u3400')).toBe(1)
    expect(estimateTokens('\u3042')).toBe(1)
    expect(estimateTokens('\uAC00')).toBe(1)
    expect(estimateTokens('\u4E00')).toBe(1)
  })
})

describe('estimateArgsTokens', () => {
  it('sums string values across nested objects and arrays', () => {
    const args = { file_path: 'x.md', new_string: han(100), tags: [han(10), han(20)] }
    // 100 + 10 + 20 Han, plus 'x.md' at ceil(4/4) = 1.
    expect(estimateArgsTokens(args, 1_000)).toBe(131)
  })

  it('ignores non-string leaves and stops once the cap is crossed', () => {
    const args = { a: han(500), b: 42, c: true, d: null }
    // Crossing the cap early: the walk stops charging after the total passes
    // cap, keeping pre-execute O(cap) on every call.
    const crossed = estimateArgsTokens(args, 100)
    expect(crossed).toBeGreaterThan(100)
    expect(crossed).toBeLessThanOrEqual(500)
  })

  it('survives absurd nesting without charging below the depth cap', () => {
    let deep: unknown = han(50)
    for (let i = 0; i < 100; i++) deep = { nested: deep }
    // MAX_DEPTH (64) truncates the walk: the payload at the bottom is not
    // counted rather than risking a stack overflow on hostile arguments.
    expect(estimateArgsTokens(deep, 10_000)).toBe(0)
  })

  it('is safe on non-object arguments', () => {
    expect(estimateArgsTokens(undefined, 100)).toBe(0)
    expect(estimateArgsTokens('plain', 100)).toBe(2)
    expect(estimateArgsTokens(7, 100)).toBe(0)
  })
})

describe('denial and nudge wording', () => {
  it('the hard denial is one line and carries the numbers plus the remedy', () => {
    const reason = argsHardDenial('edit', 9000, 8000)
    expect(reason.split('\n')).toHaveLength(1)
    expect(reason).toContain('payload-guard: edit arguments are ≈9000 tokens (limit 8000)')
    expect(reason).toContain('split the work into sequential edit calls')
    expect(reason).toContain('MALFORMED_RESPONSE')
  })

  it('none of the new wording carries the zero-result marker', () => {
    // This text re-enters the model context as an `Error:` result and the
    // plugin's own tools/result observer would otherwise misread it as a
    // search outcome (streak inflation / false unlock).
    const texts = [argsHardDenial('grep', 9000, 8000), argsSoftReminder('write', 3000, 2500), malformedNudge(2500)]
    for (const text of texts) {
      expect(text).not.toContain('No matches found')
    }
  })

  it('the soft reminder and the malformed nudge name their trigger and bound', () => {
    const soft = argsSoftReminder('write', 4000, 2500)
    expect(soft.split('\n')).toHaveLength(1)
    expect(soft).toContain('payload-guard note')
    expect(soft).toContain('≈4000 tokens')
    const nudge = malformedNudge(2500)
    expect(nudge).toContain('MALFORMED_RESPONSE')
    expect(nudge).toContain('under ~2500 tokens')
    // Self-guarding: the same nudge reaches the next step even when the
    // retry SUCCEEDED, so it must not command a redo unconditionally.
    expect(nudge).toContain('did NOT land')
    expect(nudge).toContain('If it did land, ignore this')
  })

  it('MALFORMED_CODE matches the host failure code exactly', () => {
    expect(MALFORMED_CODE).toBe('MALFORMED_RESPONSE')
  })
})

describe('MalformedStreak', () => {
  it('counts per session and resets on clear', () => {
    const s = new MalformedStreak(4)
    expect(s.streakFor('a')).toBe(0)
    expect(s.note('a')).toBe(1)
    expect(s.note('a')).toBe(2)
    expect(s.note('b')).toBe(1)
    s.clear('a')
    expect(s.streakFor('a')).toBe(0)
    expect(s.streakFor('b')).toBe(1)
  })

  it('is LRU-bounded: fresh notes evict the least-recently-noted session', () => {
    const s = new MalformedStreak(2)
    s.note('a')
    s.note('b')
    s.note('a') // refreshes 'a' → 'b' is now the oldest
    s.note('c') // evicts 'b', not 'a'
    expect(s.streakFor('b')).toBe(0)
    expect(s.streakFor('a')).toBe(2)
    expect(s.streakFor('c')).toBe(1)
  })
})

describe('NudgedTurns', () => {
  it('claims each (session, turn) exactly once', () => {
    const n = new NudgedTurns(4)
    expect(n.claim('s', 7)).toBe(true)
    expect(n.claim('s', 7)).toBe(false) // the request-error nudge already covered this turn
    expect(n.claim('s', 8)).toBe(true) // a new episode nudges again
    expect(n.claim('t', 7)).toBe(true) // per-session isolation
  })

  it('is LRU-bounded per session slot', () => {
    const n = new NudgedTurns(2)
    n.claim('a', 1)
    n.claim('b', 1)
    n.claim('a', 2) // refreshes 'a'
    n.claim('c', 1) // evicts 'b'
    expect(n.claim('b', 1)).toBe(true) // 'b' forgotten → re-claimable
  })
})
