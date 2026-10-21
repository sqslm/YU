/**
 * Reads the focused control through Windows UI Automation.
 *
 * This is the only way to learn what the user is about to write *into*: the
 * app name and window title say where, but not what surrounds the caret. The
 * vendor's client does the same thing through a native helper; here it is plain
 * koffi against the COM vtable.
 *
 * Three hard-won rules, all learned the hard way:
 *
 *  - Every out-parameter must be a `koffi.alloc(...)` allocation, not a Node
 *    `Buffer`. A `Buffer` holds a pointer that koffi cannot follow, and the
 *    resulting `napi_fatal_error` kills the child with exit code 134.
 *  - A `BSTR` is read as `koffi.decode(ptr, koffi.array('uint16_t', len))` and
 *    joined with `String.fromCharCode`. `koffi.decode(ptr, 'str16')` walks off
 *    the end, and `koffi.view(ptr, …)` aborts on an out-parameter pointer, so
 *    both alternatives kill the process instead of returning text.
 *  - `IUIAutomationTextRange::GetText` / `ExpandToEnclosingUnit` crash the
 *    process on some providers, so only `ValuePattern` is used here. Durable
 *    callers must still host this in a utility process: a provider bug must
 *    never take the UI down with it.
 *
 * Everything is defensive: any HRESULT failure, missing pattern or dead DLL
 * yields `null` rather than an exception.
 */
import koffi from 'koffi'

/** Clipped snapshot of the focused editable control. */
export interface UiaSnapshot {
  /** Friendly control kind, e.g. `edit`, `document`, `pane`. */
  controlType: string
  /** Raw UIA control type id (50030 = Edit, 50004 = Document, …). */
  controlTypeId: number
  className: string
  automationId: string
  name: string
  /**
   * The control's text, clipped to the last `maxChars` characters. Clipping
   * keeps the tail because dictation continues where the caret already sits.
   */
  value: string
  valueTruncated: boolean
  readOnly: boolean
}

const MAX_VALUE_CHARS = 4000

const CONTROL_TYPES: Record<number, string> = {
  50000: 'button',
  50002: 'calendar',
  50003: 'checkbox',
  50004: 'document',
  50005: 'combobox',
  50008: 'listitem',
  50011: 'hyperlink',
  50012: 'image',
  50013: 'list',
  50014: 'menubar',
  50015: 'menu',
  50017: 'menuitem',
  50019: 'pane',
  50020: 'statusbar',
  50021: 'tab',
  50023: 'table',
  50026: 'text',
  50030: 'edit',
  50031: 'toolbar',
  50032: 'tooltip',
  50033: 'tree',
  50034: 'custom',
  50036: 'group',
  50037: 'thumb',
  50038: 'datagrid',
  50039: 'datatitem'
}

/** UIA automation element properties this module needs. */
const PROP_CONTROL_TYPE = 30003
const PROP_NAME = 30005
const PROP_AUTOMATION_ID = 30011
const PROP_CLASS_NAME = 30012

/** UIA pattern ids. */
const PATTERN_VALUE = 10002

const CLSID_CUIAUTOMATION = {
  Data1: 0xff48dba4,
  Data2: 0x60ef,
  Data3: 0x4201,
  Data4: [0xaa, 0x87, 0x54, 0x10, 0x3e, 0xef, 0x59, 0x4e]
}

const IID_IUIAUTOMATION = {
  Data1: 0x30cbe57d,
  Data2: 0xd9d0,
  Data3: 0x452a,
  Data4: [0xab, 0x13, 0x7a, 0xc5, 0xac, 0x48, 0x25, 0xee]
}

/** VT_I4, VT_BSTR and VT_BOOL, the only VARIANT shapes read here. */
const VT_I4 = 3
const VT_BSTR = 8
const VT_BOOL = 11

interface Libs {
  coCreateInstance: (
    clsid: unknown,
    outer: null,
    context: number,
    iid: unknown,
    out: Buffer
  ) => number
  sysStringLen: (bstr: unknown) => number
  sysFreeString: (bstr: unknown) => void
}

let cache: Libs | null = null
let unavailable = false
const protos = new Map<string, ReturnType<typeof koffi.proto>>()

function proto(definition: string): ReturnType<typeof koffi.proto> {
  let cached = protos.get(definition)
  if (!cached) {
    cached = koffi.proto(definition)
    protos.set(definition, cached)
  }
  return cached
}

/** Loads ole32 once; returns null on non-Windows or when COM is unusable. */
function libs(): Libs | null {
  if (cache) return cache
  if (unavailable || process.platform !== 'win32') return null
  try {
    const ole32 = koffi.load('ole32.dll')
    const oleaut32 = koffi.load('oleaut32.dll')
    // Re-registering a GUID name throws, so it happens exactly once, here.
    koffi.struct('GUID', {
      Data1: 'uint32_t',
      Data2: 'uint16_t',
      Data3: 'uint16_t',
      Data4: 'uint8_t[8]'
    })
    const coInitializeEx = ole32.func('long __stdcall CoInitializeEx(void *p, uint32_t c)')
    const coCreateInstance = ole32.func(
      'long __stdcall CoCreateInstance(const GUID *a, void *b, uint32_t c, const GUID *d, void **e)'
    )
    const sysStringLen = oleaut32.func('uint32_t __stdcall SysStringLen(void *b)')
    const sysFreeString = oleaut32.func('void __stdcall SysFreeString(void *b)')
    // ST(A) is required for cross-process UIA proxies; S_FALSE (already
    // initialised) is just as good.
    coInitializeEx(null, 2)
    cache = {
      coCreateInstance: coCreateInstance as unknown as Libs['coCreateInstance'],
      sysStringLen: sysStringLen as unknown as Libs['sysStringLen'],
      sysFreeString: sysFreeString as unknown as Libs['sysFreeString']
    }
    return cache
  } catch {
    unavailable = true
    return null
  }
}

/** Binds vtable slot `index`, injecting `this` automatically. */
function slot(
  objectPtr: unknown,
  index: number,
  definition: string
): (...args: unknown[]) => number {
  const vtable = koffi.decode(objectPtr, 'void *')
  const address = koffi.decode(vtable, index * 8, 'void *')
  const type = proto(definition)
  return (...args: unknown[]) => koffi.call(address, type, objectPtr, ...args) as number
}

function release(objectPtr: unknown): void {
  if (!objectPtr) return
  try {
    slot(objectPtr, 2, 'uint32_t __stdcall(void *self)')()
  } catch {
    // A failed Release only leaks one object; never let it break the caller.
  }
}

function takeBstr(api: Libs, ptr: unknown): string {
  if (!ptr) return ''
  try {
    const length = api.sysStringLen(ptr)
    // A BSTR longer than a million characters is not a control's text, it is a
    // misread pointer.
    if (!length || length < 0 || length > 1_000_000) return ''
    // Read the code units as a typed array. Neither alternative works here:
    // `koffi.view(ptr, …)` aborts the process on an out-parameter pointer
    // (`napi_fatal_error`, exit 134) and `koffi.decode(ptr, 'str16')` walks past
    // the end, which is the same lesson the spike script learned. A BSTR is
    // length-prefixed, so the length we already have is the exact unit count.
    const units = koffi.decode(ptr, koffi.array('uint16_t', length)) as number[]
    let out = ''
    // Chunked: one `apply` of a 4000-element array is fine, 200 k is a stack overflow.
    for (let i = 0; i < units.length; i += 4096) {
      out += String.fromCharCode(...units.slice(i, i + 4096))
    }
    return out
  } finally {
    try {
      api.sysFreeString(ptr)
    } catch {
      // Ignore: the string is ours to leak at worst.
    }
  }
}

/** Reads one automation property, decoding the VARIANT union by offset. */
function readProperty(
  element: unknown,
  propertyId: number
): { kind: number; number?: number; text?: string } {
  const buffer = koffi.alloc('uint8_t', 24)
  const hr = slot(element, 10, 'long __stdcall(void *self, int propertyId, void *retVal)')(
    propertyId,
    buffer
  )
  if (hr < 0) return { kind: -1 }
  const kind = koffi.decode(buffer, 'uint16_t') as number
  const api = libs()
  if (!api) return { kind: -1 }
  if (kind === VT_I4) return { kind, number: koffi.decode(buffer, 8, 'int32_t') as number }
  if (kind === VT_BOOL) {
    return { kind, number: (koffi.decode(buffer, 8, 'int16_t') as number) !== 0 ? 1 : 0 }
  }
  if (kind === VT_BSTR) {
    const ptr = koffi.decode(buffer, 8, 'void *')
    return { kind, text: takeBstr(api, ptr) }
  }
  return { kind }
}

/**
 * Reads the focused control. Returns null when UIA is unavailable, the focus
 * is not an element, or the element exposes no value.
 */
export function readFocusedSnapshot(maxChars = MAX_VALUE_CHARS): UiaSnapshot | null {
  const api = libs()
  if (!api) return null

  let automation: unknown = null
  let element: unknown = null
  let pattern: unknown = null
  try {
    const created = koffi.alloc('void *', 1)
    const hr = api.coCreateInstance(CLSID_CUIAUTOMATION, null, 1, IID_IUIAUTOMATION, created)
    if (hr < 0) return null
    automation = koffi.decode(created, 'void *')
    if (!automation) return null

    const focused = koffi.alloc('void *', 1)
    const hrFocus = slot(automation, 8, 'long __stdcall(void *self, void **retVal)')(focused)
    if (hrFocus < 0) return null
    element = koffi.decode(focused, 'void *')
    if (!element) return null

    const controlType = readProperty(element, PROP_CONTROL_TYPE)
    const controlTypeId = controlType.number ?? 0
    const name = readProperty(element, PROP_NAME).text ?? ''
    const className = readProperty(element, PROP_CLASS_NAME).text ?? ''
    const automationId = readProperty(element, PROP_AUTOMATION_ID).text ?? ''

    const patternOut = koffi.alloc('void *', 1)
    const hrPattern = slot(
      element,
      16,
      'long __stdcall(void *self, int patternId, void **retVal)'
    )(PATTERN_VALUE, patternOut)
    let value = ''
    let readOnly = false
    if (hrPattern >= 0) {
      pattern = koffi.decode(patternOut, 'void *')
      if (pattern) {
        const valueOut = koffi.alloc('void *', 1)
        const hrValue = slot(pattern, 4, 'long __stdcall(void *self, void **retVal)')(valueOut)
        if (hrValue >= 0) value = takeBstr(api, koffi.decode(valueOut, 'void *'))
        const readOnlyOut = koffi.alloc('int', 1)
        const hrReadOnly = slot(pattern, 5, 'long __stdcall(void *self, int *retVal)')(
          readOnlyOut
        )
        if (hrReadOnly >= 0) readOnly = (koffi.decode(readOnlyOut, 'int') as number) !== 0
      }
    }

    const clipped = value.length > maxChars ? value.slice(-maxChars) : value
    return {
      controlType: CONTROL_TYPES[controlTypeId] ?? 'unknown',
      controlTypeId,
      className,
      automationId,
      name,
      value: clipped,
      valueTruncated: clipped.length !== value.length,
      readOnly
    }
  } catch {
    return null
  } finally {
    release(pattern)
    release(element)
    release(automation)
  }
}
