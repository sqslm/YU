import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { generateFromAudio } from './gemini'

afterEach(() => vi.restoreAllMocks())
describe('Gemini audio wire contract', () => {
  it('sends inline WAV with header authentication and excludes thought text from the result', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'internal reasoning', thought: true }, { text: '识别结果' }] } }] })))
    const cfg = { ...mergeSettings({}).multimodal, baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'models/gemini-3.8-flash', apiKey: 'test-key' }
    expect(await generateFromAudio(cfg, { wav: new Uint8Array([1, 2, 3]), prompt: 'transcribe' })).toBe('识别结果')
    expect(transport.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
    const init = transport.mock.calls[0][1]!
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'test-key' })
    expect(JSON.parse(String(init.body))).toMatchObject({ systemInstruction: { parts: [{ text: 'transcribe' }] }, contents: [{ parts: [{ inline_data: { mime_type: 'audio/wav', data: 'AQID' } }, { text: expect.any(String) }] }] })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
  it('allows a local compatible gateway without a key and preserves cancellation', async () => {
    const controller = new AbortController()
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })))
    const cfg = { ...mergeSettings({}).multimodal, baseUrl: 'http://127.0.0.1:8080', model: 'local', apiKey: '' }
    await generateFromAudio(cfg, { wav: new Uint8Array([1]), prompt: '', signal: controller.signal })
    const signal = transport.mock.calls[0][1]!.signal!
    controller.abort(); expect(signal.aborted).toBe(true)
  })
  it('rejects an oversized inline request before uploading it', async () => {
    const transport = vi.spyOn(globalThis, 'fetch')
    const cfg = { ...mergeSettings({}).multimodal, baseUrl: 'http://127.0.0.1:8080', model: 'local', apiKey: '' }
    await expect(generateFromAudio(cfg, { wav: new Uint8Array(16 * 1024 * 1024), prompt: '' })).rejects.toThrow('20 MB')
    expect(transport).not.toHaveBeenCalled()
  })
})
