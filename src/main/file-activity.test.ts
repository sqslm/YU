import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, unlinkSync, rmdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { readDownloadDatabase } from './file-activity'

it('reads true browser download time and origin without changing the history database',()=>{
  const root=mkdtempSync(join(tmpdir(),'yu-download-')),file=join(root,'History')
  try{
    const db=new DatabaseSync(file)
    db.exec('CREATE TABLE downloads(id INTEGER,target_path TEXT,start_time INTEGER,state INTEGER); CREATE TABLE downloads_url_chains(id INTEGER,chain_index INTEGER,url TEXT)')
    const at=Date.parse('2026-10-25T04:05:06Z')
    db.prepare('INSERT INTO downloads VALUES(?,?,?,?)').run(1,'E:\\docs\\report.pdf',(at+11644473600000)*1000,1)
    db.prepare('INSERT INTO downloads_url_chains VALUES(?,?,?)').run(1,0,'https://files.example/report.pdf?token=private')
    db.close()
    const before=readFileSync(file)
    expect(readDownloadDatabase(file,'Edge','REPORT')).toMatchObject([{name:'report.pdf',downloadedAt:'2026-10-25T04:05:06.000Z',sourceUrl:'https://files.example',completed:true}])
    expect(readDownloadDatabase(file,'Edge','absent')).toEqual([])
    expect(readFileSync(file)).toEqual(before)
  }finally{unlinkSync(file);rmdirSync(root)}
})
