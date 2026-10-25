# Fixed native bridge. JSON is data on stdin, never PowerShell source.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.action -eq 'system-volume') { . (Join-Path $PSScriptRoot 'system-volume.ps1'); exit 0 }
if ($request.action -eq 'recent-files') {
  $recent = [Environment]::GetFolderPath('Recent')
  $shell = New-Object -ComObject WScript.Shell
  try {
    $files = @(Get-ChildItem -LiteralPath $recent -Filter '*.lnk' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 300 | ForEach-Object {
      $shortcut = $shell.CreateShortcut($_.FullName)
      if ($shortcut.TargetPath) { @{path=$shortcut.TargetPath;recordedAt=$_.LastWriteTimeUtc.ToString('o');source='Windows Recent'} }
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
    })
    @{files=$files;source='Windows Recent'} | ConvertTo-Json -Depth 4 -Compress
  } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
  exit 0
}
if ($request.action -eq 'ocr') {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
  [void][Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  [void][Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  [void][Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  function Await-Result($operation, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.Wait()
    return $task.Result
  }
  [void][Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
  $engine = $null
  # The Chinese recognizer also reads Latin text. Prefer it for mixed Chinese/English screenshots.
  $language = [string]$request.language
  if (!$language -or $language -eq 'auto') { $language = 'zh' }
  $recognizer = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object { $_.LanguageTag -like "$language*" } | Select-Object -First 1
  if ($recognizer) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($recognizer) }
  elseif ($request.language -and $request.language -ne 'auto') { throw 'Requested Windows OCR language pack is not installed' }
  if (!$engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (!$engine) { throw 'Windows OCR language support is unavailable' }
  $bytes = [Convert]::FromBase64String([string]$request.png)
  if (!$bytes.Length -or $bytes.Length -gt 6291456) { throw 'Invalid OCR image size' }
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
  $bitmap = $null
  try {
    $writer.WriteBytes($bytes)
    [void](Await-Result ($writer.StoreAsync()) ([uint32]))
    [void]$writer.DetachStream()
    $stream.Seek(0)
    $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    if ($bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'Image exceeds Windows OCR dimensions' }
    $result = Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($result.Lines | ForEach-Object {
      $ocrLine = $_
      $line = $_.Text -replace '([\p{IsCJKUnifiedIdeographs}])\s+(?=[\p{IsCJKUnifiedIdeographs}])', '$1'
      $line = $line -replace '\s+([\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A\u3001\uFF09\u300B\u3011\u300D\u300F])', '$1'
      $line = $line -replace '([\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A\u3001\uFF08\u300A\u3010\u300C\u300E])\s+', '$1'
      $words = @($ocrLine.Words)
      if ($words.Count -gt 0 -and $line.Trim()) {
        $left = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
        $top = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
        $right = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
        $bottom = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
        @{text=$line.Trim();x=$left;y=$top;width=($right-$left);height=($bottom-$top)}
      }
    })
    @{text=(($lines | ForEach-Object { $_.text }) -join "`n");lines=$lines;width=$bitmap.PixelWidth;height=$bitmap.PixelHeight;language=$engine.RecognizerLanguage.LanguageTag} | ConvertTo-Json -Compress -Depth 5
  } finally { if ($bitmap) { $bitmap.Dispose() }; $writer.Dispose(); $stream.Dispose() }
  exit
}
if ($request.action -in @('explorer-folder','browser-url','window-check')) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class YUWindow {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
}
'@
  function Assert-OriginalWindow {
    if ([string]$request.handle -notmatch '^\d+$' -or [long]$request.handle -le 0) { throw 'Original window is unavailable' }
    $script:hwnd = [IntPtr][long]$request.handle
    [uint32]$windowPid = 0
    [void][YUWindow]::GetWindowThreadProcessId($script:hwnd, [ref]$windowPid)
    $title = New-Object Text.StringBuilder 1024
    [void][YUWindow]::GetWindowText($script:hwnd, $title, 1024)
    if (![YUWindow]::IsWindow($script:hwnd) -or $windowPid -ne [uint32]$request.pid -or $title.ToString() -cne [string]$request.title) { throw 'Original window has changed or closed' }
  }
  Assert-OriginalWindow
  if ($request.action -eq 'window-check') {
    if ([YUWindow]::IsIconic($hwnd)) { throw 'Original window is minimized; restore it before capture' }
    @{valid=$true} | ConvertTo-Json -Compress
    exit
  }
  if ($request.action -eq 'explorer-folder') {
    $shell = New-Object -ComObject Shell.Application
    $windows = $shell.Windows()
    try {
      $folders = @($windows | Where-Object { [long]$_.HWND -eq [long]$request.handle } | ForEach-Object { $_.Document.Folder.Self.Path } | Sort-Object -Unique)
      Assert-OriginalWindow
      @{folder=$(if ($folders.Count -eq 1 -and [IO.Directory]::Exists($folders[0])) { $folders[0] } else { $null })} | ConvertTo-Json -Compress
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($windows); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
    exit
  }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $element = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $edits = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
  $urls = New-Object System.Collections.Generic.List[string]
  foreach ($edit in $edits | Select-Object -First 100) {
    if ($edit.Current.IsPassword -or $edit.Current.IsOffscreen) { continue }
    if ($edit.Current.AutomationId -notmatch '^(?:addressEditBox|urlbar-input|urlbar)$' -and $edit.Current.Name -notmatch '\u5730\u5740|\u7db2\u5740|address|search or enter|\u641c\u7d22\u6216\u8f93\u5165|\u641c\u5c0b\u6216\u8f38\u5165') { continue }
    # Only browser chrome under a toolbar; never a page's similarly named form field.
    $ancestor = $edit; $toolbar = $false
    for ($depth=0; $depth -lt 12; $depth++) {
      $ancestor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
      if (!$ancestor -or $ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { break }
      if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::ToolBar) { $toolbar=$true; break }
    }
    if (!$toolbar) { continue }
    $pattern = $null
    if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      $value = ([System.Windows.Automation.ValuePattern]$pattern).Current.Value
      if ($value -match '^https?://') { $urls.Add($value) }
    }
  }
  Assert-OriginalWindow
  $unique = @($urls | Select-Object -Unique)
  @{url=$(if ($unique.Count -eq 1) { $unique[0] } else { $null })} | ConvertTo-Json -Compress
  exit
}
if ($request.action -eq 'disk-space') {
  $drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -in @('Fixed','Removable') } | ForEach-Object {
    @{name=$_.Name;label=$_.VolumeLabel;totalBytes=$_.TotalSize;freeBytes=$_.AvailableFreeSpace;usedBytes=($_.TotalSize-$_.AvailableFreeSpace)}
  })
  @{drives=$drives} | ConvertTo-Json -Depth 5 -Compress
  exit
}
if ($request.action -eq 'activate') {
  $appId = [string]$request.appId
  $target = if ($appId -eq 'system:settings') { 'ms-settings:' } else {
    $registered = @(Get-StartApps | Where-Object { $_.AppID -ceq $appId })
    if ($registered.Count -ne 1) { throw 'Registered app is no longer available' }
    'shell:AppsFolder\' + $registered[0].AppID
  }
  $shell = New-Object -ComObject Shell.Application
  try { $shell.ShellExecute($target) } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
  @{activated=$true} | ConvertTo-Json -Compress
  exit
}
if ($request.action -eq 'applications') {
  $items = New-Object System.Collections.Generic.List[object]
  foreach ($base in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
    if (!(Test-Path -LiteralPath $base)) { continue }
    foreach ($key in Get-ChildItem -LiteralPath $base) {
      $target = [Environment]::ExpandEnvironmentVariables([string]$key.GetValue('')).Trim('"')
      if ($target -match '^[^"<>|\x00-\x1f]+\.exe$' -and (Test-Path -LiteralPath $target -PathType Leaf)) {
        $items.Add(@{name=($key.PSChildName -replace '\.exe$', ''); path=$target})
      }
    }
  }
  $ws = New-Object -ComObject WScript.Shell
  try {
    foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))) {
      if (!(Test-Path -LiteralPath $folder)) { continue }
      foreach ($link in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1000) {
        $shortcut = $ws.CreateShortcut($link.FullName)
        $target = [Environment]::ExpandEnvironmentVariables($shortcut.TargetPath)
        # Do not offer links with command-line arguments: scripts/installers must not be smuggled through a link.
        if (!$shortcut.Arguments -and $target -match '^[^"<>|\x00-\x1f]+\.exe$' -and (Test-Path -LiteralPath $target -PathType Leaf)) {
          $items.Add(@{name=$link.BaseName; path=$target})
        }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
      }
    }
  } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($ws) }
  foreach ($registered in Get-StartApps) {
    # Packaged applications have real AUMIDs, not conventional executable paths.
    if ($registered.AppID -match '!') { $items.Add(@{name=$registered.Name;path='';appId=$registered.AppID}) }
  }
  $items.Add(@{name='Windows Settings';path='';appId='system:settings'})
  foreach ($commandName in @('explorer.exe','notepad.exe','calc.exe')) {
    $command = Get-Command $commandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $packaged = if ($commandName -eq 'calc.exe') { 'Microsoft.WindowsCalculator_' } elseif ($commandName -eq 'notepad.exe') { 'Microsoft.WindowsNotepad_' } else { '^$' }
    if ($command -and ($commandName -eq 'explorer.exe' -or !($items | Where-Object { $_.appId -match $packaged }))) {
      $name = if ($commandName -eq 'calc.exe') { 'Calculator' } else { $commandName -replace '\.exe$','' }
      $items.Add(@{name=$name;path=$command.Source})
    }
  }
  @{applications=@($items | Sort-Object -Property @{Expression={$_.name}},@{Expression={$_.path}} -Unique | Select-Object -First 1500)} | ConvertTo-Json -Depth 5 -Compress
  exit
}
if ($request.action -ne 'search') { throw 'Unknown operation' }
$root = [IO.Path]::GetFullPath([string]$request.root).TrimEnd('\')
if (!(Test-Path -LiteralPath $root -PathType Container)) { throw 'Folder does not exist' }
$indexed = @()
$backend = 'folder'
$indexUnavailable = $false
$extensions = @($request.extensions | Where-Object { $_ })
if (!$extensions.Count -and $request.extension) { $extensions = @([string]$request.extension) }
$connection = New-Object System.Data.OleDb.OleDbConnection('Provider=Search.CollatorDSO;Extended Properties="Application=Windows"')
try {
  $connection.Open()
  $scope = ('file:' + $root.Replace('\','/') + '/').Replace("'", "''")
  $where = "SCOPE='$scope' AND System.FileName IS NOT NULL"
  if ($request.name) { $value=([string]$request.name).Replace("'","''"); $where += " AND System.FileName LIKE '%$value%'" }
  if ($extensions.Count) {
    $extensionFilter = @($extensions | ForEach-Object { "System.FileExtension='." + ([string]$_).Replace("'","''") + "'" }) -join ' OR '
    $where += " AND ($extensionFilter)"
  }
  foreach ($field in @('after','before')) {
    if ($request.$field) {
      $value = ([DateTimeOffset]::Parse($request.$field)).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
      $op = if ($field -eq 'after') { '>=' } else { '<' }
      $where += " AND System.DateModified $op '$value'"
    }
  }
  if ($request.minBytes) { $where += ' AND System.Size >= ' + [long]$request.minBytes }
  $order = if ($request.sort -eq 'size') { 'System.Size DESC' } else { 'System.DateModified DESC' }
  $command = $connection.CreateCommand()
  $command.CommandTimeout = 8
  $command.CommandText = "SELECT TOP 101 System.ItemPathDisplay FROM SystemIndex WHERE $where ORDER BY $order"
  $reader = $command.ExecuteReader()
  try { while ($reader.Read()) { $indexed += [string]$reader.GetValue(0) } } finally { $reader.Dispose(); $command.Dispose() }
  $backend = 'windows-search+folder'
} catch { $indexUnavailable = $true } finally { $connection.Dispose() }
# Optional fallback traversal is bounded, cancellable with the process, and skips junctions.
$direct = New-Object System.Collections.Generic.List[object]
$queue = New-Object System.Collections.Generic.Queue[object]
$queue.Enqueue(@{path=$root;depth=0})
$clock = [Diagnostics.Stopwatch]::StartNew()
$scanned = 0
$bounded = $false
while ($queue.Count -gt 0) {
  if ($scanned -ge 5000 -or $clock.ElapsedMilliseconds -ge 5000) { $bounded=$true; break }
  $folder = $queue.Dequeue()
  foreach ($item in Get-ChildItem -LiteralPath $folder.path -ErrorAction SilentlyContinue | Select-Object -First (5001-$scanned)) {
    $scanned++
    if ($scanned -gt 5000 -or $clock.ElapsedMilliseconds -ge 5000) { $bounded=$true; break }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    if (!$item.PSIsContainer) { $direct.Add($item) }
    elseif ($request.recursive -eq $true) {
      if ($folder.depth -lt 3) { $queue.Enqueue(@{path=$item.FullName;depth=($folder.depth+1)}) } else { $bounded=$true }
    }
  }
}
$clock.Stop()
$paths = @($indexed) + @($direct | ForEach-Object FullName)
$files = @($paths | Select-Object -Unique | ForEach-Object {
  $item = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue
  if (!$item -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
  if ($request.name -and $item.Name.IndexOf([string]$request.name,[StringComparison]::OrdinalIgnoreCase) -lt 0) { return }
  if ($extensions.Count -and $item.Extension.TrimStart('.') -notin $extensions) { return }
  if ($request.after -and $item.LastWriteTimeUtc -lt ([DateTimeOffset]::Parse($request.after)).UtcDateTime) { return }
  if ($request.before -and $item.LastWriteTimeUtc -ge ([DateTimeOffset]::Parse($request.before)).UtcDateTime) { return }
  if ($item.Length -lt [long]$request.minBytes) { return }
  @{name=$item.Name;path=$item.FullName;bytes=$item.Length;modified=$item.LastWriteTimeUtc.ToString('o')}
})
$sort = if ($request.sort -eq 'size') { 'bytes' } else { 'modified' }
@{files=@($files | Sort-Object -Property @{Expression={$_[$sort]};Descending=$true},@{Expression={$_.path}} | Select-Object -First 40);backend=$backend;partial=($bounded -or $indexed.Count -ge 101 -or $files.Count -gt 40);indexUnavailable=$indexUnavailable} | ConvertTo-Json -Depth 5 -Compress

