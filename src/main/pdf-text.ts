import { Worker } from 'node:worker_threads'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

/** A worker bounds malformed PDF CPU/memory work as well as elapsed time. */
export function pdfText(bytes:Uint8Array,timeoutMs=4000,signal?:AbortSignal):Promise<string|null> {
  signal?.throwIfAborted()
  const resolve=createRequire(import.meta.url).resolve
  const pdfModule=resolve('pdfjs-dist/legacy/build/pdf.mjs'),pdfRoot=join(dirname(pdfModule),'../..')
  const worker=new Worker(join(__dirname,'../../resources/pdf-worker.cjs'),{
    workerData:{bytes,pdfModule:pathToFileURL(pdfModule).href,cMapUrl:join(pdfRoot,'cmaps/')+'/',standardFontDataUrl:join(pdfRoot,'standard_fonts/')+'/'},
    resourceLimits:{maxOldGenerationSizeMb:128}
  })
  return new Promise((resolve,reject)=>{
    let settled=false
    const finish=(error?:Error,text:string|null=null):void=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);void worker.terminate()
      if(error)reject(error);else resolve(text)
    }
    const cancel=():void=>finish(new Error('Cancelled'))
    const timer=setTimeout(()=>finish(new Error('PDF extraction timed out')),Math.max(1,timeoutMs))
    signal?.addEventListener('abort',cancel,{once:true})
    worker.on('message',(value:{text?:string|null;error?:string})=>finish(value.error?new Error(value.error):undefined,value.text??null))
    worker.on('error',error=>finish(error))
    worker.on('exit',code=>{if(!settled)finish(new Error(`PDF worker exited (${code})`))})
    if(signal?.aborted)cancel()
  })
}
