import { describe, expect, it } from 'vitest'
import { allowsIpc } from './ipc-trust'

const mainFrame = { url: 'file:///out/renderer/settings.html' }
const iframe = { url: 'https://example.com/embed' }

const sender = (id: number) => ({ id, mainFrame })
const ids = (...values: number[]) => new Set(values)

describe('allowsIpc', () => {
  it('refuses a renderer that was never registered', () => {
    expect(allowsIpc({ sender: sender(7), senderFrame: mainFrame }, ids())).toBe(false)
  })

  it('accepts a registered window calling from its top frame', () => {
    expect(allowsIpc({ sender: sender(7), senderFrame: mainFrame }, ids(7))).toBe(true)
  })

  it('refuses an iframe inside a registered window', () => {
    // The window is ours, the frame is not: this is the case the guard exists for.
    expect(allowsIpc({ sender: sender(7), senderFrame: iframe }, ids(7))).toBe(false)
  })

  it('accepts a registered window whose frame is already gone', () => {
    // Electron reports `null` while a window tears down; the call is legitimate
    // and there is no sub-frame involved, so it must not be dropped.
    expect(allowsIpc({ sender: sender(7), senderFrame: null }, ids(7))).toBe(true)
  })

  it('does not confuse two windows that differ only by an unrelated frame', () => {
    const other = { id: 8, mainFrame: { url: 'file:///out/renderer/bar.html' } }
    expect(allowsIpc({ sender: other, senderFrame: mainFrame }, ids(7))).toBe(false)
    expect(allowsIpc({ sender: other, senderFrame: other.mainFrame }, ids(7, 8))).toBe(true)
  })

  it('refuses everything once the register is empty', () => {
    expect(allowsIpc({ sender: sender(7), senderFrame: mainFrame }, ids())).toBe(false)
    expect(allowsIpc({ sender: sender(7), senderFrame: null }, ids())).toBe(false)
  })
})
