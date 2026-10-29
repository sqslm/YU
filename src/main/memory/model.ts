import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, open } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export const MEMORY_MODEL_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781'
export const MEMORY_MODEL_FILES = [
  ['config.json', 716, 'd590a6643f5dcdd0cfb0477e3c291488c16fc2d7'],
  ['tokenizer.json', 439125, 'cdb3043fc938fc918c06e66cf704c2ba58f88747'],
  ['tokenizer_config.json', 367, '3a59388f0fd1bd22dec2ce7902c1be8e1fb84107'],
  ['special_tokens_map.json', 125, 'a8b3208c2884c4efb86e49300fdd3dc877220cdf'],
  ['onnx/model_quantized.onnx', 24010842, '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc']
] as const
export async function validModelFile(root: string, item: readonly [string, number, string]): Promise<boolean> {
  try {
    const data = await readFile(join(root, item[0]))
    if (data.length !== item[1]) return false
    const hash = item[2].length === 64 ? createHash('sha256').update(data) : createHash('sha1').update(`blob ${data.length}\0`).update(data)
    return hash.digest('hex') === item[2]
  } catch { return false }
}
export async function memoryModelReady(root: string): Promise<boolean> {
  for (const file of MEMORY_MODEL_FILES) if (!await validModelFile(root, file)) return false
  return true
}
export async function downloadMemoryModel(root: string, signal: AbortSignal, progress: (percent: number) => void): Promise<void> {
  const total = MEMORY_MODEL_FILES.reduce((n, file) => n + file[1], 0); let received = 0
  for (const file of MEMORY_MODEL_FILES) {
    signal.throwIfAborted()
    if (await validModelFile(root, file)) { received += file[1]; progress(received / total * 100); continue }
    const target = join(root, file[0]), part = target + '.part'
    await mkdir(dirname(target), { recursive: true })
    const response = await fetch(`https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/${MEMORY_MODEL_REVISION}/${file[0]}`, { signal, credentials: 'omit' })
    if (!response.ok || !response.body) throw Error(`记忆模型下载失败：HTTP ${response.status}`)
    const handle = await open(part, 'w'); let bytes = 0
    try {
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted(); bytes += chunk.length
          if (bytes > file[1]) throw Error('记忆模型文件大小不符')
          await handle.write(chunk); progress((received + bytes) / total * 100)
        }
      } finally { await handle.close() }
    } catch (error) { await rm(part, { force: true }); throw error }
    if (!await validModelFile(root, [file[0] + '.part', file[1], file[2]])) {
      await rm(part, { force: true }); throw Error('记忆模型校验失败')
    }
    await rename(part, target); received += bytes
  }
}
