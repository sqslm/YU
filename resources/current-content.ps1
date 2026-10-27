# Runs inside windows-tools.ps1 after the frozen HWND/PID/title check.
# Accessibility and Office reads never change focus, selection or the clipboard.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$limit = 48000
$result = @{ title=[string]$request.title; truncated=$false }
$process = Get-Process -Id ([int]$request.pid)

function Finish-Content {
  Assert-OriginalWindow
  $result | ConvertTo-Json -Compress -Depth 4
}

if ($request.action -eq 'current-content' -and $process.ProcessName -eq 'explorer') {
  $shell = New-Object -ComObject Shell.Application
  $windows = $shell.Windows()
  try {
    $paths = @($windows | Where-Object { [long]$_.HWND -eq [long]$request.handle } | ForEach-Object { $_.Document.SelectedItems() } | ForEach-Object { $_.Path } | Sort-Object -Unique)
    if ($paths.Count -eq 1 -and [IO.File]::Exists($paths[0])) { $result.path=$paths[0] }
    Finish-Content
  } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($windows); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
  return
}

# Office exposes a real document path and unsaved text. Bind the COM object to
# this exact top-level window, not another application's most recent document.
if ($request.action -eq 'current-content' -and $process.ProcessName -match '^(WINWORD|EXCEL|POWERPNT)$') {
  $office = $null
  try {
    $progId = @{WINWORD='Word.Application';EXCEL='Excel.Application';POWERPNT='PowerPoint.Application'}[$process.ProcessName.ToUpperInvariant()]
    $office = [Runtime.InteropServices.Marshal]::GetActiveObject($progId)
    $officeHwnd = if ($process.ProcessName -eq 'WINWORD') { $office.ActiveWindow.Hwnd } elseif ($process.ProcessName -eq 'EXCEL') { $office.Hwnd } else { $office.HWND }
    if ([YUWindow]::GetAncestor([IntPtr][long]$officeHwnd, 2) -eq $hwnd) {
      $document = if ($process.ProcessName -eq 'WINWORD') { $office.ActiveDocument } elseif ($process.ProcessName -eq 'EXCEL') { $office.ActiveWorkbook } else { $office.ActivePresentation }
      $path = [string]$document.FullName
      if ($request.expectedPath -and [IO.Path]::GetFullPath($path) -ine [IO.Path]::GetFullPath([string]$request.expectedPath)) { throw 'Original Office document path has changed' }
      if ([IO.Path]::IsPathRooted($path) -and [IO.File]::Exists($path)) { $result.path=$path }
      $result.editor=$true
      if ($request.metadataOnly) { Finish-Content; return }
      if ($process.ProcessName -eq 'WINWORD') {
        $end = [Math]::Min([int]$document.Content.End, $limit+1)
        $body = [string]$document.Range(0,$end).Text
        $result.text=$body.Substring(0,[Math]::Min($limit,$body.Length))
        $result.truncated=[int]$document.Content.End -gt $limit
      } elseif ($process.ProcessName -eq 'EXCEL') {
        $body=New-Object Text.StringBuilder
        foreach ($sheet in $document.Worksheets) {
          [void]$body.AppendLine(('[' + $sheet.Name + '] (raw cell values)'))
          $used=$sheet.UsedRange
          $rows=[Math]::Min(1000,[int]$used.Rows.Count); $cols=[Math]::Min(100,[int]$used.Columns.Count)
          $firstRow=[int]$used.Row; $firstCol=[int]$used.Column
          $range=$sheet.Range($sheet.Cells.Item($firstRow,$firstCol),$sheet.Cells.Item($firstRow+$rows-1,$firstCol+$cols-1))
          $values=$range.Value2
          for ($row=1; $row -le $rows -and $body.Length -le $limit; $row++) {
            for ($col=1; $col -le $cols -and $body.Length -le $limit; $col++) {
              $value=if ($values -is [Array]) { $values.GetValue($row,$col) } else { $values }
              if ($null -ne $value) { [void]$body.Append(('R' + ($firstRow+$row-1) + 'C' + ($firstCol+$col-1) + ': ' + [string]$value + "`t")) }
            }
            [void]$body.AppendLine()
          }
          if ($rows -lt [int]$used.Rows.Count -or $cols -lt [int]$used.Columns.Count -or $body.Length -gt $limit) { $result.truncated=$true; break }
        }
        $result.text=$body.ToString().Substring(0,[Math]::Min($limit,$body.Length))
      } elseif ($process.ProcessName -eq 'POWERPNT') {
        $body=New-Object Text.StringBuilder
        foreach ($slide in $document.Slides) {
          [void]$body.AppendLine(('[' + $slide.SlideIndex + ']'))
          foreach ($shape in $slide.Shapes) {
            if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { [void]$body.AppendLine([string]$shape.TextFrame.TextRange.Text) }
            if ($body.Length -gt $limit) { break }
          }
          if ($body.Length -gt $limit) { break }
        }
        $result.text=$body.ToString().Substring(0,[Math]::Min($limit,$body.Length))
        # Slides can contain tables, diagrams or images not exposed as text.
        $result.truncated=$true
      }
    }
  } catch [Runtime.InteropServices.COMException] {
    # A different Office instance or a protected document may not expose COM.
    # Continue with the original window's accessibility document, never open it.
  } finally { if ($office) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($office) } }
  if ($result.text -or $result.path) { Finish-Content; return }
}
if ($request.expectedPath) { throw 'Original Office document is no longer available' }

$element = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$documents = @($element.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document))) | Where-Object { !$_.Current.IsOffscreen } | Select-Object -First 20)
$addresses = New-Object System.Collections.Generic.List[string]
$editCondition = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ComboBox)))
$edits = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
foreach ($edit in $edits | Select-Object -First 100) {
  if ($edit.Current.IsPassword -or $edit.Current.IsOffscreen) { continue }
  if ($edit.Current.AutomationId -notmatch '^(?:addressEditBox|urlbar-input|urlbar|omnibox)$' -and $edit.Current.Name -notmatch '\u5730\u5740|\u7db2\u5740|address|search or enter|\u641c\u7d22\u6216\u8f93\u5165|\u641c\u5c0b\u6216\u8f38\u5165') { continue }
  $ancestor=$edit; $toolbar=$false; $chrome=$false
  for ($depth=0; $depth -lt 40; $depth++) {
    $ancestor=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
    if (!$ancestor -or $ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { break }
    if ($ancestor.Equals($element)) { $chrome=$true; break }
    if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::ToolBar) { $toolbar=$true }
  }
  if (!$toolbar -or !$chrome) { continue }
  $pattern=$null
  if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) {
    $value=([System.Windows.Automation.ValuePattern]$pattern).Current.Value
    if ($value) { $addresses.Add($value) }
  }
}
$unique=@($addresses | Select-Object -Unique)
if ($unique.Count -eq 1) { $result.url=$unique[0] }

# Firefox and Chromium can expose the unelided URL as the document's own Value.
# This is a native Document property, never a page's editable form field.
$documentUrls=@(@(foreach ($doc in $documents) {
  if ($request.metadataOnly -and !$result.url) { continue }
  $pattern=$null
  if ($doc.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) {
    $value=([System.Windows.Automation.ValuePattern]$pattern).Current.Value
    if ($value -match '^(?:https?|file)://') { $value }
  }
}) | Select-Object -Unique)
if ($documentUrls.Count -eq 1) { $result.url=$documentUrls[0] }
if ($result.url -match '^file://') {
  $local = ([uri]$result.url).LocalPath
  if ([IO.File]::Exists($local)) { $result.path=$local; $result.Remove('url') }
}
if ($request.action -eq 'browser-url') { Finish-Content; return }
if ($request.metadataOnly -and !$result.url) { $result.document=$true; Finish-Content; return }

# Only document/edit controls expose body text. Never scrape the whole window's
# controls, passwords, sidebars or unrelated app chrome as the document.
$bodies=New-Object System.Collections.Generic.List[object]
foreach ($doc in $documents) {
  $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($doc)
  $nested=$false
  for ($depth=0; $parent -and $depth -lt 15; $depth++) {
    if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { $nested=$true; break }
    $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
  }
  if ($nested) { continue }
  $pattern=$null
  if ($doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) {
    $body=([System.Windows.Automation.TextPattern]$pattern).DocumentRange.GetText($limit+1)
    if ($body.Trim()) { $bodies.Add(@{text=$body;name=$doc.Current.Name}) }
  } elseif ($result.url) {
    # Some Chromium variants do not expose TextPattern but do expose static
    # document text nodes. Ignore control labels and editable/password fields.
    $nodes=$doc.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text)))
    $body=New-Object Text.StringBuilder
    foreach ($node in $nodes | Select-Object -First 5000) {
      if (!$node.Current.IsPassword -and $node.Current.Name) { [void]$body.AppendLine($node.Current.Name) }
      if ($body.Length -gt $limit) { break }
    }
    if ($body.Length) { $bodies.Add(@{text=$body.ToString();name=$doc.Current.Name}); $result.truncated=$true }
  }
}
if (!$bodies.Count -and !$result.url -and !$result.path) {
  # Plain editors such as Notepad may use an Edit rather than Document control.
  foreach ($edit in $edits | Select-Object -First 100) {
    if ($edit.Current.IsPassword -or $edit.Current.IsOffscreen) { continue }
    $pattern=$null
    if ($edit.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) {
      $body=([System.Windows.Automation.TextPattern]$pattern).DocumentRange.GetText($limit+1)
      if ($body.Trim()) { $bodies.Add(@{text=$body;name=$edit.Current.Name}) }
    }
  }
}
if ($bodies.Count -eq 1) {
  $body=[string]$bodies[0].text
  $result.text=$body.Substring(0,[Math]::Min($limit,$body.Length))
  $result.truncated=$body.Length -gt $limit
}
Finish-Content
