import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { handle } from './ipc-trust'
import type { NoteAudioAction, NoteAudioReply, NoteAudioRequest, NoteAudioState } from '@shared/noteAudio'

/** One player in the existing bar renderer, shared by the notes page and voice tools. */
export class NoteAudioPlayer {
  private pending = new Map<string,{resolve:(state:NoteAudioState)=>void;reject:(error:Error)=>void}>()
  constructor(private window:()=>BrowserWindow|null, private audioUrl:(id:string)=>string|null) {}
  register(): void {
    handle('note-audio:control',(_event,action:NoteAudioAction,id?:string,options?:{positionMs?:number;rate?:number})=>this.control(action,id,options))
    handle('note-audio:reply',(event,reply:NoteAudioReply)=>{
      if(event.sender!==this.window()?.webContents || !reply || typeof reply.requestId!=='string')throw Error('Playback owner required')
      const pending=this.pending.get(reply.requestId)
      if(!pending)return
      if(reply.error)pending.reject(new Error(reply.error))
      else if(reply.state)pending.resolve(reply.state)
      else pending.reject(new Error('Invalid playback reply'))
    })
  }
  async control(action:NoteAudioAction,id?:string,options:{positionMs?:number;rate?:number}={}):Promise<NoteAudioState> {
    if(!['play','pause','resume','stop','status','seek','rate'].includes(action))throw Error('Invalid playback action')
    if(options.positionMs!==undefined && (!Number.isFinite(options.positionMs)||options.positionMs<0))throw Error('Invalid playback position')
    if(options.rate!==undefined && (!Number.isFinite(options.rate)||options.rate<0.5||options.rate>3))throw Error('Playback rate must be 0.5-3')
    const url=action==='play' && id ? this.audioUrl(id) : undefined
    if(action==='play' && !url)throw Error('随记没有可播放的录音')
    const win=this.window()
    if(!win || win.isDestroyed())throw Error('录音播放服务尚未就绪')
    const request:NoteAudioRequest={requestId:randomUUID(),action,id,...options,...(url?{url}:{})}
    let timer:ReturnType<typeof setTimeout>|undefined
    try {
      return await new Promise<NoteAudioState>((resolve,reject)=>{
        this.pending.set(request.requestId,{resolve,reject})
        timer=setTimeout(()=>reject(new Error('录音播放没有响应')),8000)
        win.webContents.send('note-audio:command',request)
      })
    }finally{if(timer)clearTimeout(timer);this.pending.delete(request.requestId)}
  }
  dispose():void {for(const request of this.pending.values())request.reject(new Error('Playback closed'));this.pending.clear()}
}
