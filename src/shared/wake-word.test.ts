import { expect, it } from 'vitest'
import { learnWakeTraining, normalizeWakeTraining } from './wake-word'
const sample = { text: '你好啊雨', phones: 'nihaʊay', targetPhones: 'nihaʊɑy', confidence: 0.25 }
it('learns consistent complete pronunciation variants and exposes the calibrated threshold', () => {
  const learned = learnWakeTraining('你好阿语', [sample, { ...sample }, { ...sample }], 0.8)
  expect(learned.training.variants).toEqual([{ text: sample.text, phones: sample.phones }])
  expect(learned.training.sampleCount).toBe(3); expect(learned.confidence).toBe(0.2)
  expect(normalizeWakeTraining(learned.training, '你好阿语')).toEqual(learned.training)
  expect(normalizeWakeTraining(learned.training, '你好胡小杨')).toBeUndefined()
})
it('refuses silence, unrelated speech and greeting-only clips rather than learning a false trigger', () => {
  for (const patch of [{ text: '你好' }, { phones: 'unrelated' }, { confidence: 0 }, { text: '', phones: '' }]) {
    expect(() => learnWakeTraining('你好阿语', Array.from({ length: 3 }, () => ({ ...sample, ...patch })), 0.3)).toThrow()
  }
})
