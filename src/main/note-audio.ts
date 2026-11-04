import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { handle } from './ipc-trust'
import type { NoteAudioAction, NoteAudioEvent, NoteAudioReply, NoteAudioRequest, NoteAudioState } from '@shared/noteAudio'

/**
 * Where the pill can be reached.
 *
 * `peek` must never create the window: a status query, a pause or a late reply
 * has no business resurrecting a window that was just retired. `ensure` may
 * create it, but only resolves once that window's renderer is listening for
 * `note-audio:command` — sending earlier loses the command outright.
 */
export interface NoteAudioHost {
  peek: () => BrowserWindow | null
  ensure: () => Promise<BrowserWindow | null>
}

const IDLE: NoteAudioState = { id: null, state: 'idle', positionMs: 0, durationMs: 0, rate: 1 }
const COMMAND_TIMEOUT_MS = 8000
/** Actions the renderer can only answer once it is actually listening. */
const NEEDS_WINDOW = new Set<NoteAudioAction>(['play', 'resume', 'seek', 'rate'])
const ACTIONS = new Set<NoteAudioAction>(['play', 'pause', 'resume', 'stop', 'status', 'seek', 'rate'])

/** One player in the existing bar renderer, shared by the notes page and voice tools. */
export class NoteAudioPlayer {
  private pending = new Map<string,{resolve:(state:NoteAudioState)=>void;reject:(error:Error)=>void}>()
  private playId: string | null = null
  constructor(private host:NoteAudioHost, private audioUrl:(id:string)=>string|null, private onState?:(state:NoteAudioState)=>void, private log?:(line:string)=>void) {}

  /** The `play` command the pill currently owes; events for any other one are stale. */
  get activePlayId(): string | null { return this.playId }

  register(): void {
    handle('note-audio:control',(_event,action:NoteAudioAction,id?:string,options?:{positionMs?:number;rate?:number})=>this.control(action,id,options))
    handle('note-audio:reply',(event,reply:NoteAudioReply)=>{
      if(!reply || typeof reply.requestId!=='string')return
      // Replies come from whichever window holds playback at that moment, and
      // only `peek` may answer that: asking the sink here used to recreate the
      // pill whenever a late reply arrived after retirement.
      const owner=this.host.peek()
      if(!owner || owner.isDestroyed() || event.sender!==owner.webContents){this.log?.('[note-audio] ignored a reply from a window that does not own playback');return}
      // The page drives playback too (play/pause buttons), so the owner has to
      // hear every reply: the window may not be retired while audio is running.
      if(reply.state)this.onState?.(reply.state)
      const pending=this.pending.get(reply.requestId)
      if(!pending)return
      if(reply.error)pending.reject(new Error(reply.error))
      else if(reply.state)pending.resolve(reply.state)
      else pending.reject(new Error('Invalid playback reply'))
    })
  }

  /**
   * Events the renderer reports on its own (real `playing`/`paused`/`ended`/
   * `error`/`stop`). Only the play that is currently owned may move the busy
   * flag, so a late `ended` from a replaced playback cannot release the new one.
   */
  acceptEvent(event:NoteAudioEvent|null|undefined): NoteAudioEvent|null {
    if(!event || typeof event.requestId!=='string')return null
    if(!this.playId || event.requestId!==this.playId)return null
    return event
  }

  async control(action:NoteAudioAction,id?:string,options:{positionMs?:number;rate?:number}={}):Promise<NoteAudioState> {
    if(!ACTIONS.has(action))throw Error('Invalid playback action')
    if(options.positionMs!==undefined && (!Number.isFinite(options.positionMs)||options.positionMs<0))throw Error('Invalid playback position')
    if(options.rate!==undefined && (!Number.isFinite(options.rate)||options.rate<0.5||options.rate>3))throw Error('Playback rate must be 0.5-3')
    const url=action==='play' && id ? this.audioUrl(id) : undefined
    if(action==='play' && !url)throw Error('随记没有可播放的录音')
    // Queries and stops answer from whatever window exists: they must not be the
    // reason a pill is created, so a retired window simply reads as idle.
    if(!NEEDS_WINDOW.has(action)){
      const win=this.host.peek()
      if(!win || win.isDestroyed())return {...IDLE}
    }
    const requestId=randomUUID()
    if(action==='play')this.playId=requestId
    const request:NoteAudioRequest={requestId,action,id,...options,...(url?{url}:{})}
    return await new Promise<NoteAudioState>((resolve,reject)=>{
      let settled=false
      const finish=(error?:Error,state?:NoteAudioState):void=>{
        if(settled)return
        settled=true
        clearTimeout(timer)
        this.pending.delete(requestId)
        if(error)reject(error)
        else resolve(state as NoteAudioState)
      }
      // One budget covers creation, readiness and the reply. Waiting for the
      // window is part of the command, so it may not be given extra time.
      const timer=setTimeout(()=>finish(new Error('录音播放没有响应')),COMMAND_TIMEOUT_MS)
      this.pending.set(requestId,{
        resolve:state=>finish(undefined,state),
        reject:error=>finish(error)
      })
      void this.deliver(requestId,request,NEEDS_WINDOW.has(action)).then(
        ()=>undefined,
        error=>finish(error instanceof Error?error:new Error(String(error)))
      )
    })
  }

  /** Route one command to a window that can hear it, or fail instead of sending into the void. */
  private async deliver(requestId:string,request:NoteAudioRequest,needsWindow:boolean):Promise<void>{
    const win=needsWindow ? await this.host.ensure() : this.host.peek()
    if(!win || win.isDestroyed())throw Error('录音播放服务尚未就绪')
    // The command was cancelled (timeout, dispose, window gone) while the pill was
    // still starting up: drop it instead of playing something nobody asked for.
    if(!this.pending.has(requestId))return
    win.webContents.send('note-audio:command',request)
  }

  dispose():void {for(const request of this.pending.values())request.reject(new Error('Playback closed'));this.pending.clear()}
}
