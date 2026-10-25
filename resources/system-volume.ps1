# Fixed Core Audio endpoint operations; the caller provides JSON data only.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YuSystemVolume {
 [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
 [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IEnumerator {
  int EnumAudioEndpoints(int flow,int mask,out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow,int role,out IDevice device);
 }
 [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice {
  [PreserveSig] int Activate(ref Guid id,int context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)] out object instance);
 }
 [ComImport,Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr client); [PreserveSig] int UnregisterControlChangeNotify(IntPtr client); [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float value,ref Guid context); [PreserveSig] int SetMasterVolumeLevelScalar(float value,ref Guid context);
  [PreserveSig] int GetMasterVolumeLevel(out float value); [PreserveSig] int GetMasterVolumeLevelScalar(out float value);
  [PreserveSig] int SetChannelVolumeLevel(uint channel,float value,ref Guid context); [PreserveSig] int SetChannelVolumeLevelScalar(uint channel,float value,ref Guid context);
  [PreserveSig] int GetChannelVolumeLevel(uint channel,out float value); [PreserveSig] int GetChannelVolumeLevelScalar(uint channel,out float value);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool value,ref Guid context); [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool value);
 }
 public static object ReadWrite(int? volume,bool? mute) {
  var enumerator=(IEnumerator)new Enumerator(); IDevice device=null; object instance=null;
  try {
   Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0,1,out device));
   var id=typeof(IVolume).GUID; Marshal.ThrowExceptionForHR(device.Activate(ref id,23,IntPtr.Zero,out instance));
   var endpoint=(IVolume)instance; var context=Guid.Empty;
   if(volume.HasValue) { if(volume<0||volume>100)throw new ArgumentOutOfRangeException("volume"); Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(volume.Value/100f,ref context)); }
   if(mute.HasValue)Marshal.ThrowExceptionForHR(endpoint.SetMute(mute.Value,ref context));
   float level;bool muted;Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out level));Marshal.ThrowExceptionForHR(endpoint.GetMute(out muted));
   return new {volume=(int)Math.Round(level*100),muted=muted};
  } finally {if(instance!=null)Marshal.ReleaseComObject(instance);if(device!=null)Marshal.ReleaseComObject(device);Marshal.ReleaseComObject(enumerator);}
 }
}
'@
$taskVolume=$null
$taskMute=$null
if($null -ne $request.volume){$taskVolume=[int]$request.volume;if($taskVolume -lt 0 -or $taskVolume -gt 100){throw 'Volume must be 0-100'}}
if($null -ne $request.muted){$taskMute=[bool]$request.muted}
[YuSystemVolume]::ReadWrite($taskVolume,$taskMute)|ConvertTo-Json -Compress
