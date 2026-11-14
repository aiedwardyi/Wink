export const MAILBOX_ID_PS1 = String.raw`$messageId = [Guid]::NewGuid().ToString('D')
$sentAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
`;

export const MAILBOX_DELIVERY_PS1 = String.raw`$orbitProfile = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__ORBIT_PROFILE__'))
function Save-OrbitReport {
  $dir = [IO.Path]::Combine($orbitProfile, 'mailbox-outbox')
  [void][IO.Directory]::CreateDirectory($dir)
  $lockPath = [IO.Path]::Combine($orbitProfile, 'mailbox-outbox.lock')
  $lock = $null
  $until = [DateTime]::UtcNow.AddSeconds(5)
  while (-not $lock) {
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch {
      if ([DateTime]::UtcNow -ge $until) { throw 'outbox is busy' }
      Start-Sleep -Milliseconds 50
    }
  }
  $tmp = $null
  try {
    foreach ($file in @(Get-ChildItem -LiteralPath $dir -Filter '*.tmp' -File)) { [IO.File]::Delete($file.FullName) }
    $cutoff = [DateTimeOffset]::UtcNow.AddDays(-7).ToUnixTimeMilliseconds()
    $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Sort-Object Name)
    foreach ($file in $files) {
      $at = [long]0
      if (-not [long]::TryParse(($file.Name -split '-')[0], [ref]$at) -or $at -lt $cutoff) { [IO.File]::Delete($file.FullName) }
    }
    $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Sort-Object Name)
    for ($i = 0; $i -le $files.Count - 500; $i++) { [IO.File]::Delete($files[$i].FullName) }
    $payload.queued = $true
    $entry = @{ url = $env:ORBIT_URL; headers = $headers; payload = $payload } | ConvertTo-Json -Depth 5 -Compress
    $target = [IO.Path]::Combine($dir, "$sentAt-$messageId.json")
    $tmp = "$target.tmp"
    [IO.File]::WriteAllText($tmp, $entry, (New-Object Text.UTF8Encoding $false))
    [IO.File]::Move($tmp, $target)
  } finally {
    if ($tmp -and [IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
    $lock.Dispose()
  }
}
$headers = @{ Authorization = "Bearer $auth"; 'X-Orbit-Pane' = $env:ORBIT_PANE; 'X-Orbit-Bot' = $env:ORBIT_BOT; 'X-Orbit-Teacher' = $env:ORBIT_TEACHER }
$uris = @("$env:ORBIT_URL/api/mailbox")
# Avoid WPAD before any loopback request.
$direct = if ($PSVersionTable.PSVersion.Major -ge 6) { @{ NoProxy = $true } } else { [Net.WebRequest]::DefaultWebProxy = $null; @{} }
$clock = [Diagnostics.Stopwatch]::StartNew()
$failure = $null
$discovered = $false
$retryable = $true
do {
  for ($i = 0; $i -lt $uris.Count; $i++) {
    try {
      $timeout = [Math]::Max(1, [Math]::Min(10, [Math]::Ceiling((45000 - $clock.ElapsedMilliseconds) / 1000)))
      Invoke-RestMethod -Method Post -Uri $uris[$i] -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec $timeout @direct | Out-Null
      $failure = $null
      break
    } catch {
      $failure = $_
      $status = if ($failure.Exception.Response) { [int]$failure.Exception.Response.StatusCode } else { 0 }
      $retryable = $status -eq 0 -or $status -eq 408 -or $status -eq 429 -or $status -ge 500
      if (-not $retryable) { break }
      if (-not $discovered -and $env:ORBIT_URL -match '^http://127\.0\.0\.1:\d+$') {
        $discovered = $true
        $current = try { [IO.File]::ReadAllText([IO.Path]::Combine($orbitProfile, 'terminal-discovery.json')) | ConvertFrom-Json } catch { $null }
        if ($current.mailboxUrl -match '^http://127\.0\.0\.1:\d+$') { $uris += "$($current.mailboxUrl)/api/mailbox" }
        else { $uris += 'http://127.0.0.1:18799/api/mailbox', 'http://127.0.0.1:28799/api/mailbox' }
        $uris = @($uris | Select-Object -Unique)
      }
      if ($clock.ElapsedMilliseconds -ge 45000) { break }
    }
  }
  if (-not $failure -or -not $retryable -or $clock.ElapsedMilliseconds -ge 45000) { break }
  Start-Sleep -Milliseconds ([Math]::Max(0, [Math]::Min(1000, 45000 - $clock.ElapsedMilliseconds)))
} while ($clock.ElapsedMilliseconds -lt 45000)
if ($failure -and $retryable -and $orbitProfile -and $env:ORBIT_URL -match '^http://127\.0\.0\.1:\d+$') {
  try {
    Save-OrbitReport
    [Console]::Out.WriteLine('orbit-msg: queued')
    exit 0
  } catch { $failure = $_ }
}
`;
