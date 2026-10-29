import { expect, it } from 'vitest'
import sharp from 'sharp'
import { chatAttachmentReference, prepareChatAttachments, validateChatUploads } from './chat-attachments'
import { chatRequestBody } from './providers/llm'
const signal = new AbortController().signal
it('extracts bounded document text without creating temporary files', async () => {
  const files = await prepareChatAttachments([{ name: '项目.md', bytes: Buffer.from('项目是本地语音助手。') }], signal)
  expect(files[0]).toMatchObject({ kind: 'document', text: '项目是本地语音助手。', truncated: false })
  expect(chatAttachmentReference(files)?.content).toContain('项目是本地语音助手')
})
it('decodes actual image bytes, caps resolution, strips metadata and preserves a thumbnail', async () => {
  const bytes = await sharp({ create: { width: 2500, height: 100, channels: 3, background: '#336699' } }).png().toBuffer()
  const [file] = await prepareChatAttachments([{ name: '图.png', bytes }], signal)
  const normalized = Buffer.from(file.image!.split(',')[1], 'base64')
  expect(await sharp(normalized).metadata()).toMatchObject({ width: 2048, format: 'jpeg' })
  expect(file.thumbnail).toMatch(/^data:image\/jpeg;base64,/)
  const reference = chatAttachmentReference([file])!
  const body = chatRequestBody({ model: 'vision', temperature: 0, effort: 'off' }, { messages: [reference] })
  expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: reference.content }, { type: 'image_url', image_url: { url: file.image } }] }])
  expect(reference.images).toEqual([file.image]) // HTTP conversion does not mutate retry/history data.
})
it('rejects unsupported, empty, corrupt, oversized and excessive uploads before model calls', async () => {
  expect(() => validateChatUploads([{ name: 'run.exe', bytes: Buffer.from('exe') }])).toThrow('格式')
  expect(() => validateChatUploads([{ name: 'empty.txt', bytes: new Uint8Array() }])).toThrow('非空')
  expect(() => validateChatUploads([{ name: 'big.txt', bytes: new Uint8Array(10 * 1024 * 1024 + 1) }])).toThrow('10 MiB')
  expect(() => validateChatUploads(Array.from({ length: 6 }, () => ({ name: 'x.txt', bytes: Buffer.from('a') })))).toThrow('5')
  expect(() => validateChatUploads(Array.from({ length: 3 }, () => ({ name: 'x.txt', bytes: new Uint8Array(9 * 1024 * 1024) })))).toThrow('25 MiB')
  await expect(prepareChatAttachments([{ name: 'fake.png', bytes: Buffer.from('not an image') }], signal)).rejects.toThrow()
  await expect(prepareChatAttachments([{ name: 'a.txt', bytes: Buffer.from('a') }], AbortSignal.abort())).rejects.toThrow()
})
it('bounds references across follow-ups and flags clipped documents', () => {
  const reference = chatAttachmentReference(Array.from({ length: 7 }, (_, i) => ({ id: String(i), name: `${i}.txt`, size: 30000, kind: 'document', text: '中'.repeat(30000), truncated: false })))!
  expect(reference.content.length).toBeLessThan(50000)
  expect(reference.content).not.toContain('0.txt')
  expect(reference.content).toContain('"truncated":true')
})
