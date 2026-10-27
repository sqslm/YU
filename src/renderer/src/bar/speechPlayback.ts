import type { SpeechPlaybackRequest, SpeechPlaybackReply } from '@shared/speech'

export function createSpeechPlayer(reply: (value: SpeechPlaybackReply) => void, audio: HTMLAudioElement = new Audio()): { run: (request: SpeechPlaybackRequest) => Promise<void>; dispose: () => void } {
  let id: string | null = null, url: string | null = null
  const stop = (): void => {
    id = null
    audio.pause(); audio.removeAttribute('src'); audio.load()
    if (url) URL.revokeObjectURL(url)
    url = null
  }
  audio.onended = () => { const ended = id; stop(); if (ended) reply({ id: ended, event: 'ended' }) }
  audio.onerror = () => { const failed = id; stop(); if (failed) reply({ id: failed, event: 'error', error: 'Cannot decode speech audio' }) }
  return {
    async run(request) {
      try {
        if (request.action === 'play') {
          stop()
          if (!request.audio) throw Error('Missing speech audio')
          id = request.id
          url = URL.createObjectURL(new Blob([new Uint8Array(request.audio.bytes)], { type: request.audio.mime }))
          audio.src = url
          audio.volume = (request.volume ?? 100) / 100
          audio.playbackRate = request.speed ?? 1
          audio.load()
          await audio.play()
          if (id === request.id) reply({ id: request.id, event: 'started' })
        } else if (request.action === 'stop') {
          if (request.id === id) stop()
        } else {
          if (!id) throw Error('No active speech')
          if (request.action === 'pause') audio.pause()
          else await audio.play()
          reply({ id: request.id, event: 'control' })
        }
      } catch (error) {
        if (request.action === 'play' && id !== request.id) return
        if (request.action === 'play') stop()
        reply({ id: request.id, event: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    },
    dispose() { audio.onended = null; audio.onerror = null; stop() }
  }
}
