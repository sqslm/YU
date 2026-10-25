export type NoteAudioAction = 'play'|'pause'|'resume'|'stop'|'status'|'seek'|'rate'
export interface NoteAudioState { id: string|null; state: 'idle'|'playing'|'paused'|'ended'; positionMs: number; durationMs: number; rate: number }
export interface NoteAudioRequest { requestId: string; action: NoteAudioAction; id?: string; url?: string; positionMs?: number; rate?: number }
export interface NoteAudioReply { requestId: string; state?: NoteAudioState; error?: string }
