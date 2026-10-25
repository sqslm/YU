import { it, expect } from 'vitest'
import { assistantPathAllowed, assistantAppExcluded, normalizeAssistantAccess } from './assistantAccess'

it('enforces directory boundaries and exclusion precedence without substring collisions',()=>{
  const access=normalizeAssistantAccess({allowedRoots:['E:\\Work'],excludedPaths:['E:\\Work\\Private'],excludedApps:['chrome.exe']})
  expect(assistantPathAllowed('e:/work/report.pdf',access)).toBe(true)
  expect(assistantPathAllowed('E:\\Workplace\\report.pdf',access)).toBe(false)
  expect(assistantPathAllowed('E:\\WORK\\PRIVATE\\report.pdf',access)).toBe(false)
  expect(assistantAppExcluded('chrome','C:\\Apps\\chrome.exe',access)).toBe(true)
  expect(assistantAppExcluded('chromedriver','C:\\Apps\\chromedriver.exe',access)).toBe(false)
})
