# Fixed native bridge. JSON is data on stdin, never PowerShell source.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
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
  @{applications=@($items | Sort-Object -Property @{Expression={$_.name}},@{Expression={$_.path}} -Unique | Select-Object -First 1500)} | ConvertTo-Json -Depth 5 -Compress
  exit
}
if ($request.action -ne 'search') { throw 'Unknown operation' }
$root = [IO.Path]::GetFullPath([string]$request.root).TrimEnd('\')
if (!(Test-Path -LiteralPath $root -PathType Container)) { throw 'Folder does not exist' }
$indexed = @()
$backend = 'folder'
$indexUnavailable = $false
$connection = New-Object System.Data.OleDb.OleDbConnection('Provider=Search.CollatorDSO;Extended Properties="Application=Windows"')
try {
  $connection.Open()
  $scope = ('file:' + $root.Replace('\','/') + '/').Replace("'", "''")
  $where = "SCOPE='$scope' AND System.FileName IS NOT NULL"
  if ($request.name) { $value=([string]$request.name).Replace("'","''"); $where += " AND System.FileName LIKE '%$value%'" }
  if ($request.extension) { $value=([string]$request.extension).Replace("'","''"); $where += " AND System.FileExtension='.$value'" }
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
# Supplement the immediate directory: Downloads is often unindexed or indexing may lag.
# Never recursively crawl the disk as a fallback.
$direct = @(Get-ChildItem -LiteralPath $root -File -ErrorAction Stop | Select-Object -First 5001)
$paths = @($indexed) + @($direct | ForEach-Object FullName)
$files = @($paths | Select-Object -Unique | ForEach-Object {
  $item = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue
  if (!$item -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
  if ($request.name -and $item.Name.IndexOf([string]$request.name,[StringComparison]::OrdinalIgnoreCase) -lt 0) { return }
  if ($request.extension -and $item.Extension -ine ('.'+$request.extension)) { return }
  if ($request.after -and $item.LastWriteTimeUtc -lt ([DateTimeOffset]::Parse($request.after)).UtcDateTime) { return }
  if ($request.before -and $item.LastWriteTimeUtc -ge ([DateTimeOffset]::Parse($request.before)).UtcDateTime) { return }
  if ($item.Length -lt [long]$request.minBytes) { return }
  @{name=$item.Name;path=$item.FullName;bytes=$item.Length;modified=$item.LastWriteTimeUtc.ToString('o')}
})
$sort = if ($request.sort -eq 'size') { 'bytes' } else { 'modified' }
@{files=@($files | Sort-Object -Property @{Expression={$_[$sort]};Descending=$true},@{Expression={$_.path}} | Select-Object -First 40);backend=$backend;partial=($direct.Count -ge 5001 -or $indexed.Count -ge 101 -or $files.Count -gt 40);indexUnavailable=$indexUnavailable} | ConvertTo-Json -Depth 5 -Compress

