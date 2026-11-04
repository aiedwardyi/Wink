param([ValidateSet('Snapshot', 'Cleanup', 'Progress')][string]$Mode, [string]$Manifest, [string]$Log)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

if ($Mode -eq 'Snapshot') {
  $rows = @(Get-CimInstance Win32_Process | ForEach-Object {
    if ($_.CreationDate) {
      @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; exe = $_.ExecutablePath;
         created = [string]$_.CreationDate.ToUniversalTime().Ticks; command = $_.CommandLine }
    }
  })
  ConvertTo-Json -InputObject $rows -Compress
  exit
}

$request = Get-Content -Raw -Encoding UTF8 -LiteralPath $Manifest | ConvertFrom-Json
if ($Mode -eq 'Cleanup') {
  $allowed = @('orbit.exe', 'openconsole.exe', 'conhost.exe', 'node.exe', 'pwsh.exe', 'powershell.exe', 'cloudflared.exe')
  $prefix = [IO.Path]::GetDirectoryName($request.root.exe).TrimEnd('\') + '\'
  $tree = @{}
  $tree[[int]$request.root.pid] = $request.root
  foreach ($row in $request.tree) { $tree[[int]$row.pid] = $row }
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class UpdateProcess { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle, uint code); }'
  foreach ($saved in $request.targets) {
    if ($saved.pid -eq $request.root.pid -or $allowed -inotcontains $saved.name -or !$saved.exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $ancestor = $saved
    $seen = @{}
    while ($ancestor.pid -ne $request.root.pid) {
      if ($seen[[int]$ancestor.pid]) { $ancestor = $null; break }
      $seen[[int]$ancestor.pid] = $true
      $parent = $tree[[int]$ancestor.ppid]
      if (!$parent -or [long]$ancestor.created -lt [long]$parent.created) { $ancestor = $null; break }
      $ancestor = $parent
    }
    if (!$ancestor) { continue }
    $target = $null
    try {
      $target = [Diagnostics.Process]::GetProcessById([int]$saved.pid)
      $handle = $target.Handle
      $ticks = $target.StartTime.ToUniversalTime().Ticks
      $ticks -= $ticks % 10
      $live = Get-CimInstance Win32_Process -Filter "ProcessId = $($saved.pid)"
      if (!$live -or $ticks -ne [long]$saved.created -or $live.Name -ine $saved.name -or $live.ParentProcessId -ne $saved.ppid -or $live.ExecutablePath -ine $saved.exe) {
        @{ kind = 'update-cleanup-skipped'; pid = $saved.pid; reason = 'process identity changed' } | ConvertTo-Json -Compress | Add-Content -LiteralPath $Log -Encoding UTF8
        continue
      }
      $entry = @{ at = [DateTime]::UtcNow.ToString('o'); kind = 'update-cleanup'; pid = $saved.pid; name = $saved.name; ppid = $saved.ppid; created = $saved.created; exe = $saved.exe }
      $entry | ConvertTo-Json -Compress | Add-Content -LiteralPath $Log -Encoding UTF8
      $entry.killed = [UpdateProcess]::TerminateProcess($handle, 1)
      $entry | ConvertTo-Json -Compress | Add-Content -LiteralPath $Log -Encoding UTF8
      if ($entry.killed) { $null = $target.WaitForExit(1000) }
    } catch {
      @{ kind = 'update-cleanup-left'; pid = $saved.pid; error = $_.Exception.Message } | ConvertTo-Json -Compress | Add-Content -LiteralPath $Log -Encoding UTF8
    } finally {
      if ($target) { $target.Dispose() }
    }
  }
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = 'Wink'
$form.Width = 420
$form.Height = 150
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.ControlBox = $false
$label = New-Object Windows.Forms.Label
$label.Text = $request.message
$label.AutoSize = $false
$label.Dock = 'Fill'
$label.TextAlign = 'MiddleCenter'
$label.Font = New-Object Drawing.Font('Segoe UI', 11)
$form.Controls.Add($label)
$bar = New-Object Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.Dock = 'Bottom'
$form.Controls.Add($bar)
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  if (Test-Path -LiteralPath $request.complete) { $form.Close() }
})
$form.Add_Shown({
  [IO.File]::WriteAllText($request.ready, '')
  $timer.Start()
})
try { [Windows.Forms.Application]::Run($form) } finally {
  $timer.Dispose()
  $form.Dispose()
  $directory = [IO.Path]::GetFullPath($request.directory)
  $scratch = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($directory.StartsWith($scratch, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($directory).StartsWith('wink-update-') -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Manifest)) -eq $directory) {
    Remove-Item -LiteralPath $directory -Recurse -Force
  }
}
