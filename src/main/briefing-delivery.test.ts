import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it, expect } from 'vitest'
import { DEFAULT_BRIEFING_DELIVERY } from '@shared/briefingDelivery'
import { BriefingDeliveryService } from './briefing-delivery'

let server:Server|undefined,root='',file=''
afterEach(async()=>{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;if(file){try{unlinkSync(file)}catch{}}if(root)rmdirSync(root);root='';file=''})
it('sends exact configured requests, records independent real receipts/failures and survives restart without secrets',async()=>{
  const requests:Array<{path:string;auth:string;body:Record<string,unknown>}>=[]
  server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    requests.push({path:req.url!,auth:String(req.headers.authorization),body:JSON.parse(body)})
    res.writeHead(req.url!.includes('resend')?200:503,{'Content-Type':'application/json'})
    res.end(req.url!.includes('resend')?JSON.stringify({id:'email-actual-id'}):JSON.stringify({error:'down'}))
  });await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve))
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  const settings=structuredClone(DEFAULT_BRIEFING_DELIVERY)
  settings.email={enabled:true,apiKey:'mail-secret',from:'assistant@verified.test',to:'user@example.test'}
  settings.push={enabled:true,apiKey:'push-secret',baseUrl:'https://ntfy.sh',topic:'private-topic'}
  root=mkdtempSync(join(tmpdir(),'yu-delivery-'));file=join(root,'receipts.json')
  const service=new BriefingDeliveryService(file,()=>settings,()=>{},(url,options)=>fetch(`${origin}/${new URL(String(url)).host}`,options))
  const receipts=await service.send({title:'Actual day',body:'09:00 Actual event'})
  expect(requests).toEqual([
    {path:'/api.resend.com',auth:'Bearer mail-secret',body:{from:'assistant@verified.test',to:['user@example.test'],subject:'Actual day',text:'09:00 Actual event'}},
    {path:'/ntfy.sh',auth:'Bearer push-secret',body:{topic:'private-topic',title:'Actual day',message:'09:00 Actual event'}}])
  expect(receipts).toMatchObject([{status:'accepted',providerId:'email-actual-id'},{status:'failed',error:'ntfy HTTP 503'}])
  expect(new BriefingDeliveryService(file,()=>settings,()=>{}).history()).toEqual(service.history())
  expect(readFileSync(file,'utf8')).not.toMatch(/mail-secret|push-secret|09:00 Actual event/)
})
it('never sends when disabled, misconfigured or already cancelled',async()=>{
  root=mkdtempSync(join(tmpdir(),'yu-delivery-'));file=join(root,'receipts.json')
  const settings=structuredClone(DEFAULT_BRIEFING_DELIVERY)
  let calls=0
  const service=new BriefingDeliveryService(file,()=>settings,()=>{},async()=>{calls++;throw Error('must not call')})
  await expect(service.send({title:'day',body:'facts'})).rejects.toThrow('配置并开启')
  settings.push.enabled=true;settings.push.topic='../../bad'
  expect(await service.send({title:'day',body:'facts'})).toMatchObject([{status:'failed'}]);expect(calls).toBe(0)
  const controller=new AbortController();controller.abort()
  await expect(service.send({title:'day',body:'facts'},undefined,controller.signal)).rejects.toThrow()
  expect(calls).toBe(0)
})
it('keeps a lost acknowledgement unknown and starts no further channel after cancellation',async()=>{
  root=mkdtempSync(join(tmpdir(),'yu-delivery-'));file=join(root,'receipts.json')
  const settings=structuredClone(DEFAULT_BRIEFING_DELIVERY);settings.email={enabled:true,apiKey:'test-key',from:'a@verified.test',to:'b@example.test'};settings.push={...settings.push,enabled:true,topic:'private'}
  let calls=0
  const service=new BriefingDeliveryService(file,()=>settings,()=>{},async()=>{calls++;return new Response('{}',{status:200})})
  expect(await service.send({title:'day',body:'facts'},['email'])).toMatchObject([{status:'unknown'}])
  const controller=new AbortController()
  const interrupted=new BriefingDeliveryService(file,()=>settings,()=>{},async()=>{calls++;controller.abort();throw Error('Cancelled before receipt')})
  expect(await interrupted.send({title:'day',body:'facts'},undefined,controller.signal)).toMatchObject([{channel:'email',status:'unknown'}])
  expect(calls).toBe(2)
})
