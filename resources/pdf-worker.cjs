// Fixed text-only worker: never executes PDF JavaScript, loads URLs or renders pages.
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  const { getDocument } = await import(workerData.pdfModule)
  const task = getDocument({ data: new Uint8Array(workerData.bytes), isEvalSupported: false,
    useSystemFonts: true, disableFontFace: true, useWorkerFetch: false, useWasm: false, verbosity: 0,
    cMapUrl: workerData.cMapUrl, cMapPacked: true, standardFontDataUrl: workerData.standardFontDataUrl })
  try {
    const doc = await task.promise
    if (doc.numPages > 1000) throw Error('PDF exceeds 1000 pages')
    let text = ''
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ')
      text += '\n'
      if (text.length > 4 * 1024 * 1024) throw Error('PDF text exceeds limit')
      page.cleanup()
    }
    parentPort.postMessage({ text: text.trim() || null })
  } finally { await task.destroy() }
})().catch(error => parentPort.postMessage({ error: error.message }))
