/**
 * Native process table (Kernel32 Toolhelp32), for everything that has to run
 * inside a timing window.
 *
 * `Get-CimInstance Win32_Process` costs about a second per call, which is why a
 * 20 ms open-latency poll could not afford it. The Toolhelp32 snapshot is the
 * same data minus the command line: pid, parent pid and image name, in 1–10 ms,
 * so PID sets and ancestor walks can stay inside the measured interval.
 *
 * CommandLine still needs WMI, and that is why it is called only outside the
 * timing windows (see the benchmark's `commandLines`).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const TH32CS_SNAPPROCESS = 0x00000002
// PROCESSENTRY32W on x64 (verified against a live snapshot):
//   dwSize @0, th32ProcessID @8, th32ParentProcessID @32, szExeFile @44 (WCHAR[260]).
// sizeof(PROCESSENTRY32W) = 568 and Process32FirstW rejects any other dwSize.
const ENTRY_SIZE = 568
const PID_OFFSET = 8
const PPID_OFFSET = 32
const NAME_OFFSET = 44
const NAME_BYTES = 260 * 2

let api = null

function win32() {
  if (process.platform !== 'win32') throw new Error('the native process table needs Windows')
  if (!api) {
    const koffi = require('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    api = {
      koffi,
      CreateToolhelp32Snapshot: kernel32.func('intptr_t CreateToolhelp32Snapshot(uint32_t, uint32_t)'),
      Process32FirstW: kernel32.func('int Process32FirstW(intptr_t, void *)'),
      Process32NextW: kernel32.func('int Process32NextW(intptr_t, void *)'),
      CloseHandle: kernel32.func('int CloseHandle(intptr_t)')
    }
  }
  return api
}

/**
 * One snapshot of every live process: `[{pid, ppid, name}]`.
 * Throws instead of returning a partial list, so a caller cannot mistake a
 * failed enumeration for an empty tree.
 */
export function listProcessTable() {
  const { koffi, CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, CloseHandle } = win32()
  const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (snapshot === -1) throw new Error('CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS) failed')
  const buffer = Buffer.alloc(ENTRY_SIZE)
  const rows = []
  try {
    buffer.writeUInt32LE(ENTRY_SIZE, 0)
    if (!Process32FirstW(snapshot, koffi.as(buffer, 'void *'))) return rows
    do {
      rows.push({
        pid: buffer.readUInt32LE(PID_OFFSET),
        ppid: buffer.readUInt32LE(PPID_OFFSET),
        name: buffer.toString('utf16le', NAME_OFFSET, NAME_OFFSET + NAME_BYTES).split('\u0000')[0]
      })
      // Some builds reset dwSize between iterations; rewriting it keeps the
      // walk alive without relying on that.
      buffer.writeUInt32LE(ENTRY_SIZE, 0)
    } while (Process32NextW(snapshot, koffi.as(buffer, 'void *')))
  } finally {
    CloseHandle(snapshot)
  }
  return rows
}

/**
 * Children of `rootPid`, depth first, excluding the root itself. Rows keep
 * whatever extra fields the caller's table carried (a `cmd` map, for instance).
 */
export function descendantsOf(table, rootPid) {
  const childrenOf = new Map()
  for (const proc of table ?? []) {
    if (proc.ppid === undefined) continue
    if (!childrenOf.has(proc.ppid)) childrenOf.set(proc.ppid, [])
    childrenOf.get(proc.ppid).push(proc)
  }
  const found = []
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift()
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}
