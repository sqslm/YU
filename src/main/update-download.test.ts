import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { backupUpdateUrl, downloadRanges, downloadUpdateArtifact } from './update-download'
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
  expect(await downloadRanges({...options,url:options.url+'?ticket=rotated',onProgress:state=>progress.push(state.transferred)})).toBe(true)
  expect(await readFile(options.destination)).toEqual(bytes);expect(max).toBeGreaterThan(1)
  expect(ranges.slice(before+1).some(value=>Number(/bytes=(\d+)/.exec(value)![1])%(256*1024)!==0)).toBe(true)
  expect(progress.at(-1)).toBe(bytes.length)
},15000)
it('uses the backup only for public YU assets, without forwarding credentials, and still verifies the digest',async()=>{
  root=await mkdtemp(join(tmpdir(),'yu-ranges-'))
  const official='https://github.com/sqslm/YU/releases/download/v1.2.0-rc.3/YU-1.2.0-rc.3-setup.exe'
  const routes:string[]=[],requests:string[]=[],bytes=Buffer.from('installer')
  const fetchImpl=async(url:any,init:any):Promise<Response>=>{
    requests.push(String(url))
    if(String(url)===official)throw Error('Official network unavailable')
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
    const [,start,end]=/bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get('Range')!)!
    return new Response(bytes.subarray(Number(start),Number(end)+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}})
  }
  const options={url:official,destination:join(root,'installer.exe'),cacheDir:join(root,'parts'),sha512:createHash('sha512').update(bytes).digest('base64'),headers:{Authorization:'test-only-private-header'},fetchImpl:fetchImpl as typeof fetch,onRoute:(route:string)=>routes.push(route)}
  expect(await downloadUpdateArtifact(options)).toBe(true)
  expect(routes).toEqual(['official','accelerated'])
  expect(requests.slice(1).every(url=>url.startsWith('https://gh-proxy.com/https://github.com/sqslm/YU/'))).toBe(true)
  await expect(downloadUpdateArtifact({...options,sha512:createHash('sha512').update('wrong').digest('base64')})).rejects.toThrow('checksum mismatch')
  for(const url of [official+'?token=secret',official.replace('sqslm/YU','other/private'),official.replace('github.com','github.com.evil.example'),official.replace('https:','http:')])expect(backupUpdateUrl(url)).toBeNull()
})
it('falls back on a server ignoring Range and rejects a corrupt completed file',async()=>{
  root=await mkdtemp(join(tmpdir(),'yu-ranges-'));let rangeSupported=false
  server=createServer((req,res)=>{if(!rangeSupported){res.end('normal');return}const end=req.headers.range==='bytes=0-0'?0:3;res.writeHead(206,{'Content-Range':`bytes 0-${end}/4`});res.end('xxxx'.slice(0,end+1))})
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve))
  const options={url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,destination:join(root,'installer.exe'),cacheDir:join(root,'parts'),sha512:createHash('sha512').update('good').digest('base64')}
  expect(await downloadRanges(options)).toBe(false);rangeSupported=true
  await expect(downloadRanges(options)).rejects.toThrow('checksum mismatch')
  expect(await readdir(options.cacheDir)).toEqual([])
})
it('uses at most 32 concurrent connections and resolves the GitHub redirect only once',async()=>{
  root=await mkdtemp(join(tmpdir(),'yu-ranges-'))
  const bytes=Buffer.alloc(8*1024*1024,19);let redirects=0,active=0,max=0
  server=createServer((req,res)=>{
    if(req.url==='/release'){redirects++;res.writeHead(302,{Location:'/cdn'});res.end();return}
    const [,start,end]=/bytes=(\d+)-(\d+)/.exec(String(req.headers.range))!
    active++;max=Math.max(max,active)
    res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`})
    setTimeout(()=>{res.end(bytes.subarray(Number(start),Number(end)+1));active--},25)
  });await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve))
  expect(await downloadRanges({url:`http://127.0.0.1:${(server.address() as {port:number}).port}/release`,destination:join(root,'installer.exe'),cacheDir:join(root,'parts'),sha512:createHash('sha512').update(bytes).digest('base64')})).toBe(true)
  expect(max).toBe(32);expect(redirects).toBe(1)
  expect(createHash('sha512').update(await readFile(join(root,'installer.exe'))).digest('hex')).toBe(createHash('sha512').update(bytes).digest('hex'))
},15000)
it('resumes after an interrupted range without restarting completed bytes',async()=>{
  root=await mkdtemp(join(tmpdir(),'yu-ranges-'))
  const bytes=Buffer.alloc(256*1024,23),starts:number[]=[];let interrupted=false
  server=createServer((req,res)=>{
    const [,start,end]=/bytes=(\d+)-(\d+)/.exec(String(req.headers.range))!;const from=Number(start),last=Number(end)
    res.writeHead(206,{'Content-Range':`bytes ${from}-${last}/${bytes.length}`})
    if(last>0)starts.push(from)
    if(last>0&&!interrupted){interrupted=true;res.write(bytes.subarray(from,from+1024));setTimeout(()=>res.destroy(),20)}
    else res.end(bytes.subarray(from,last+1))
  });await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve))
  expect(await downloadRanges({url:`http://127.0.0.1:${(server.address() as {port:number}).port}/release`,destination:join(root,'installer.exe'),cacheDir:join(root,'parts'),sha512:createHash('sha512').update(bytes).digest('base64')})).toBe(true)
  expect(starts).toEqual([0,1024]);expect(await readFile(join(root,'installer.exe'))).toEqual(bytes)
})
