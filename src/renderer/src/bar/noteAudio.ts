import type { NoteAudioEvent, NoteAudioRequest, NoteAudioState } from '@shared/noteAudio'

/** A source that never becomes playable has to fail the command, not silence it forever. */
const LOAD_TIMEOUT_MS=5000

/** Chromium decodes the same private audio URL used by the notes page. No microphone is involved. */
export function createNoteAudioPlayer(audio:HTMLAudioElement=new Audio(),options:{report?:(state:NoteAudioEvent)=>void}={}):{run:(request:NoteAudioRequest)=>Promise<NoteAudioState>;dispose:()=>void} {
  let id:string|null=null
  let sequence=0
  let starting=false
  // The play command that currently owns the element; a late event from a
  // replaced playback carries the old attempt and is dropped.
  let owner:{attempt:number;requestId:string}|null=null
  const snapshot=():NoteAudioState=>({id,state:!id?'idle':audio.ended?'ended':audio.paused?'paused':'playing',positionMs:Math.round(audio.currentTime*1000),durationMs:Number.isFinite(audio.duration)?Math.round(audio.duration*1000):0,rate:audio.playbackRate})
  // The main process keeps the pill alive while audio runs, so it needs the real
  // state instead of a duration estimate, and it must never be moved by an event
  // belonging to a playback that was already replaced.
  const report=(state:NoteAudioState):void=>{
    if(!options.report||!owner||owner.attempt!==sequence)return
    options.report({...state,requestId:owner.requestId})
  }
  const unload=():void=>{audio.pause();audio.removeAttribute('src');audio.load();id=null}
  const onPlaying=():void=>{starting=false;report({...snapshot(),state:'playing'})}
  // `pause` also fires while a new source is being attached and after `ended`;
  // only a pause the user asked for is a state of its own.
  const onPause=():void=>{if(starting||audio.ended||!id)return;report({...snapshot(),state:'paused'})}
  const onEnded=():void=>report({...snapshot(),state:'ended'})
  const onError=():void=>{starting=false;report({...snapshot(),state:'error'})}
  audio.addEventListener('playing',onPlaying)
  audio.addEventListener('pause',onPause)
  audio.addEventListener('ended',onEnded)
  audio.addEventListener('error',onError)
  return {
    async run(request){
      if(request.action!=='play' && request.id && id && request.id!==id)throw Error('正在播放的是另一条随记')
      if(request.action==='play'){
        if(!request.url?.startsWith('typeless-audio://note/')||!request.id)throw Error('Invalid note audio source')
        const attempt=++sequence
        audio.pause();audio.src=request.url;id=request.id;audio.load()
        if(request.rate!==undefined)audio.playbackRate=request.rate
        owner={attempt,requestId:request.requestId}
        starting=true
        // `play()` only settles once the element is actually decoding; racing it
        // against load failure and a deadline keeps a dead source from leaving
        // the command — and the pill — waiting forever.
        let fail:(error:Error)=>void=()=>undefined
        const failure=new Promise<never>((_resolve,reject)=>{fail=reject})
        const deadline=setTimeout(()=>fail(Error('录音无法播放')),LOAD_TIMEOUT_MS)
        const onLoadError=():void=>fail(Error('录音无法播放'))
        audio.addEventListener('error',onLoadError)
        try{await Promise.race([audio.play(),failure]);if(attempt!==sequence)throw Error('Playback superseded')}
        catch(error){
          starting=false
          if(attempt===sequence){unload();report({...snapshot(),state:'error'})}
          throw error
        }finally{clearTimeout(deadline);audio.removeEventListener('error',onLoadError)}
      }else if(request.action==='pause')audio.pause()
      else if(request.action==='resume'){if(!id)throw Error('没有可继续播放的录音');await audio.play()}
      else if(request.action==='stop'){
        // The page stopped itself: release the pill before the element is torn
        // down, since no event will be emitted for a source that is gone.
        report({...snapshot(),state:'idle'})
        sequence++
        unload()
      }
      else if(request.action==='seek'){if(!id||!Number.isFinite(audio.duration))throw Error('录音尚未就绪');audio.currentTime=Math.min(audio.duration,(request.positionMs??0)/1000)}
      else if(request.action==='rate')audio.playbackRate=request.rate??1
      return snapshot()
    },
    dispose(){
      sequence++
      owner=null
      id=null
      audio.removeEventListener('playing',onPlaying)
      audio.removeEventListener('pause',onPause)
      audio.removeEventListener('ended',onEnded)
      audio.removeEventListener('error',onError)
      audio.pause();audio.removeAttribute('src');audio.load()
    }
  }
}
