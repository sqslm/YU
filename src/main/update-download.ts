import { createHash } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'

export interface DownloadProgress {percent:number;transferred:number;total:number;bytesPerSecond:number;etaSeconds:number}
export interface RangeDownloadOptions {
  url:string;destination:string;cacheDir:string;sha512:string;signal?:AbortSignal;headers?:Record<string,string>
  fetchImpl?:typeof fetch;onProgress?:(progress:DownloadProgress)=>void;onVerifying?:()=>void
}
/** Fixed four-way ranges. The upstream updater still owns signature checks and installation. */
export async function downloadRanges(options:RangeDownloadOptions):Promise<boolean> {
  const {signal}=options,fetchImpl=options.fetchImpl??fetch
  signal?.throwIfAborted()
  const expected=Buffer.from(options.sha512,/^[a-f0-9]{128}$/i.test(options.sha512)?'hex':'base64')
  if(expected.length!==64)throw Error('Invalid update SHA-512')
  const headers=new Headers(options.headers);headers.set('Accept-Encoding','identity');headers.set('Range','bytes=0-0')
  const probe=await fetchImpl(options.url,{headers,signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30000)])})
  const range=/^bytes 0-0\/(\d+)$/.exec(probe.headers.get('content-range')??'')
  await probe.body?.cancel()
  if(probe.status===200)return false
  if(probe.status!==206||!range)throw Error(`Update range probe failed (HTTP ${probe.status})`)
  const total=Number(range[1]);if(!Number.isSafeInteger(total)||total<=0)throw Error('Invalid update size')
  const validator=probe.headers.get('etag')??probe.headers.get('last-modified')??''
  const count=total>=1024*1024?4:1,size=Math.ceil(total/count)
  await mkdir(options.cacheDir,{recursive:true})
  const manifest=join(options.cacheDir,'manifest.json'),parts=Array.from({length:4},(_,index)=>join(options.cacheDir,`${index}.part`))
  const identity=JSON.stringify({url:options.url,sha512:options.sha512,total,count,validator})
  const clear=async():Promise<void>=>{for(const file of [...parts,manifest])await unlink(file).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error})}
  let stored='';try{stored=await readFile(manifest,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  if(stored!==identity){await clear();await writeFile(manifest,identity)}
  const lengths=await Promise.all(parts.slice(0,count).map(async(file,index)=>{
    const length=await stat(file).then(info=>info.size).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error})
    if(length>Math.min(size,total-index*size)){await unlink(file);return 0}return length
  }))
  const resumed=lengths.reduce((sum,n)=>sum+n,0),started=Date.now();let lastReport=0
  const progress=(force=false):void=>{
    const now=Date.now();if(!force&&now-lastReport<250)return;lastReport=now
    const transferred=lengths.reduce((sum,n)=>sum+n,0),speed=(transferred-resumed)/Math.max(.001,(now-started)/1000)
    options.onProgress?.({percent:100*transferred/total,transferred,total,bytesPerSecond:Math.round(speed),etaSeconds:speed>0?Math.ceil((total-transferred)/speed):0})
  }
  progress(true)
  const controller=new AbortController(),combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])])
  const jobs=Array.from({length:count},(_,index)=>(async()=>{
    const end=Math.min(total,(index+1)*size)-1
    for(let attempt=0;attempt<3;attempt++){
      const from=index*size+lengths[index];if(from>end)return
      combined.throwIfAborted()
      let file:Awaited<ReturnType<typeof open>>|undefined
      const requestController=new AbortController()
      let requestTimer=setTimeout(()=>requestController.abort(Error('Update connection timed out')),30000)
      try{
        const request=new Headers(options.headers);request.set('Accept-Encoding','identity');request.set('Range',`bytes=${from}-${end}`)
        if(validator&&!validator.startsWith('W/'))request.set('If-Range',validator)
        const response=await fetchImpl(options.url,{headers:request,signal:AbortSignal.any([combined,requestController.signal])})
        if(response.status!==206||response.headers.get('content-range')!==`bytes ${from}-${end}/${total}`){await response.body?.cancel();throw Error(`Update range rejected (HTTP ${response.status})`)}
        if(!response.body)throw Error('Empty update response')
        clearTimeout(requestTimer);requestTimer=setTimeout(()=>requestController.abort(Error('Update download stalled')),60000)
        file=await open(parts[index],'a')
        for await(const chunk of response.body){
          clearTimeout(requestTimer);requestTimer=setTimeout(()=>requestController.abort(Error('Update download stalled')),60000)
          combined.throwIfAborted()
          if(lengths[index]+chunk.byteLength>end-index*size+1)throw Error('Update range exceeded expected size')
          await file.writeFile(chunk);lengths[index]+=chunk.byteLength;progress()
        }
        if(lengths[index]!==end-index*size+1)throw Error('Update range ended early')
        return
      }catch(error){if(combined.aborted||attempt===2)throw error}
      finally{clearTimeout(requestTimer);await file?.close()}
    }
  })().catch(error=>{controller.abort(error);throw error}))
  const settled=await Promise.allSettled(jobs),failed=settled.find(row=>row.status==='rejected')
  if(failed?.status==='rejected')throw failed.reason
  signal?.throwIfAborted();progress(true);options.onVerifying?.()
  const output=await open(options.destination,'w'),hash=createHash('sha512')
  try{
    for(const file of parts.slice(0,count))for await(const chunk of createReadStream(file)){signal?.throwIfAborted();hash.update(chunk);await output.writeFile(chunk)}
  }finally{await output.close()}
  if(!hash.digest().equals(expected)){await unlink(options.destination);await clear();throw Error('Update SHA-512 checksum mismatch')}
  await clear();return true
}
