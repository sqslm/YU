import { mt } from '@shared/mainI18n'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { BriefingDeliveryReceipt, BriefingDeliverySettings, DeliveryChannel } from '@shared/briefingDelivery'

/** Explicitly configured HTTP delivery; accepted means provider receipt, not recipient delivery. */
export class BriefingDeliveryService {
  private rows:BriefingDeliveryReceipt[]=[]
  private controller=new AbortController()
  constructor(private readonly file:string,private settings:()=>BriefingDeliverySettings,private changed:()=>void,private fetchImpl:typeof fetch=fetch){
    try{const rows=JSON.parse(readFileSync(file,'utf8'));if(Array.isArray(rows))this.rows=rows.slice(-60).map(row=>row.status==='sending'?{...row,status:'unknown',error:mt('进程退出前没有收到服务回执，送达状态未知')}:row)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
  history():BriefingDeliveryReceipt[]{return structuredClone(this.rows)}
  stop():void{this.controller.abort()}
  private record(row:BriefingDeliveryReceipt):void{
    this.rows=[...this.rows.filter(item=>item.id!==row.id),row].slice(-60)
    const temp=this.file+'.tmp';writeFileSync(temp,JSON.stringify(this.rows));renameSync(temp,this.file);this.changed()
  }
  async send(briefing:{title:string;body:string},channels?:DeliveryChannel[],signal?:AbortSignal):Promise<BriefingDeliveryReceipt[]>{
    signal?.throwIfAborted()
    const settings=structuredClone(this.settings())
    const selected=(channels??['email','push']).filter(channel=>settings[channel].enabled)
    if(!selected.length)throw Error(mt('请先在简报设置中配置并开启邮件或手机推送'))
    const receipts:BriefingDeliveryReceipt[]=[]
    for(const channel of [...new Set(selected)]){
      signal?.throwIfAborted()
      if(!this.settings()[channel].enabled)continue
      let target=settings.email.to
      if(channel==='push'){try{const url=new URL(settings.push.baseUrl);target=`${url.origin}${url.pathname.replace(/\/$/,'')}/${settings.push.topic}`}catch{target='ntfy'}}
      const row:BriefingDeliveryReceipt={id:randomUUID(),at:Date.now(),channel,title:briefing.title,target,status:'sending'}
      this.record(row)
      let requested=false,knownFailure=false
      try{
        let url:string,body:string,headers:Record<string,string>={'Content-Type':'application/json'}
        if(channel==='email'){
          const email=settings.email
          if(!email.apiKey||![email.from,email.to].every(value=>/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)))throw Error(mt('请配置 Resend 密钥、已验证的发件邮箱及收件邮箱'))
          url='https://api.resend.com/emails';headers.Authorization=`Bearer ${email.apiKey}`
          headers['Idempotency-Key']=row.id
          body=JSON.stringify({from:email.from,to:[email.to],subject:briefing.title,text:briefing.body})
        }else{
          const push=settings.push,base=new URL(push.baseUrl)
          if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||!/^\/[\w/-]*$/.test(base.pathname)||!/^[a-zA-Z0-9_-]{1,64}$/.test(push.topic))throw Error(mt('请配置 HTTPS ntfy 服务和有效主题（字母、数字、下划线或连字符）'))
          url=base.href.replace(/\/$/,'')
          if(push.apiKey)headers.Authorization=`Bearer ${push.apiKey}`
          body=JSON.stringify({topic:push.topic,title:briefing.title,message:briefing.body})
        }
        requested=true
        const response=await this.fetchImpl(url,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000),...(signal?[signal]:[])])})
        if(!response.ok){knownFailure=true;await response.body?.cancel();throw Error(`${channel==='email'?'Resend':'ntfy'} HTTP ${response.status}`)}
        const text=await response.text();if(text.length>65536)throw Error(mt('服务回执过大'))
        const receipt=JSON.parse(text) as {id?:unknown}
        if(typeof receipt.id!=='string'||!receipt.id)throw Error(mt('服务未返回有效的消息 ID，送达状态未知'))
        row.status='accepted';row.providerId=receipt.id
      }catch(error){row.status=requested&&!knownFailure?'unknown':'failed';row.error=error instanceof Error?error.message:String(error)}
      this.record(row);receipts.push(row)
      // An aborted application must not begin a second outbound request.
      if(this.controller.signal.aborted||signal?.aborted)break
    }
    return receipts
  }
}
