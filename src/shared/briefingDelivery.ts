export type DeliveryChannel='email'|'push'
export interface BriefingDeliverySettings {
  email:{enabled:boolean;apiKey:string;apiKeyEnc?:string;from:string;to:string}
  push:{enabled:boolean;apiKey:string;apiKeyEnc?:string;baseUrl:string;topic:string}
}
export interface BriefingDeliveryReceipt {id:string;at:number;channel:DeliveryChannel;target:string;title:string;status:'sending'|'accepted'|'failed'|'unknown';providerId?:string;error?:string}
export const DEFAULT_BRIEFING_DELIVERY:BriefingDeliverySettings={email:{enabled:false,apiKey:'',from:'',to:''},push:{enabled:false,apiKey:'',baseUrl:'https://ntfy.sh',topic:''}}
export function normalizeBriefingDelivery(input:unknown):BriefingDeliverySettings {
  const raw=(input&&typeof input==='object'?input:{}) as Partial<BriefingDeliverySettings>
  const text=(value:unknown):string=>typeof value==='string'?value.trim():''
  const secret=(value:{apiKey?:unknown;apiKeyEnc?:unknown}|undefined)=>({apiKey:text(value?.apiKey),...(text(value?.apiKeyEnc)?{apiKeyEnc:text(value?.apiKeyEnc)}:{})})
  return {email:{enabled:raw.email?.enabled===true,...secret(raw.email),from:text(raw.email?.from),to:text(raw.email?.to)},push:{enabled:raw.push?.enabled===true,...secret(raw.push),baseUrl:text(raw.push?.baseUrl)||'https://ntfy.sh',topic:text(raw.push?.topic)}}
}
