import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, parse } from 'node:path'

/** Prefer the literal path. Repair only uniquely matching directory names on disk. */
export async function resolveSpokenFolder(input:string):Promise<{path:string;corrected:boolean;candidates?:string[]}> {
  try{const path=await realpath(input);return {path,corrected:false}}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const parent=await realpath(dirname(input)),name=basename(input),drive=parse(parent).root[0]
  const literal=name.toLowerCase()
  const clean=name.replace(new RegExp(`^(?:${drive}\\s*盘(?:里|中|下面|下)?的?\\s*)+`,'i'),'').trim()
  const compact=(value:string):string=>/^[a-z](?:\s+[a-z]){1,7}$/i.test(value)?value.replace(/\s/g,'').toLowerCase():value.toLowerCase()
  const key=compact(clean)
  const entries=await readdir(parent,{withFileTypes:true})
  const exact=entries.filter(entry=>entry.isDirectory()&&entry.name.toLowerCase()===literal)
  const matches=exact.length?exact:entries.filter(entry=>{
    if(!entry.isDirectory())return false
    const value=compact(entry.name)
    return value===key || /^[a-z][a-z0-9_-]{3,}$/i.test(key)&&(value===key+'s'||key.endsWith('s')&&value===key.slice(0,-1))
  })
  const paths=await Promise.all(matches.slice(0,10).map(entry=>realpath(join(parent,entry.name))))
  if(paths.length!==1)return {path:'',corrected:false,candidates:paths}
  if(!(await stat(paths[0])).isDirectory())return {path:'',corrected:false}
  return {path:paths[0],corrected:true}
}
