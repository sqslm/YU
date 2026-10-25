import { it, expect } from 'vitest'
import { pdfText } from './pdf-text'

function pdf(text:string,cjk=false):Uint8Array {
  const body=`BT /F1 12 Tf 40 100 Td ${cjk?'<4E2D6587>':`(${text})`} Tj ET`
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${body.length} >>\nstream\n${body}\nendstream`]
  if(cjk){objects[3]='<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>';objects.push('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>')}
  let file='%PDF-1.4\n',offsets=[0]
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(file));file+=`${index+1} 0 obj\n${object}\nendobj\n`})
  const xref=Buffer.byteLength(file)
  file+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length+1} >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(file)
}
it('reads a real PDF body in the shipped worker and rejects invalid data',async()=>{
  expect(await pdfText(pdf('Actual budget proposal'),4000)).toContain('Actual budget proposal')
  await expect(pdfText(Buffer.from('not a PDF'))).rejects.toThrow()
})
it('uses the shipped Adobe CMaps to read CJK text without an embedded ToUnicode map',async()=>{
  expect(await pdfText(pdf('',true))).toContain('中文')
})
it('terminates extraction on an actual deadline and cancellation',async()=>{
  await expect(pdfText(pdf('test'),1)).rejects.toThrow('timed out')
  const controller=new AbortController(),pending=pdfText(pdf('test'),4000,controller.signal)
  controller.abort();await expect(pending).rejects.toThrow('Cancelled')
})
