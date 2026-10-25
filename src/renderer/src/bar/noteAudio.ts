import type { NoteAudioRequest, NoteAudioState } from '@shared/noteAudio'

/** Chromium decodes the same private audio URL used by the notes page. No microphone is involved. */
export function createNoteAudioPlayer(audio:HTMLAudioElement=new Audio()):{run:(request:NoteAudioRequest)=>Promise<NoteAudioState>;dispose:()=>void} {
  let id:string|null=null
  const snapshot=():NoteAudioState=>({id,state:!id?'idle':audio.ended?'ended':audio.paused?'paused':'playing',positionMs:Math.round(audio.currentTime*1000),durationMs:Number.isFinite(audio.duration)?Math.round(audio.duration*1000):0,rate:audio.playbackRate})
  return {
    async run(request){
      if(request.action!=='play' && request.id && id && request.id!==id)throw Error('正在播放的是另一条随记')
      if(request.action==='play'){
        if(!request.url?.startsWith('typeless-audio://note/')||!request.id)throw Error('Invalid note audio source')
        audio.pause();audio.src=request.url;id=request.id;audio.load()
        if(request.rate!==undefined)audio.playbackRate=request.rate
        try{await audio.play()}catch(error){audio.pause();audio.removeAttribute('src');audio.load();id=null;throw error}
      }else if(request.action==='pause')audio.pause()
      else if(request.action==='resume'){if(!id)throw Error('没有可继续播放的录音');await audio.play()}
      else if(request.action==='stop'){audio.pause();audio.removeAttribute('src');audio.load();id=null}
      else if(request.action==='seek'){if(!id||!Number.isFinite(audio.duration))throw Error('录音尚未就绪');audio.currentTime=Math.min(audio.duration,(request.positionMs??0)/1000)}
      else if(request.action==='rate')audio.playbackRate=request.rate??1
      return snapshot()
    },
    dispose(){audio.pause();audio.removeAttribute('src');audio.load()}
  }
}
