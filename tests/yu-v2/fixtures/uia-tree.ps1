# tests/yu-v2/fixtures/uia-tree.ps1
#
# Reads the fixture's UIA tree through the real cross-process UI Automation
# stack and prints one JSON object per element (one line each).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/yu-v2/fixtures/uia-tree.ps1 -Handle 0x1234
#
# Callers MUST bound this call (Start-Job -Timeout / spawn timeout): a provider
# that stops pumping messages blocks any UIA read forever, and this script has no
# way to interrupt a stuck COM call from inside the same thread.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Handle,

  [int]$MaxDepth = 48
)

$ErrorActionPreference = 'Stop'
# Callers read this output as UTF-8; the default console encoding mangles non-ASCII names.
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$hwnd = [IntPtr][Convert]::ToInt64($Handle, 16)
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker

function Write-Element {
  param($Element, [int]$Depth, [string]$Path)

  $current = $Element.Current
  $value = $null
  $hasValue = $false
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $pattern) {
      $hasValue = $true
      $value = $pattern.Current.Value
    }
  } catch {
    $hasValue = $false
  }

  $typeName = $current.ControlType.ProgrammaticName
  if ($typeName -like 'ControlType.*') { $typeName = $typeName.Substring('ControlType.'.Length) }

  [ordered]@{
    path        = $Path
    depth       = $Depth
    controlType = $typeName
    name        = $current.Name
    automationId = $current.AutomationId
    isOffscreen = $current.IsOffscreen
    isPassword  = $current.IsPassword
    hasValue    = $hasValue
    value       = $value
  } | ConvertTo-Json -Compress

  if ($Depth -ge $MaxDepth) { return }

  $child = $walker.GetFirstChild($Element)
  $index = 0
  while ($null -ne $child) {
    $label = if ($child.Current.AutomationId) {
      $child.Current.AutomationId
    } elseif ($child.Current.Name) {
      $child.Current.Name
    } else {
      "child$index"
    }
    Write-Element -Element $child -Depth ($Depth + 1) -Path "$Path/$label"
    $child = $walker.GetNextSibling($child)
    $index++
  }
}

Write-Element -Element $root -Depth 0 -Path 'root'
