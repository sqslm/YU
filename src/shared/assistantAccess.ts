export interface AssistantAccessSettings {
  allowedRoots: string[]
  excludedPaths: string[]
  excludedApps: string[]
  disabledTools: string[]
  everythingPort: number
  everythingHttp: boolean
  everythingCli: string
}
export const DEFAULT_ASSISTANT_ACCESS: AssistantAccessSettings = {allowedRoots:[],excludedPaths:[],excludedApps:[],disabledTools:[],everythingPort:80,everythingHttp:true,everythingCli:''}
export function normalizeAssistantAccess(input?:Partial<AssistantAccessSettings>):AssistantAccessSettings {
  const list=(value:unknown):string[]=>Array.isArray(value)?[...new Set(value.filter((item):item is string=>typeof item==='string').map(item=>item.trim()).filter(Boolean))].slice(0,100):[]
  return {allowedRoots:list(input?.allowedRoots),excludedPaths:list(input?.excludedPaths),excludedApps:list(input?.excludedApps),disabledTools:list(input?.disabledTools),
    everythingPort:Number.isInteger(input?.everythingPort)&&input!.everythingPort!>0&&input!.everythingPort!<=65535?input!.everythingPort!:80,
    everythingHttp:input?.everythingHttp!==false,everythingCli:typeof input?.everythingCli==='string'?input.everythingCli.trim():''}
}
const pathKey=(path:string):string=>path.replace(/\//g,'\\').replace(/\\+$/,'').toLowerCase()
const inside=(root:string,path:string):boolean=>pathKey(path)===pathKey(root)||pathKey(path).startsWith(pathKey(root)+'\\')
/** Caller resolves real paths as well, so aliases/junctions cannot expand a grant. */
export function assistantPathAllowed(path:string,access:AssistantAccessSettings):boolean {
  return !access.excludedPaths.some(root=>inside(root,path)) && (!access.allowedRoots.length||access.allowedRoots.some(root=>inside(root,path)))
}
export function assistantAppExcluded(app:string|undefined,path:string|undefined,access:AssistantAccessSettings):boolean {
  const name=(value:string):string=>value.replace(/\.exe$/i,'').toLowerCase()
  const base=(path??'').split(/[\\/]/).at(-1)??''
  return access.excludedApps.some(value=>name(value)===name(app??'')||name(value)===name(base)||pathKey(value)===pathKey(path??''))
}
