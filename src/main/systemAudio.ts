/**
 * System-wide mute of the playback endpoint while a take records (OPT-09).
 *
 * The reference client ships this as a first-class setting; we skipped it for a
 * long time because it needs CoreAudio, and the honest reason it is safe to add
 * now is that it is *observable and reversible*: we read the current mute state
 * first, mute the default render endpoint, and restore the state we found. If
 * anything in the chain refuses, the feature reports itself unavailable and
 * dictation is unaffected — the worst case is the old behaviour (nothing muted).
 *
 * What this mutes: the default *playback* device. Recording happens on the input
 * device, so the microphone keeps working. Muting per-application sessions would
 * be stricter (music stops but the app's own UI sounds keep playing); that needs
 * `IAudioSessionManager2` enumeration for little extra user value, so it is not
 * attempted here.
 *
 * Bindings are created on first use, never at import time, so unit tests can
 * import this module outside a Windows audio session.
 */
import koffi from 'koffi'

/** A koffi type handle; the interface is not exported by the package. */
type KoffiType = ReturnType<typeof koffi.proto>

/** Pointer size on every platform Electron ships for Windows. */
const PTR = 8

/** `CoInitializeEx` flags: multithreaded apartment. */
const COINIT_MULTITHREADED = 0x2
/** `CLSCTX_ALL`. */
const CLSCTX_ALL = 0x17
/** `EDataFlow::eRender`, `ERole::eMultimedia`. */
const FLOW_RENDER = 0
const ROLE_MULTIMEDIA = 1

/** COM vtable slots, counting the three `IUnknown` methods. */
const VT_RELEASE = 2
const VT_GET_DEFAULT_ENDPOINT = 4
const VT_ACTIVATE = 3
const VT_SET_MUTE = 14
const VT_GET_MUTE = 15

const CLSID_MM_DEVICE_ENUMERATOR = '{BCDE0395-E52F-467C-8E3D-C4579291692E}'
const IID_IMM_DEVICE_ENUMERATOR = '{A95664D2-9614-4F35-A746-DE8DB63617E6}'
const IID_IAUDIO_ENDPOINT_VOLUME = '{5CDF2C82-841E-4546-9722-0CF74078229A}'

interface Ole32 {
  CoInitializeEx(reserved: unknown, flags: number): number
  CoCreateInstance(clsid: Buffer, outer: unknown, ctx: number, iid: Buffer, out: Buffer): number
  CLSIDFromString(text: string, out: Buffer): number
}

interface Bindings {
  ole32: Ole32
  getDefaultEndpoint: KoffiType
  activate: KoffiType
  release: KoffiType
  getMute: KoffiType
  setMute: KoffiType
}

let bindings: Bindings | null | undefined

function guid(text: string, ole32: Ole32): Buffer | null {
  const out = Buffer.alloc(16)
  if (ole32.CLSIDFromString(text, out) !== 0) return null
  return out
}

/** Reads a COM method pointer out of an interface's vtable. */
function method(iface: unknown, index: number): unknown {
  const vtable = koffi.decode(iface, 'void *')
  return koffi.decode(vtable, index * PTR, 'void *')
}

function connect(): Bindings | null {
  if (bindings !== undefined) return bindings
  bindings = null
  try {
    const ole32 = koffi.load('ole32.dll')
    const lib = {
      CoInitializeEx: ole32.func('long CoInitializeEx(void *reserved, uint32 flags)'),
      CoCreateInstance: ole32.func(
        'long CoCreateInstance(const void *clsid, void *outer, uint32 ctx, const void *iid, void *out)'
      ),
      CLSIDFromString: ole32.func('long CLSIDFromString(str16 text, void *out)')
    }
    // The main process is already COM-initialised by Electron; S_FALSE (1) and
    // RPC_E_CHANGED_MODE both mean "usable as-is".
    lib.CoInitializeEx(null, COINIT_MULTITHREADED)
    bindings = {
      ole32: lib,
      getDefaultEndpoint: koffi.proto(
        'long GetDefaultAudioEndpoint(void *self, int dataFlow, int role, void *out)'
      ),
      activate: koffi.proto(
        'long Activate(void *self, const void *iid, uint32 ctx, void *params, void *out)'
      ),
      release: koffi.proto('uint32 Release(void *self)'),
      getMute: koffi.proto('long GetMute(void *self, void *out, void *context)'),
      setMute: koffi.proto('long SetMute(void *self, int mute, void *context)')
    }
  } catch {
    bindings = null
  }
  return bindings
}

/** Endpoint volume interface for the default playback device, or null. */
function endpointVolume(bind: Bindings): unknown | null {
  const clsid = guid(CLSID_MM_DEVICE_ENUMERATOR, bind.ole32)
  const iidEnum = guid(IID_IMM_DEVICE_ENUMERATOR, bind.ole32)
  if (!clsid || !iidEnum) return null
  const out = Buffer.alloc(PTR)
  const hr = bind.ole32.CoCreateInstance(clsid, null, CLSCTX_ALL, iidEnum, out)
  if (hr !== 0) return null
  const enumerator = koffi.decode(out, 0, 'void *')
  if (!enumerator) return null

  let device: unknown = null
  let volume: unknown = null
  try {
    const deviceOut = Buffer.alloc(PTR)
    const got = koffi.call(
      method(enumerator, VT_GET_DEFAULT_ENDPOINT),
      bind.getDefaultEndpoint,
      enumerator,
      FLOW_RENDER,
      ROLE_MULTIMEDIA,
      deviceOut
    )
    if (got !== 0) return null
    device = koffi.decode(deviceOut, 0, 'void *')
    if (!device) return null

    const iidVolume = guid(IID_IAUDIO_ENDPOINT_VOLUME, bind.ole32)
    if (!iidVolume) return null
    const volumeOut = Buffer.alloc(PTR)
    const activated = koffi.call(
      method(device, VT_ACTIVATE),
      bind.activate,
      device,
      iidVolume,
      CLSCTX_ALL,
      null,
      volumeOut
    )
    if (activated !== 0) return null
    volume = koffi.decode(volumeOut, 0, 'void *')
    return volume ?? null
  } finally {
    // The device is only needed to obtain the volume interface.
    if (device) {
      try {
        koffi.call(method(device, VT_RELEASE), bind.release, device)
      } catch {
        // Ignore: the meter outlives us either way.
      }
    }
  }
}

function readMute(bind: Bindings, volume: unknown): boolean | null {
  const out = Buffer.alloc(4)
  const hr = koffi.call(method(volume, VT_GET_MUTE), bind.getMute, volume, out, null)
  if (hr !== 0) return null
  return out.readInt32LE(0) !== 0
}

function writeMute(bind: Bindings, volume: unknown, muted: boolean): boolean {
  const hr = koffi.call(method(volume, VT_SET_MUTE), bind.setMute, volume, muted ? 1 : 0, null)
  return hr === 0
}

let saved: boolean | null = null

/**
 * Mutes the playback endpoint and remembers what it was.
 *
 * Returns false when the platform refuses, which the caller reports once and
 * then stops trying — a missing audio stack must never cost a take.
 */
export function muteOthers(): boolean {
  if (saved !== null) return true
  const bind = connect()
  if (!bind) return false
  const volume = endpointVolume(bind)
  if (!volume) return false
  try {
    const current = readMute(bind, volume)
    if (current === null) return false
    if (!writeMute(bind, volume, true)) return false
    saved = current
    return true
  } catch {
    return false
  } finally {
    if (volume) {
      try {
        koffi.call(method(volume, VT_RELEASE), bind.release, volume)
      } catch {
        // Ignore.
      }
    }
  }
}

/**
 * Restores the mute state that was in place before `muteOthers`.
 *
 * Restoring the *saved* state rather than unconditionally unmuting matters: a
 * user who keeps the machine muted must not have sound turned on by dictation.
 */
export function restoreOthers(): void {
  const previous = saved
  if (previous === null) return
  saved = null
  const bind = connect()
  if (!bind) return
  const volume = endpointVolume(bind)
  if (!volume) return
  try {
    writeMute(bind, volume, previous)
  } catch {
    // Nothing useful to do; the next take tries again.
  } finally {
    try {
      koffi.call(method(volume, VT_RELEASE), bind.release, volume)
    } catch {
      // Ignore.
    }
  }
}

/** True when the audio stack answered at least once on this machine. */
export function isAvailable(): boolean {
  return connect() !== null
}

/** Test seam: forget the cached bindings and the saved state. */
export function resetForTests(): void {
  bindings = undefined
  saved = null
}
