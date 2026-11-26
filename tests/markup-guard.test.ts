import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MARKUP_MIN_CHARS,
  LeakStreak,
  MarkupTurnBudget,
  PTC_CALL_CONVENTION,
  detectMarkupLeak,
  markupNudge,
  withoutCodeFormatting,
} from '../src/markup-guard.ts'

const agent = { session: {} } // any stable object identity
const other = { session: {} }

// 现场形态：session f2415117 的五次泄漏都是"叙述 + 完整标记体"的混合消息，
// 这里按同一形状构造（叙述首句 + 真实标记 + 完整参数体）。
const LEAK_FUNCTION = [
  'Let me load the plugin skill first.',
  '<function=skill>',
  '<parameter=command>official-plugins</parameter>',
  '</function>',
].join('\n')

const LEAK_INVOKE = [
  "Now I'll read the installation doc.",
  '<invoke name="read">',
  '<parameter name="file_path">dsh-purge/docs/INSTALLATION.md</parameter>',
  '<parameter name="offset">1</parameter>',
  '</invoke>',
].join('\n')

const LEAK_JSON = [
  'Track the remaining work.',
  '<tool_call>',
  '{"name": "todo_write", "arguments": {"todos": [{"id": "1", "content": "install bundle", "status": "pending"}]}}',
  '</tool_call>',
].join('\n')

describe('withoutCodeFormatting', () => {
  // 宿主语义（text-tool-call.ts:60-76，逐字复用）：闭合正则把 {3,} 量化在
  // 末尾反引号上，实际要求 ≥5 个反引号才闭合——普通 ``` 围栏一旦打开就吞到
  // 消息尾。这是宿主"宁可少 nudge"的保守取舍（吞多 = 误报少，代价是围栏后
  // 的真泄漏漏检），测试钉住这一行为以防"顺手修正"引入新的偏差。
  it('swallows the message after a fence opens (host semantics: err toward fewer nudges)', () => {
    const text = 'before\n```xml\n<function=read>\n<parameter=x>1</parameter>\n</function>\n```\nafter'
    expect(withoutCodeFormatting(text)).toBe('before')
  })

  it('drops inline code spans but keeps the surrounding line', () => {
    const text = 'use `<tool_call>` syntax carefully, not `<function=x>` though'
    expect(withoutCodeFormatting(text)).toBe('use   syntax carefully, not   though')
  })

  it('an unclosed fence is a sample, not a setup: the rest stays swallowed', () => {
    const text = 'intro\n```\n<invoke name="read">\nnever closed, everything gone'
    expect(withoutCodeFormatting(text)).toBe('intro')
  })
})

describe('detectMarkupLeak', () => {
  it('fires on the measured hybrid shapes and extracts the tool name', () => {
    expect(detectMarkupLeak(LEAK_FUNCTION)).toEqual({ name: 'skill' })
    expect(detectMarkupLeak(LEAK_INVOKE)).toEqual({ name: 'read' })
    expect(detectMarkupLeak(LEAK_JSON)).toEqual({ name: 'todo_write' })
  })

  it('fires without a name when the markup names no tool', () => {
    const text = 'attempting the call\n<tool_call>\n<parameter=command>something long enough to pass the minimum length rule</parameter>\n</tool_call>'
    expect(detectMarkupLeak(text)).toEqual({})
  })

  it('does NOT exempt hybrid text — detection is text-only by design', () => {
    // 与宿主 :86 门控相反：调用是否存在不影响文本判定（接线层才拿得到块，
    // 纯函数只看文本；混合块正是目标）。
    expect(detectMarkupLeak(LEAK_FUNCTION)).toBeDefined()
  })

  it('stays silent on inline-code narration of the syntax', () => {
    const text = 'The bug was that the model wrote `use <tool_call> syntax` instead of emitting a call.'
    expect(detectMarkupLeak(text)).toBeUndefined()
  })

  it('stays silent on markup inside a fenced diagnostic report', () => {
    const text = '## findings\n\n```\n<function=skill>\n<parameter=command>official-plugins</parameter>\n</function>\n```\n\ntaken from another session'
    expect(detectMarkupLeak(text)).toBeUndefined()
  })

  it('stays silent on a body-bearing fragment shorter than the minimum', () => {
    // 长度按标记起点起算（text.slice(MARKUP_START 起)）：截断的 JSON 调用
    // 带 "name": body（过 MARKUP_BODY）但标记段 38 字符 <40，默认不触发；
    // 更小阈值命中。纯开头残片（如 '<function=rea'）连 body 都没有，任何
    // 阈值都不触发。
    const text = 'cut mid-call <tool_call>{"name":"r","arguments":1}'
    expect(detectMarkupLeak(text)).toBeUndefined()
    expect(detectMarkupLeak(text, 5)).toEqual({ name: 'r' })
    expect(detectMarkupLeak('truncated leak <function=rea', 5)).toBeUndefined()
  })

  it('stays silent on clean prose', () => {
    expect(detectMarkupLeak('The install doc says run `dsh plugin add bundle.tgz` then restart.')).toBeUndefined()
  })

  it('respects a caller-supplied minimum at least as strict as the default', () => {
    expect(detectMarkupLeak(LEAK_FUNCTION, DEFAULT_MARKUP_MIN_CHARS)).toEqual({ name: 'skill' })
    expect(detectMarkupLeak(LEAK_FUNCTION, 100_000)).toBeUndefined()
  })
})

describe('markupNudge', () => {
  it('names the never-ran fact and the run_code remedy for a named call', () => {
    const m = markupNudge({ name: 'skill' }, 1)
    expect(m).toContain('never ran')
    expect(m).toContain('"skill" is not directly callable')
    expect(m).toContain('await tools.skill({ … })')
    expect(m).not.toContain('#1')
    expect(m.split('\n')).toHaveLength(3)
  })

  it('keeps a generic remedy when the markup named no tool', () => {
    const m = markupNudge({}, 1)
    expect(m).toContain('Re-issue that intent from inside a run_code program')
  })

  it('escalates from the second hit with the repetition count and its cause', () => {
    const m = markupNudge({ name: 'read' }, 2)
    expect(m).toContain('markup-leak #2')
    expect(m).toContain('will stay dead')
    expect(m).toContain('for use INSIDE run_code')
  })
})

describe('PTC_CALL_CONVENTION', () => {
  it('states the run_code-only rule and the dead-markup fact', () => {
    expect(PTC_CALL_CONVENTION).toContain('[ptc-call-convention]')
    expect(PTC_CALL_CONVENTION).toContain('ONLY tool you can call directly')
    expect(PTC_CALL_CONVENTION).toContain('await tools.name(args)')
    expect(PTC_CALL_CONVENTION).toContain('never executed')
    expect(PTC_CALL_CONVENTION.split('\n')).toHaveLength(1)
  })
})

describe('MarkupTurnBudget', () => {
  it('counts per agent per turn and resets on a new turn', () => {
    const b = new MarkupTurnBudget()
    expect(b.count(agent, 3)).toBe(0)
    expect(b.note(agent, 3)).toBe(1)
    expect(b.count(agent, 3)).toBe(1)
    expect(b.note(agent, 3)).toBe(2)
    expect(b.count(agent, 4)).toBe(0) // 新 turn 预算刷新
    expect(b.note(agent, 4)).toBe(1)
    expect(b.count(other, 3)).toBe(0) // agent 隔离
  })

  it('treats an agentless key as a fresh zero budget', () => {
    const b = new MarkupTurnBudget()
    expect(b.note(undefined, 1)).toBe(1)
    expect(b.count(undefined, 1)).toBe(0)
  })
})

describe('LeakStreak', () => {
  it('counts consecutive corrected leaks and clears on clean output', () => {
    const s = new LeakStreak()
    expect(s.note(agent)).toBe(1)
    expect(s.note(agent)).toBe(2)
    s.clear(agent)
    expect(s.note(agent)).toBe(1)
  })

  it('isolates per agent and tolerates an agentless key', () => {
    const s = new LeakStreak()
    s.note(agent)
    s.note(agent)
    expect(s.note(other)).toBe(1)
    expect(s.note(undefined)).toBe(1)
    expect(() => s.clear(undefined)).not.toThrow()
  })
})
