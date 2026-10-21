/**
 * A tiny arithmetic evaluator for the `calculate` tool.
 *
 * Why hand-rolled: `eval`/`new Function` would hand the model an interpreter,
 * and a 3-line `split('+')` hack cannot do precedence, parentheses or `^`. This
 * is a recursive-descent parser over a whitelisted character set — no `eval`,
 * no `Function`, no dependency.
 *
 * Grammar (lowest precedence first):
 *
 *   expression := term (('+' | '-') term)*
 *   term       := power (('*' | '/') power)*
 *   power      := unary ('^' power)?          // right associative
 *   unary      := ('+' | '-') unary | postfix
 *   postfix    := primary ('%')*              // `50%` → 0.5
 *   primary    := number | '(' expression ')'
 *
 * `%` is the percent sign, not modulo: `50% * 200` is `100`, which is what a
 * spoken "百分之五十乘以两百" means.
 */
import { mt } from '@shared/mainI18n'


export interface CalcResult {
  ok: boolean
  expression: string
  value?: number
  error?: string
}

/** Long expressions are a prompt-injection smell, not arithmetic. */
const MAX_LENGTH = 200

/** Everything the parser is allowed to see. Anything else is rejected first. */
const ALLOWED_CHARS = /^[0-9+\-*/%^(). ]+$/

class CalcError extends Error {}

function readExpression(src: string): number {
  let pos = 0

  const skipSpace = (): void => {
    while (pos < src.length && src[pos] === ' ') pos += 1
  }

  const parsePrimary = (): number => {
    skipSpace()
    if (src[pos] === '(') {
      pos += 1
      const inner = parseExpression()
      skipSpace()
      if (src[pos] !== ')') throw new CalcError(mt('括号不匹配'))
      pos += 1
      return inner
    }
    const start = pos
    while (pos < src.length && /[0-9.]/.test(src[pos])) pos += 1
    const literal = src.slice(start, pos)
    if (!literal) throw new CalcError(mt('缺少数字'))
    if (literal.split('.').length > 2) throw new CalcError(mt('小数点重复'))
    if (literal === '.') throw new CalcError(mt('数字格式不正确'))
    return Number(literal)
  }

  const parsePostfix = (): number => {
    let value = parsePrimary()
    for (;;) {
      skipSpace()
      if (src[pos] !== '%') return value
      pos += 1
      value /= 100
    }
  }

  const parseUnary = (): number => {
    skipSpace()
    const ch = src[pos]
    if (ch === '+') {
      pos += 1
      return parseUnary()
    }
    if (ch === '-') {
      pos += 1
      return -parseUnary()
    }
    return parsePostfix()
  }

  const parsePower = (): number => {
    const base = parseUnary()
    skipSpace()
    if (src[pos] !== '^') return base
    pos += 1
    return base ** parsePower()
  }

  const parseTerm = (): number => {
    let value = parsePower()
    for (;;) {
      skipSpace()
      const op = src[pos]
      if (op !== '*' && op !== '/') return value
      pos += 1
      const rhs = parsePower()
      if (op === '/' && rhs === 0) throw new CalcError(mt('除数不能为 0'))
      value = op === '*' ? value * rhs : value / rhs
    }
  }

  const parseExpression = (): number => {
    let value = parseTerm()
    for (;;) {
      skipSpace()
      const op = src[pos]
      if (op !== '+' && op !== '-') return value
      pos += 1
      const rhs = parseTerm()
      value = op === '+' ? value + rhs : value - rhs
    }
  }

  const value = parseExpression()
  skipSpace()
  if (pos !== src.length) throw new CalcError(mt('表达式未结束'))
  return value
}

/**
 * Evaluates a spoken arithmetic expression.
 *
 * Never throws: an invalid expression comes back as `{ok: false, error}`, which
 * is what the model needs in order to answer "我没算出来" instead of a number.
 */
export function evaluateExpression(expression: string): CalcResult {
  const raw = typeof expression === 'string' ? expression : String(expression ?? '')
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  if (!trimmed) return { ok: false, expression: '', error: '表达式为空' }
  if (trimmed.length > MAX_LENGTH) {
    return { ok: false, expression: trimmed.slice(0, MAX_LENGTH), error: mt('表达式超过 {{n}} 个字符', { n: MAX_LENGTH }) }
  }
  if (!ALLOWED_CHARS.test(trimmed)) {
    return { ok: false, expression: trimmed, error: '表达式只允许数字、+ - * / % ^ 和括号' }
  }
  let value: number
  try {
    value = readExpression(trimmed)
  } catch (err) {
    return { ok: false, expression: trimmed, error: err instanceof Error ? err.message : '无法解析' }
  }
  if (!Number.isFinite(value)) {
    return { ok: false, expression: trimmed, error: '计算结果不是有限数' }
  }
  // 0.1 + 0.2 must read as 0.3, not 0.30000000000000004.
  return { ok: true, expression: trimmed, value: Number(value.toPrecision(12)) }
}
