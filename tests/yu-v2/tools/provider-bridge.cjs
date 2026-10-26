const {app,safeStorage}=require('electron'),fs=require('node:fs'),path=require('node:path')
const source=path.join(process.env.APPDATA,'typeless-rebuild')
const localState=JSON.parse(fs.readFileSync(path.join(source,'Local State'),'utf8'))
fs.writeFileSync(path.join(process.env.YU_V2_BRIDGE_DATA,'Local State'),JSON.stringify({os_crypt:localState.os_crypt}))
app.setPath('userData',process.env.YU_V2_BRIDGE_DATA);app.disableHardwareAcceleration()
app.whenReady().then(()=>{
 const raw=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'typeless-rebuild','settings.json'),'utf8'))
 const data={profiles:raw.profiles,chains:raw.chains,polish:raw.polish,asr:raw.asr,multimodal:raw.multimodal,search:raw.search}
 let decrypted=0
 for(const holder of [...(data.profiles||[]),data.polish,data.asr,data.multimodal,...Object.values(data.search?.providers||{}),...(data.search?.connections||[])]){
  if(holder?.apiKeyEnc){if(!safeStorage.isEncryptionAvailable())throw Error('Secure storage unavailable');if(!holder.apiKey)holder.apiKey=safeStorage.decryptString(Buffer.from(holder.apiKeyEnc,'base64'));delete holder.apiKeyEnc;decrypted++}
 }
 process.send({kind:'settings',data,metadata:{decrypted,readOnly:true}},()=>app.quit())
}).catch(error=>{process.send?.({kind:'error',reason:'Cannot read configured providers through OS secure storage',stageError:String(error?.message||error).slice(0,180)},()=>app.exit(1))})
