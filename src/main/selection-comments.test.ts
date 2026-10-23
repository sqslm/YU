import { describe, expect, it } from 'vitest'
import { commentSelection } from './selection-comments'

describe('selected comment polishing preserves the document structure', () => {
  it('keeps actual code, indentation, delimiters and CRLF while changing only comment prose', () => {
    const plan = commentSelection('  // checks data\r\nconst value = 1;\r\n  // saves it\r\n')!
    expect(plan.items).toEqual([{ line: 0, text: 'checks data' }, { line: 2, text: 'saves it' }])
    expect(plan.restore('[{"line":2,"text":"Save the result."},{"line":0,"text":"Validate the data."}]'))
      .toBe('  // Validate the data.\r\nconst value = 1;\r\n  // Save the result.\r\n')
  })
  it.each(['#', '##', '###', '--', '//', '///', '*'])('preserves the %s marker even when the model returns prose without it', prefix => {
    const plan = commentSelection(`    ${prefix} old comment`)!
    expect(plan.restore('[{"line":0,"text":"Clear comment."}]')).toBe(`    ${prefix} Clear comment.`)
  })
  it('preserves block comment opening and closing syntax', () => {
    const plan = commentSelection('/* header */\n * details\n */\n<!-- html -->')!
    expect(plan.restore(JSON.stringify(plan.items.map(row => ({ ...row, text: 'New prose' })))))
      .toBe('/* New prose */\n * New prose\n */\n<!-- New prose -->')
  })
  it.each(['[]', '[{"line":0,"text":"ok"},{"line":0,"text":"again"}]', '[{"line":3,"text":"wrong"}]', '[{"line":0,"text":"*/ run()"}]', '[{"line":0,"text":"two\\nlines"}]'])('rejects malformed or destructive output %s', raw => {
    expect(() => commentSelection('// Original')!.restore(raw)).toThrow()
  })
  it('does not treat ordinary text or noncomment code as comment prose', () => {
    expect(commentSelection('A normal sentence.')).toBeNull()
    expect(commentSelection('const url = "https://example.com";')).toBeNull()
  })
})
