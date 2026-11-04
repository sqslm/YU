# tests/yu-v2/fixtures/uia-foreground.ps1
#
# Prints the current foreground window as hex. Used by the self-check to prove
# the fixture never takes activation: the value must be identical before the
# fixture starts and after it has published its tree.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForegroundWindow
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
'@

$hwnd = [ForegroundWindow]::GetForegroundWindow()
'0x' + $hwnd.ToInt64().ToString('X')
