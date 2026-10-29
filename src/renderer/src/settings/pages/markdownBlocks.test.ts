import { describe, expect, it } from 'vitest'
import {
  continuePrefix,
  editorBlocks,
  insertAt,
  linkInline,
  mergeWithPrevious,
  prefixLines,
  renderedToRaw,
  replaceBlock,
  splitBlockAt,
  splitBlocks,
  wrapInline
} from './markdownBlocks'

const texts = (text: string): string[] => splitBlocks(text).map((block) => block.text)

describe('splitBlocks', () => {
  it('空文本没有块', () => {
    expect(splitBlocks('')).toEqual([])
  })

  it('空行分块，块里不含分隔空行', () => {
    const text = '第一段\n第二行\n\n第二段\n\n\n第三段'
    expect(texts(text)).toEqual(['第一段\n第二行', '第二段', '第三段'])
    const blocks = splitBlocks(text)
    for (const block of blocks) expect(text.slice(block.start, block.end)).toBe(block.text)
    expect(blocks[1].start).toBe(text.indexOf('第二段'))
  })

  it('代码围栏内部的空行不切块，围栏行本身属于块', () => {
    const text = '```ts\nconst a = 1\n\nconst b = 2\n```\n\n后面'
    expect(texts(text)).toEqual(['```ts\nconst a = 1\n\nconst b = 2\n```', '后面'])
  })

  it('围栏未闭合时后面的空行都不切', () => {
    expect(texts('前\n\n```\na\n\nb')).toEqual(['前', '```\na\n\nb'])
  })

  it('行内代码 / 单反引号不会被当成围栏', () => {
    expect(texts('用 `code` 表示\n\n下一段')).toEqual(['用 `code` 表示', '下一段'])
    expect(texts('`a\n\nb` 结束')).toEqual(['`a', 'b` 结束'])
  })

  it('列表（含松列表的夹空行）保持一块', () => {
    const loose = '- 一\n\n- 二\n\n- 三\n\n尾巴'
    expect(texts(loose)).toEqual(['- 一\n\n- 二\n\n- 三', '尾巴'])
    expect(texts('1. 一\n2. 二\n\n下一段')).toEqual(['1. 一\n2. 二', '下一段'])
  })

  it('引用里的空行不把引用切断', () => {
    expect(texts('> 一\n\n> 二\n\n尾巴')).toEqual(['> 一\n\n> 二', '尾巴'])
  })

  it('表格整体一块', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n尾巴'
    expect(texts(table)).toEqual(['| a | b |\n| --- | --- |\n| 1 | 2 |', '尾巴'])
  })

  it('只有空白的文本没有块', () => {
    expect(splitBlocks('\n\n   \n')).toEqual([])
  })
})

describe('editorBlocks', () => {
  it('文末空行补一个空块给光标落脚', () => {
    const blocks = editorBlocks('一段\n\n')
    expect(blocks.map((block) => block.text)).toEqual(['一段', ''])
    expect(blocks[1]).toEqual({ start: 4, end: 4, text: '' })
  })

  it('连续空行只补一个空块', () => {
    const blocks = editorBlocks('一段\n\n\n\n')
    expect(blocks.map((block) => block.text)).toEqual(['一段', ''])
    expect(blocks[1].start).toBe(6)
  })

  it('没有结尾空行就不补空块', () => {
    expect(editorBlocks('一段').map((block) => block.text)).toEqual(['一段'])
    expect(editorBlocks('').map((block) => block.text)).toEqual([''])
  })
})

describe('replaceBlock', () => {
  it('只换目标块，其余文本不动', () => {
    const text = '甲\n\n乙\n\n丙'
    const block = splitBlocks(text)[1]
    expect(replaceBlock(text, block, '乙改')).toBe('甲\n\n乙改\n\n丙')
  })

  it('把空块写成内容（末尾空行的情况）', () => {
    const text = '甲\n\n'
    const last = editorBlocks(text)[1]
    expect(replaceBlock(text, last, '乙')).toBe('甲\n\n乙')
  })
})

describe('continuePrefix', () => {
  it('列表续行与编号递增', () => {
    expect(continuePrefix('- 甲')).toBe('- ')
    expect(continuePrefix('* 甲')).toBe('* ')
    expect(continuePrefix('1. 甲')).toBe('2. ')
    expect(continuePrefix('9) 甲')).toBe('10) ')
    expect(continuePrefix('  - 甲')).toBe('  - ')
    expect(continuePrefix('\t- 甲')).toBe('\t- ')
  })

  it('任务列表续成未勾选、引用续引用、段落没有前缀', () => {
    expect(continuePrefix('- [ ] 甲')).toBe('- [ ] ')
    expect(continuePrefix('- [x] 甲')).toBe('- [ ] ')
    expect(continuePrefix('> 甲')).toBe('> ')
    expect(continuePrefix('普通一段')).toBe('')
    expect(continuePrefix('')).toBe('')
  })

  it('行内代码里的连字符不当标记', () => {
    expect(continuePrefix('`a-b` 甲')).toBe('')
  })
})

describe('splitBlockAt', () => {
  it('段落回车拆成两块（中间插空行）', () => {
    const text = '甲乙'
    const block = splitBlocks(text)[0]
    const edit = splitBlockAt(text, block, 1)
    expect(edit.text).toBe('甲\n\n乙')
    expect(edit.caret).toBe(3)
    expect(splitBlocks(edit.text).map((item) => item.text)).toEqual(['甲', '乙'])
  })

  it('列表回车只换行并续上前缀，仍是一块', () => {
    const text = '- 甲'
    const edit = splitBlockAt(text, splitBlocks(text)[0], text.length)
    expect(edit.text).toBe('- 甲\n- ')
    expect(splitBlocks(edit.text).length).toBe(1)
  })

  it('围栏代码里回车不插入空行', () => {
    const text = '```\ncode\n```'
    const edit = splitBlockAt(text, splitBlocks(text)[0], 7)
    expect(edit.text).toBe('```\ncod\ne\n```')
    expect(edit.caret).toBe(8)
  })
})

describe('mergeWithPrevious', () => {
  it('两个段落直接相连，光标落在接缝', () => {
    const text = '甲\n\n乙'
    const blocks = editorBlocks(text)
    const edit = mergeWithPrevious(text, blocks, 1)
    expect(edit).toEqual({ text: '甲乙', caret: 1 })
  })

  it('结构块合并时保留换行', () => {
    const text = '前言\n\n- 甲'
    const edit = mergeWithPrevious(text, editorBlocks(text), 1)
    expect(edit?.text).toBe('前言\n- 甲')
    expect(edit?.caret).toBe(2)
  })

  it('第一块没有可合并的对象', () => {
    expect(mergeWithPrevious('甲', editorBlocks('甲'), 0)).toBeNull()
  })
})

describe('insertAt / 行内标记', () => {
  it('Tab 与软换行都是插入', () => {
    expect(insertAt('甲乙', 1, '  ')).toEqual({ text: '甲  乙', caret: 3 })
    expect(insertAt('甲乙', 1, '\n')).toEqual({ text: '甲\n乙', caret: 2 })
  })

  it('有选区包住、没选区插一对、再按一次取消', () => {
    expect(wrapInline('甲乙', 0, 1, '**')).toEqual({ text: '**甲**乙', caret: 3 })
    const wrapped = wrapInline('甲乙', 1, 1, '**')
    expect(wrapped.text).toBe('甲**文字**乙')
    expect(wrapped.caret).toBe(5)
    expect(wrapInline('**甲**乙', 2, 3, '**')).toEqual({ text: '甲乙', caret: 1 })
  })

  it('链接把光标放进地址里', () => {
    const edit = linkInline('甲乙', 0, 1)
    expect(edit.text).toBe('[甲](url)乙')
    expect(edit.caret).toBe(4)
  })
})

describe('prefixLines', () => {
  it('无序列表给每一行加前缀，再按一次取消', () => {
    const edit = prefixLines('甲\n乙', 0, 3, 'unordered')
    expect(edit.text).toBe('- 甲\n- 乙')
    expect(prefixLines(edit.text, 0, edit.text.length, 'unordered').text).toBe('甲\n乙')
  })

  it('有序列表按顺序编号', () => {
    expect(prefixLines('甲\n乙\n丙', 0, 5, 'ordered').text).toBe('1. 甲\n2. 乙\n3. 丙')
  })

  it('已有前缀换成另一种标记', () => {
    expect(prefixLines('- 甲\n- 乙', 0, 7, 'ordered').text).toBe('1. 甲\n2. 乙')
  })

  it('只作用光标所在行', () => {
    expect(prefixLines('甲\n乙', 3, 3, 'unordered').text).toBe('甲\n- 乙')
  })
})

describe('renderedToRaw', () => {
  it('跳过加粗标记，落在可见字符上', () => {
    expect(renderedToRaw('**粗** 文本', 0)).toBe(2)
    expect(renderedToRaw('**粗** 文本', 1)).toBe(5)
  })

  it('跳过标题 / 列表 / 引用前缀与链接地址', () => {
    expect(renderedToRaw('## 标题', 0)).toBe(3)
    expect(renderedToRaw('- 甲', 0)).toBe(2)
    expect(renderedToRaw('> 甲', 0)).toBe(2)
    expect(renderedToRaw('[甲](url) 乙', 0)).toBe(1)
    expect(renderedToRaw('[甲](url) 乙', 1)).toBe(8)
  })

  it('超出范围时回到块尾', () => {
    expect(renderedToRaw('甲乙', 99)).toBe(2)
  })
})
