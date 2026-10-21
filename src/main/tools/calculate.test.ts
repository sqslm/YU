import { describe, expect, it } from 'vitest'
import { evaluateExpression } from './calculate'

/**
 * The calculator is the one tool whose output the model is most tempted to
 * "improve" on, so the cases below pin the exact numbers as well as the refusal
 * behaviour: anything that is not arithmetic must come back as `ok: false`
 * rather than as a value.
 */
describe('evaluateExpression', () => {
  it('multiplies spoken numbers', () => {
    expect(evaluateExpression('125*36')).toMatchObject({ ok: true, value: 4500 })
  })

  it('honours parentheses', () => {
    expect(evaluateExpression('(2+3)*4')).toMatchObject({ ok: true, value: 20 })
  })

  it('reads % as a percentage, not modulo', () => {
    expect(evaluateExpression('50%*200')).toMatchObject({ ok: true, value: 100 })
  })

  it('applies * before +', () => {
    expect(evaluateExpression('2+3*4')).toMatchObject({ ok: true, value: 14 })
  })

  it('makes ^ right associative', () => {
    expect(evaluateExpression('2^3^2')).toMatchObject({ ok: true, value: 512 })
  })

  it('handles unary minus and decimals', () => {
    expect(evaluateExpression('-5+10')).toMatchObject({ ok: true, value: 5 })
    expect(evaluateExpression('1.5*4')).toMatchObject({ ok: true, value: 6 })
  })

  it('does not leak float noise', () => {
    expect(evaluateExpression('0.1+0.2')).toMatchObject({ ok: true, value: 0.3 })
  })

  it('accepts spaces and returns the normalised expression', () => {
    expect(evaluateExpression('  12 *  3 ')).toMatchObject({
      ok: true,
      value: 36,
      expression: '12 * 3'
    })
  })

  it('refuses anything that is not arithmetic', () => {
    const result = evaluateExpression('2+alert(1)')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('只允许')
    expect(result.value).toBeUndefined()
  })

  it('refuses identifiers outright', () => {
    expect(evaluateExpression('globalThis').ok).toBe(false)
    expect(evaluateExpression('process.exit(0)').ok).toBe(false)
  })

  it('reports division by zero instead of Infinity', () => {
    const result = evaluateExpression('1/0')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('除数')
  })

  it('rejects an empty expression', () => {
    expect(evaluateExpression('   ').ok).toBe(false)
  })

  it('rejects unbalanced parentheses and dangling operators', () => {
    expect(evaluateExpression('(1+2').ok).toBe(false)
    expect(evaluateExpression('1+').ok).toBe(false)
  })

  it('caps the length so a prompt blob is not arithmetic', () => {
    const long = '1+'.repeat(150) + '1'
    const result = evaluateExpression(long)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('200')
  })
})
