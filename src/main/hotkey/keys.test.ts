import { describe, expect, it } from 'vitest'
import { VK, physicalVk, isModifierVk, tokenToVk, vkToToken } from './keys'

describe('tokenToVk', () => {
  it('maps modifiers by side, not just role', () => {
    expect(tokenToVk('RightAlt')).toBe(0xa5)
    expect(tokenToVk('LeftAlt')).toBe(0xa4)
    expect(tokenToVk('RightShift')).toBe(0xa1)
    expect(tokenToVk('LeftCtrl')).toBe(0xa2)
  })

  it('maps letters, digits and function keys', () => {
    expect(tokenToVk('A')).toBe(0x41)
    expect(tokenToVk('V')).toBe(0x56)
    expect(tokenToVk('1')).toBe(0x31)
    expect(tokenToVk('F1')).toBe(0x70)
    expect(tokenToVk('F12')).toBe(0x7b)
  })

  it('throws on an unknown token so a broken settings file fails at startup', () => {
    expect(() => tokenToVk('HyperKey')).toThrow(/unknown key token/)
    expect(() => tokenToVk('')).toThrow(/unknown key token/)
  })
})

describe('isModifierVk', () => {
  it('covers exactly the modifier range', () => {
    expect(isModifierVk(VK.LeftShift)).toBe(true)
    expect(isModifierVk(VK.RightAlt)).toBe(true)
    expect(isModifierVk(VK.Space)).toBe(false)
    expect(isModifierVk(0x41)).toBe(false)
  })
})

describe('vkToToken', () => {
  it('round-trips every named key', () => {
    for (const token of ['RightAlt', 'RightShift', 'LeftCtrl', 'Space', 'F5']) {
      expect(vkToToken(tokenToVk(token))).toBe(token)
    }
  })

  it('returns undefined for unmapped keys', () => {
    expect(vkToToken(0x01)).toBeUndefined()
  })
})

it('identifies right Shift from generic VK_SHIFT and the physical scan code', () => {
  expect(physicalVk(0x10, 0x36, 0)).toBe(VK.RightShift)
  expect(physicalVk(0x10, 0x2a, 0)).toBe(VK.LeftShift)
  expect(physicalVk(0x11, 0x1d, 1)).toBe(VK.RightCtrl)
  expect(physicalVk(0x12, 0x38, 0)).toBe(VK.LeftAlt)
  expect(physicalVk(VK.RightShift, 0x36, 0)).toBe(VK.RightShift)
})
