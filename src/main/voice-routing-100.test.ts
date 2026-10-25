import { expect, it } from 'vitest'
import original from './fixtures/voice-routing-100.json'
import recorded from './fixtures/voice-routing-100-rc12.json'
import { directVoiceIntent, parseVoiceIntent } from './voice-intent'
import { WindowsTools } from './tools/windows'
import { personalCommand } from './tools/personal'

const windows = new WindowsTools({ folders: { downloads: 'C:\\test', desktop: 'C:\\test', documents: 'C:\\test' },
  native: async () => { throw Error('routing must not execute native actions') },
  openPath: async () => { throw Error('routing must not open paths') }, openUrl: async () => { throw Error('routing must not open URLs') } })

// Original inputs + reviewed labels; historical provider responses are frozen
// transport fixtures, NOT a claim about today's provider or physical ASR accuracy.
it.each(original.cases)('$id original routing regression', row => {
  const fixture = recorded.cases.find(item => item.id === row.id)!
  expect(fixture.utterance).toBe(row.utterance)
  const direct = directVoiceIntent(row.utterance, true, text => personalCommand(text) ?? windows.command(text))
  const decision = direct ?? parseVoiceIntent(JSON.stringify(fixture.actual_route), row.utterance)
  expect(decision.kind).toBe(fixture.expected_route)
})
