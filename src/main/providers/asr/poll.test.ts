import { describe, expect, it } from 'vitest'
import { POLL_BACKOFF_MS, POLL_MAX_DELAY_MS, pollDelays, pollForResult, pollTimeoutError } from './poll'

// ---------------------------------------------------------------------------
// The whole point of this file: cloud job APIs used to sleep a fixed interval
// *before* their first status check. On a 2-4 s dictation that check already has
// the answer, so the sleep was pure added latency. These assertions pin the
// sequence so a future edit cannot quietly put the wait back in front.
// ---------------------------------------------------------------------------

describe('pollDelays', () => {
  it('checks immediately, then backs off 200 / 300 / 450 / 675 / 1000 / 1500', () => {
    const sequence = [0, 1, 2, 3, 4, 5, 6, 7, 20].map(pollDelays)
    expect(sequence).toEqual([0, 200, 300, 450, 675, 1000, 1500, 1500, 1500])
  })

  it('caps at the previous fixed cadence, so a long job is no busier than before', () => {
    expect(POLL_MAX_DELAY_MS).toBe(1_500)
    expect(POLL_BACKOFF_MS.at(-1)).toBe(1_500)
    for (let attempt = 1; attempt <= 200; attempt++) {
      expect(pollDelays(attempt)).toBeLessThanOrEqual(POLL_MAX_DELAY_MS)
    }
  })

  it('treats a junk attempt number as the first check', () => {
    expect(pollDelays(-3)).toBe(0)
    expect(pollDelays(0.4)).toBe(0)
    expect(pollDelays(1.9)).toBe(200)
    expect(pollDelays(Number.NaN)).toBe(0)
  })
})

/** Records the sleeps instead of taking them, so a 120 s budget costs no wall clock. */
function recorder(): { sleep: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = []
  return {
    waited,
    sleep: async (ms) => {
      waited.push(ms)
    }
  }
}

describe('pollForResult', () => {
  it('returns a value that was already there without sleeping once', async () => {
    const { sleep, waited } = recorder()
    const logs: string[] = []
    let attempts = 0
    const text = await pollForResult({
      attempt: async () => {
        attempts += 1
        return '你好'
      },
      sleep,
      log: (line) => logs.push(line),
      label: 'AssemblyAI 转写',
      onTimeout: () => new Error('unreachable')
    })
    expect(text).toBe('你好')
    // One GET, zero wait: the common case for a short clip.
    expect(attempts).toBe(1)
    expect(waited).toEqual([])
    expect(logs).toEqual(['[perf] asr-poll attempts=1 wait=0ms what=AssemblyAI 转写'])
  })

  it('waits the backoff sequence between a job that is still running', async () => {
    const { sleep, waited } = recorder()
    const states: Array<string | null> = [null, null, null, 'ok']
    const text = await pollForResult({
      attempt: async () => states.shift() ?? null,
      sleep,
      onTimeout: () => new Error('unreachable')
    })
    expect(text).toBe('ok')
    // Immediately, then 200, 300, 450 — never the old flat 1.5 s.
    expect(waited).toEqual([200, 300, 450])
  })

  it('reports the attempts and the total wait it actually spent', async () => {
    const { sleep } = recorder()
    const logs: string[] = []
    const states: Array<string | null> = [null, null, null, null, null, 'ok']
    await pollForResult({
      attempt: async () => states.shift() ?? null,
      sleep,
      log: (line) => logs.push(line),
      onTimeout: () => new Error('unreachable')
    })
    // Six looks: the immediate one, then 200 + 300 + 450 + 675 + 1000 ms of wait.
    expect(logs).toEqual(['[perf] asr-poll attempts=6 wait=2625ms'])
    expect(logs[0]).not.toMatch(/key|Bearer|http/i)
  })

  it('throws the caller-built timeout once the budget is gone, and still logs', async () => {
    const { sleep } = recorder()
    const logs: string[] = []
    await expect(
      pollForResult<string>({
        attempt: async () => null,
        sleep,
        budgetMs: 0,
        log: (line) => logs.push(line),
        label: 'Gladia 转写',
        onTimeout: () => pollTimeoutError('Gladia 转写', 0)
      })
    ).rejects.toThrow(/Gladia 转写/)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^\[perf\] asr-poll attempts=1 wait=0ms what=Gladia 转写$/)
  })

  it('never treats an empty transcript as "still running"', async () => {
    const { sleep, waited } = recorder()
    // The vendor said it is done and heard nothing: that is an answer, not a retry.
    expect(await pollForResult({ attempt: async () => '', sleep, onTimeout: () => new Error('x') })).toBe('')
    expect(waited).toEqual([])
  })

  it('propagates a cancelled sleep instead of finishing the poll', async () => {
    await expect(
      pollForResult({
        attempt: async () => null,
        sleep: async () => {
          throw new Error('转写已取消')
        },
        onTimeout: () => new Error('unreachable')
      })
    ).rejects.toThrow('转写已取消')
  })
})
