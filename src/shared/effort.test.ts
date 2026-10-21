import { describe, expect, it } from 'vitest'
import type { ModelInfo } from './types'
import {
  EFFORT_UNAVAILABLE_HINT,
  defaultEffort,
  effortOptions,
  effortUnavailable
} from './effort'

const thinking: ModelInfo = {
  id: 'cn:deepseek-v4.1-flash',
  canDisableThinking: true,
  reasoningSupportedEfforts: ['low', 'high', 'max'],
  reasoningDefaultEffort: 'high'
}

const alwaysThinking: ModelInfo = {
  id: 'mock-always-thinking',
  onlyReasoning: true,
  canDisableThinking: false,
  reasoningSupportedEfforts: ['low', 'high']
}

const plain: ModelInfo = { id: 'mock-no-thinking' }

describe('effortOptions', () => {
  it('puts off first when the gateway can disable thinking', () => {
    expect(effortOptions(thinking)).toEqual(['off', 'low', 'high', 'max'])
    expect(effortOptions({ id: 'x', canDisableThinking: true })).toEqual(['off'])
  })

  it('omits off when thinking cannot be disabled', () => {
    expect(effortOptions(alwaysThinking)).toEqual(['low', 'high'])
  })

  it('returns nothing for a model without reasoning support', () => {
    expect(effortOptions(plain)).toEqual([])
    expect(effortOptions(null)).toEqual([])
    expect(effortOptions(undefined)).toEqual([])
  })

  it('de-duplicates while keeping the gateway order', () => {
    expect(
      effortOptions({ id: 'x', reasoningSupportedEfforts: ['high', ' low ', 'high', 'low', 'max'] })
    ).toEqual(['high', 'low', 'max'])
  })
})

describe('defaultEffort', () => {
  it('prefers the declared default', () => {
    expect(defaultEffort(thinking)).toBe('high')
  })

  it('falls back to the first supported effort', () => {
    expect(defaultEffort({ id: 'x', reasoningSupportedEfforts: ['max', 'low'] })).toBe('max')
  })

  it('is empty when the model declares nothing', () => {
    expect(defaultEffort(plain)).toBe('')
    expect(defaultEffort(null)).toBe('')
  })
})

describe('effortUnavailable', () => {
  it('is null only when thinking can be disabled', () => {
    expect(effortUnavailable(thinking)).toBeNull()
    expect(effortUnavailable(alwaysThinking)).toBe(EFFORT_UNAVAILABLE_HINT)
    expect(effortUnavailable(plain)).toBe(EFFORT_UNAVAILABLE_HINT)
  })
})
