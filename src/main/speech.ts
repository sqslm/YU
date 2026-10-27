/**
 * Read-aloud service for the main process.
 *
 * Two ideas shape this file:
 *
 * 1. The utterance must never travel on a command line. PowerShell arguments
 *    show up in every process listing and the shell would interpret quotes and
 *    `$` sigils, so the text goes to a fixed, shipped script through stdin.
 * 2. Nothing here throws from the plumbing. The bridge reports failures as
 *    values, `voices()` answers with an empty list, and only `speak()` — the one
 *    place a person asked for sound — surfaces an error.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mt } from '@shared/mainI18n'
import { normalizeTtsSettings, speechText, type TtsSettings, type SpeechAudio } from '@shared/speech'

export interface SpeechRequest {
  action: 'speak' | 'stop' | 'voices'
  text?: string
  rate?: number
  volume?: number
  voice?: string
  audio?: SpeechAudio
  speed?: number
}

export interface SpeechResult {
  ok: boolean
  error?: string
  voices?: string[]
  paused?: boolean
}

export type SpeechRunner = ((request: SpeechRequest, signal?: AbortSignal, onStarted?:()=>void) => Promise<SpeechResult>) & { control?:(action:'pause'|'resume')=>Promise<SpeechResult> }

/** A synthesizer has no reason to print megabytes; the cap bounds memory. */
const OUTPUT_LIMIT = 2_000_000
/** Speaking a long paragraph takes a while, but a hung bridge must not. */
const TIMEOUT_MS = 20_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function detail(text: string, fallback: string): string {
  return (text.trim() || fallback).slice(0, 200)
}

/**
 * Bridge to `resources/speech.ps1`.
 *
 * Accepts the script path instead of resolving it here so the caller keeps the
 * packaged/unpackaged decision (`windows-native.ts`) and this stays testable.
 */
export function createWindowsSpeechRunner(scriptPath: string): SpeechRunner {
  let active:ChildProcess|null=null
  let sequence=0
  const controls=new Map<number,{child:ChildProcess;resolve:(result:SpeechResult)=>void;timer:ReturnType<typeof setTimeout>}>()
  const run:SpeechRunner=(request,signal,onStarted)=>new Promise(resolve=>{
    let child:ChildProcess
    try {child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptPath],{windowsHide:true,stdio:['pipe','pipe','pipe']})}
    catch(error){resolve({ok:false,error:messageOf(error)});return}
    if(request.action==='speak')active=child
    let buffer='',errorText='',bytes=0,settled=false
    const finish=(result:SpeechResult):void=>{
      if(settled)return
      settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel)
      if(active===child)active=null
      for(const [id,control] of controls)if(control.child===child){clearTimeout(control.timer);control.resolve({ok:false,error:'Speech stopped'});controls.delete(id)}
      resolve(result)
    }
    const kill=(message:string):void=>{try{child.kill()}catch{}finish({ok:false,error:message})}
    const cancel=():void=>kill('cancelled')
    const timer=setTimeout(()=>kill('Speech startup timeout'),TIMEOUT_MS)
    const frame=(line:string):void=>{
      if(settled)return
      try {
        const value=JSON.parse(line.replace(/^\uFEFF/,'')) as SpeechResult & {event?:string;id?:number}
        if(value.event==='started'){clearTimeout(timer);onStarted?.();return}
        if(value.event==='control' && value.id!==undefined){const pending=controls.get(value.id);if(pending?.child===child){clearTimeout(pending.timer);controls.delete(value.id);pending.resolve(value)};return}
        finish({ok:value.ok===true,error:value.error,voices:Array.isArray(value.voices)?value.voices.filter(name=>typeof name==='string'&&name.trim()):undefined})
      }catch(error){kill(detail(messageOf(error),'Invalid speech response'))}
    }
    child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8')
    child.stdout?.on('data',(chunk:string)=>{
      bytes+=chunk.length;if(bytes>OUTPUT_LIMIT){kill('Speech output too large');return}
      buffer+=chunk;let newline:number
      while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(line)frame(line)}
    })
    child.stderr?.on('data',(text:string)=>{errorText=(errorText+text).slice(0,2000)})
    child.on('error',error=>finish({ok:false,error:messageOf(error)}))
    child.stdin?.on('error',error=>finish({ok:false,error:messageOf(error)}))
    child.on('close',()=>{if(buffer.trim())frame(buffer.trim());if(!settled)finish({ok:false,error:detail(errorText,'Speech bridge closed')})})
    if(signal?.aborted){cancel();return}
    signal?.addEventListener('abort',cancel,{once:true})
    if(request.action==='speak')child.stdin?.write(JSON.stringify(request)+'\n','utf8')
    else child.stdin?.end(JSON.stringify(request)+'\n','utf8')
  })
  run.control=action=>new Promise(resolve=>{
    const child=active
    if(!child?.stdin?.writable){resolve({ok:false,error:'No active speech'});return}
    const id=++sequence
    const timer=setTimeout(()=>{controls.delete(id);resolve({ok:false,error:'Speech control timeout'})},5000)
    controls.set(id,{child,resolve,timer})
    child.stdin.write(JSON.stringify({action,id})+'\n','utf8')
  })
  return run
}

export interface SpeechDeps {
  settings: () => { tts: TtsSettings } | { tts?: TtsSettings }
  run: SpeechRunner
  cloud?: { synthesize: (settings: TtsSettings, text: string, signal: AbortSignal) => Promise<SpeechAudio>; play: SpeechRunner }
  log: (line: string) => void
  /** Injected clock so failure log lines stay assertable. */
  now?: () => number
}

export class SpeechService {
  private readonly deps: SpeechDeps
  /** The live bridge call, if a read-out is in progress. */
  private active: AbortController | null = null
  private paused = false
  private lastError = ''
  private activeRunner: SpeechRunner | null = null
  private resumePending: (() => void) | null = null

  /** Placeholder: read-aloud is never translated, the synthesizer speaks as-is. */
  translate?: never

  constructor(deps: SpeechDeps) {
    this.deps = deps
  }

  speaking(): boolean {
    return this.active !== null
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /**
   * Reads `text` out loud, interrupting whatever was being read.
   *
   * `skipped` means "nothing was spoken and nothing is wrong": reading is
   * switched off, or the message cleaned down to nothing. The tool layer
   * reports that honestly instead of letting the model claim it read the answer.
   */
  async speak(text: unknown, signal?: AbortSignal, onStarted?:()=>void): Promise<{ spoken: number; skipped: boolean }> {
    const tts = normalizeTtsSettings(this.deps.settings().tts)
    if (!tts.enabled) return { spoken: 0, skipped: true }
    const spoken = speechText(text)
    if (!spoken) return { spoken: 0, skipped: true }
    if (signal?.aborted) return { spoken: 0, skipped: true }

    // A new instruction interrupts the old one, the way a system voice
    // assistant behaves: two overlapping voices are unintelligible.
    this.stop()
    const controller = new AbortController()
    const relay = (): void => controller.abort()
    signal?.addEventListener('abort', relay, { once: true })
    this.active = controller
    this.lastError = ''
    const started = this.now()

    try {
      const runner = tts.provider === 'windows' ? this.deps.run : this.deps.cloud?.play
      if (!runner) throw Error('TTS provider is not available')
      const audio = tts.provider === 'windows' ? undefined : await this.deps.cloud!.synthesize(tts, spoken, controller.signal)
      if (this.paused && !controller.signal.aborted) {
        await new Promise<void>(resolve => {
          const done = (): void => { controller.signal.removeEventListener('abort', done); resolve() }
          this.resumePending = done
          controller.signal.addEventListener('abort', done, { once: true })
        })
      }
      controller.signal.throwIfAborted()
      this.activeRunner = runner
      const result = await runner({
        action: 'speak',
        text: spoken,
        rate: tts.rate,
        volume: tts.volume,
        ...(tts.voice ? { voice: tts.voice } : {}),
        ...(audio ? { audio, speed: tts.speed } : {})
      }, controller.signal, () => { if (!controller.signal.aborted) onStarted?.() })
      controller.signal.throwIfAborted()
      if (!result.ok) throw new Error(result.error || 'unknown')
      return { spoken: spoken.length, skipped: false }
    } catch (error) {
      const message = messageOf(error)
      // A read-out that the user (or the next utterance) stopped is not a
      // failure to report back to the model.
      if (controller.signal.aborted) {
        this.deps.log(`speech: interrupted after ${this.now() - started}ms`)
        return { spoken: 0, skipped: true }
      }
      this.deps.log(`speech: failed after ${this.now() - started}ms: ${message}`)
      this.lastError = message
      throw new Error(mt('朗读失败：{{message}}', { message }))
    } finally {
      signal?.removeEventListener('abort', relay)
      if (this.active === controller) { this.active = null; this.activeRunner = null; this.resumePending = null; this.paused = false }
    }
  }

  /** A tool acknowledges actual playback start; the reader remains controllable in the background. */
  start(text:string,signal?:AbortSignal):Promise<{spoken:number;skipped:boolean}> {
    return new Promise((resolve,reject)=>{
      let started=false
      void this.speak(text,signal,()=>{started=true;resolve({spoken:speechText(text).length,skipped:false})}).then(result=>{if(!started)resolve(result)},error=>{if(!started)reject(error)})
    })
  }
  status():{speaking:boolean;paused:boolean;error:string} {return {speaking:this.active!==null,paused:this.paused,error:this.lastError}}
  async pause():Promise<ReturnType<SpeechService['status']>> {
    if(!this.active)return this.status()
    if(!this.activeRunner){this.paused=true;return this.status()}
    const current=this.active
    const result=await this.activeRunner?.control?.('pause')
    if(!result?.ok)throw new Error(result?.error||'Cannot pause speech')
    if(this.active===current)this.paused=true
    return this.status()
  }
  async resume():Promise<ReturnType<SpeechService['status']>> {
    if(!this.active)return this.status()
    if(!this.activeRunner){this.paused=false;this.resumePending?.();this.resumePending=null;return this.status()}
    const current=this.active
    const result=await this.activeRunner?.control?.('resume')
    if(!result?.ok)throw new Error(result?.error||'Cannot resume speech')
    if(this.active===current)this.paused=false
    return this.status()
  }

  /**
   * Stops the current read-out. Idempotent and never throws: it is also the
   * "shut up" path of a hotkey, where an exception would be the worst outcome.
   */
  stop(): void {
    const controller = this.active
    if (!controller) return
    this.active = null
    this.activeRunner = null
    this.paused = false
    try {
      controller.abort()
      this.resumePending?.()
      this.resumePending = null
    } catch (error) {
      this.deps.log(`speech: stop failed: ${messageOf(error)}`)
    }
  }

  /**
   * Installed voices for the settings dropdown.
   *
   * An empty list is a valid answer (no synthesizer installed), and a settings
   * page that cannot list voices must still render.
   */
  async voices(): Promise<string[]> {
    try {
      const result = await this.deps.run({ action: 'voices' })
      if (!result?.ok) {
        this.deps.log(`speech: voice list failed: ${result?.error ?? 'unknown'}`)
        return []
      }
      const names = Array.isArray(result.voices) ? result.voices : []
      return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))]
    } catch (error) {
      // The settings page renders an empty picker instead of a broken one.
      this.deps.log(`speech: voice list failed: ${messageOf(error)}`)
      return []
    }
  }
}
