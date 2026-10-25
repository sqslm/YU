import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { downloadRanges } from './update-download'
let server:Server|undefined,root=''
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()))}server=undefined;if(root)await rm(root,{recursive:true,force:true});root=''})
it('uses concurrent real HTTP ranges and resumes persisted chunks after cancellation',async()=>{
  root=await mkdtemp(join(tmpdir(),'yu-ranges-'))
  const bytes=Buffer.alloc(2*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=(i*17)%251
  const ranges:string[]=[],progress:number[]=[];let active=0,max=0
  server=createServer((req,res)=>{
    ranges.push(String(req.headers.range));const [,start,end]=/bytes=(\d+)-(\d+)/.exec(String(req.headers.range))!
    let at=Number(start);const last=Number(end);res.writeHead(206,{'Content-Range':`bytes ${at}-${last}/${bytes.length}`,ETag:'"fixture-v1"'})
    active++;max=Math.max(max,active)
    const timer=setInterval(()=>{if(at>last){clearInterval(timer);res.end();return}const end=Math.min(at+16384,last+1);res.write(bytes.subarray(at,end));at=end},20)
    res.on('close',()=>{active--;clearInterval(timer)})
  });await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve))
  const options={url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,destination:join(root,'installer.exe'),cacheDir:join(root,'parts'),sha512:createHash('sha512').update(bytes).digest('base64')}
  const controller=new AbortController()
  await expect(downloadRanges({...options,signal:controller.signal,onProgress:state=>{if(state.transferred>0)controller.abort()}})).rejects.toThrow()
  const sizes=await readdir(options.cacheDir);expect(sizes.some(name=>name.endsWith('.part'))).toBe(true)
  const before=ranges.length
  expect(await downloadRanges({...options,onProgress:state=>progress.push(state.transferred)})).toBe(true)
  expect(await readFile(options.destination)).toEqual(bytes);expect(max).toBeGreaterThan(1)
  expect(ranges.slice(before+1).some(value=>!/bytes=(?:0|524288|1048576|1572864)-/.test(value))).toBe(true)
  expect(progress.at(-1)).toBe(bytes.length)
},15000)
it('falls back on a server ignoring Range and rejects a corrupt completed file',async()=>{
  root=await mkdtemp(join(tmpdir(),'yu-ranges-'));let rangeSupported=false
  server=createServer((req,res)=>{if(!rangeSupported){res.end('normal');return}const end=req.headers.range==='bytes=0-0'?0:3;res.writeHead(206,{'Content-Range':`bytes 0-${end}/4`});res.end('xxxx'.slice(0,end+1))})
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve))
  const options={url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,destination:join(root,'installer.exe'),cacheDir:join(root,'parts'),sha512:createHash('sha512').update('good').digest('base64')}
  expect(await downloadRanges(options)).toBe(false);rangeSupported=true
  await expect(downloadRanges(options)).rejects.toThrow('checksum mismatch')
  expect(await readdir(options.cacheDir)).toEqual([])
})
