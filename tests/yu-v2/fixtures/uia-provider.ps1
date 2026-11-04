# tests/yu-v2/fixtures/uia-provider.ps1
#
# Single entry point for the synthetic UIA provider fixture. Compiles
# uia-provider.cs with csc.exe (in-box .NET Framework, no packages) and hosts it
# in this process, so the fixture's stdin/stdout are this script's own OS
# handles: JSON commands in, JSON events out, both strict UTF-8.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/yu-v2/fixtures/uia-provider.ps1 -Mode address-edit
#
# The window is created with WS_EX_NOACTIVATE and shown with SW_SHOWNOACTIVATE;
# this script never calls SetForegroundWindow/Activate and never kills processes.

[CmdletBinding()]
param(
  [ValidateSet('address-edit', 'address-combo', 'no-candidate', 'duplicate', 'ambiguous',
    'document-overrides', 'document-ambiguous', 'pseudo-address', 'password', 'offscreen',
    'no-toolbar', 'deep-40', 'deep-41', 'documents-20', 'documents-21', 'edits-100', 'edits-101',
    'provider-error', 'file-url')]
  [string]$Mode = 'address-edit',

  # Only meaningful with -Mode provider-error: which provider callback fails for real.
  [ValidateSet('none', 'get-property', 'find-children', 'root-fragment', 'host-hwnd', 'unresponsive', 'both')]
  [string]$FailStage = 'none',

  [switch]$ListModes
)

$ErrorActionPreference = 'Stop'

if ($ListModes) {
  'address-edit','address-combo','no-candidate','duplicate','ambiguous','document-overrides',
  'document-ambiguous','pseudo-address','password','offscreen','no-toolbar','deep-40','deep-41',
  'documents-20','documents-21','edits-100','edits-101','provider-error','file-url'
  return
}

if ($PSVersionTable.PSEdition -ne 'Desktop') {
  throw "This fixture needs Windows PowerShell 5.1 (.NET Framework + WPF accessibility assemblies); current edition: $($PSVersionTable.PSEdition)"
}

$fixtures = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $fixtures 'uia-provider.cs'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path -LiteralPath $source)) { throw "missing provider source: $source" }
if (-not (Test-Path -LiteralPath $csc)) { throw "missing csc.exe: $csc" }

# The DLL is built outside the repository (and named after the source timestamp) so no
# binary artifact can end up in a commit and parallel runs cannot fight over one file.
$sourceStamp = (Get-Item -LiteralPath $source).LastWriteTimeUtc.Ticks
$buildDir = Join-Path $env:TEMP 'uia-provider-fixture'
$assembly = Join-Path $buildDir "uia-provider-$sourceStamp.dll"

Add-Type -AssemblyName UIAutomationProvider, UIAutomationTypes, UIAutomationClient, WindowsBase
$wanted = 'UIAutomationProvider', 'UIAutomationTypes', 'UIAutomationClient', 'WindowsBase'
$references = @(
  [AppDomain]::CurrentDomain.GetAssemblies() |
    Where-Object { $wanted -contains $_.GetName().Name } |
    ForEach-Object { $_.Location } |
    Where-Object { $_ } |
    Select-Object -Unique
)
if ($references.Count -lt 3) { throw "could not resolve UIA/WPF reference assemblies: $($references -join ', ')" }

$rebuild = -not (Test-Path -LiteralPath $assembly)
if ($rebuild) {
  if (-not (Test-Path -LiteralPath $buildDir)) { [void](New-Item -ItemType Directory -Path $buildDir -Force) }
  $arguments = @('/nologo', '/target:library', '/optimize+', '/platform:anycpu', '/utf8output', "/out:$assembly") +
    @($references | ForEach-Object { "/r:$_" }) + @($source)
  $output = & $csc $arguments 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    $output | ForEach-Object { [Console]::Error.WriteLine($_) }
    throw "csc.exe failed with exit code $code"
  }
  if ($output) { $output | ForEach-Object { [Console]::Error.WriteLine($_) } }
}

Add-Type -Path $assembly
$exit = [UiaProviderFixture.Program]::Run($Mode, $FailStage)
exit $exit
