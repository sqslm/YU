import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect, vi } from 'vitest'
import { SettingsStore } from './settings'
const crypto=vi.hoisted(()=>({available:true}))
vi.mock('electron',()=>({app:{getPath:()=>tmpdir()},safeStorage:{isEncryptionAvailable:()=>crypto.available,encryptString:(text:string)=>Buffer.from(text),decryptString:(bytes:Buffer)=>bytes.toString()}}))
it('encrypts both delivery credentials and restores them after restart; refuses plaintext fallback',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yu-delivery-settings-')),file=join(root,'settings.json')
  try{
    crypto.available=true
    const store=new SettingsStore(file);await store.load()
    await store.update({briefingDelivery:{email:{enabled:false,apiKey:'resend-private-key',from:'a@b.test',to:'c@d.test'},push:{enabled:false,apiKey:'ntfy-private-key',baseUrl:'https://ntfy.sh',topic:'private'}}})
    const saved=await readFile(file,'utf8');expect(saved).not.toContain('resend-private-key');expect(saved).not.toContain('ntfy-private-key')
    const restarted=new SettingsStore(file),loaded=await restarted.load()
    expect(loaded.briefingDelivery.email.apiKey).toBe('resend-private-key');expect(loaded.briefingDelivery.push.apiKey).toBe('ntfy-private-key')
    crypto.available=false
    await expect(restarted.save()).rejects.toThrow('安全存储不可用')
    expect(await readFile(file,'utf8')).toBe(saved)
  }finally{crypto.available=true;await unlink(file);await rmdir(root)}
})
