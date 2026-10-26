import {spawn} from 'node:child_process'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative,isAbsolute} from 'node:path'
export async function loadLiveSettings(root){
 const bridgeData=await mkdtemp(join(tmpdir(),'yu-v2-provider-'))
 return new Promise(resolveResult=>{
  const child=spawn(join(root,'node_modules/electron/dist/electron.exe'),[join(root,'tests/yu-v2/tools/provider-bridge.cjs')],{cwd:root,windowsHide:true,env:{...process.env,YU_V2_BRIDGE_DATA:bridgeData},stdio:['ignore','ignore','ignore','ipc']})
  let complete=false
  const done=value=>{if(complete)return;complete=true;clearTimeout(timer);resolveResult(value)}
  const timer=setTimeout(()=>{child.kill();done({error:'Provider credential bridge timed out'})},15000)
  child.on('message',message=>{if(message.kind==='settings')done({...message,bridgeData});else done({error:message.reason,detail:message.stageError})});child.on('error',()=>done({error:'Cannot start isolated provider credential bridge'}));child.on('exit',async()=>{if(!complete)done({error:'Credential bridge exited without configuration'});const part=relative(resolve(tmpdir()),resolve(bridgeData));if(part.startsWith('yu-v2-provider-')&&!part.includes('..')&&!isAbsolute(part))await rm(bridgeData,{recursive:true,force:true})})
 })
}
