import { DatabaseSync } from 'node:sqlite'
import { readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'

export interface DownloadRecord {path:string;name:string;downloadedAt:string;source:string;sourceUrl:string;completed:boolean}
/** Chromium records real download instants in microseconds since 1601, unrelated to NTFS mtime. */
export function readDownloadDatabase(path:string,source:string,query:string):DownloadRecord[] {
  const db=new DatabaseSync(path,{readOnly:true})
  try {
    const statement=db.prepare(`SELECT target_path, start_time, state,
      (SELECT url FROM downloads_url_chains WHERE id=downloads.id ORDER BY chain_index DESC LIMIT 1) AS source_url
      FROM downloads WHERE target_path <> '' AND start_time > 0 ORDER BY start_time DESC LIMIT 500`)
    statement.setReadBigInts(true)
    const rows=statement.all()
    return rows.filter(row=>String(row.target_path).toLowerCase().includes(query.toLowerCase())).map(row=>{
      const instant=Number(BigInt(row.start_time as bigint)/1000n-11644473600000n)
      let url='';try{url=new URL(String(row.source_url)).origin}catch{}
      return {path:String(row.target_path),name:basename(String(row.target_path)),downloadedAt:new Date(instant).toISOString(),source,sourceUrl:url,completed:Number(row.state)===1}
    })
  }finally{db.close()}
}
export async function browserDownloads(query:string,pathAllowed:(path:string)=>Promise<boolean>):Promise<{records:DownloadRecord[];sources:string[];unavailable:string[]}> {
  const base=process.env.LOCALAPPDATA??'',records:DownloadRecord[]=[],sources:string[]=[],unavailable:string[]=[]
  if(!base)return {records,sources,unavailable:['Windows profile unavailable']}
  for(const [label,folder] of [['Chrome',join(base,'Google/Chrome/User Data')],['Edge',join(base,'Microsoft/Edge/User Data')]]){
    let profiles:string[]
    try { profiles=(await readdir(folder,{withFileTypes:true})).filter(item=>item.isDirectory()&&!item.isSymbolicLink()&&/^(?:Default|Profile \d+)$/.test(item.name)).slice(0,20).map(item=>item.name) }
    catch {unavailable.push(label);continue}
    for(const profile of profiles){
      const file=join(folder,profile,'History'),source=`${label} · ${profile}`
      if(!await pathAllowed(file)){unavailable.push(`${source}: excluded`);continue}
      try{records.push(...readDownloadDatabase(file,source,query));sources.push(source)}catch{unavailable.push(source)}
    }
  }
  records.sort((a,b)=>Date.parse(b.downloadedAt)-Date.parse(a.downloadedAt))
  return {records,sources,unavailable}
}
