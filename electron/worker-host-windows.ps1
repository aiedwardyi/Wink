param([string]$Operation, [int]$TargetPid, [string]$TargetPath)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($Operation -eq 'identity') {
  $created = (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue).StartTime
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks.ToString()
  @{ pid = $TargetPid; created = $(if ($created) { $created.ToUniversalTime().Ticks.ToString() } else { $null }); boot = $boot } | ConvertTo-Json -Compress
  exit 0
}
if ($Operation -eq 'directory') {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  ([IO.DirectoryInfo]$TargetPath).SetAccessControl($acl)
  exit 0
}
if (@('pipe-acl', 'pipe-private') -contains $Operation) {
  $rights = [IO.Pipes.PipeAccessRights]::ReadWrite -bor [IO.Pipes.PipeAccessRights]::ReadPermissions
  if ($Operation -eq 'pipe-private') { $rights = $rights -bor [IO.Pipes.PipeAccessRights]::ChangePermissions }
  $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $TargetPath.Substring(9), $rights, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Identification, [IO.HandleInheritability]::None)
  try {
    $pipe.Connect(3000)
    if ($Operation -eq 'pipe-private') {
      $acl = New-Object IO.Pipes.PipeSecurity
      $acl.SetAccessRuleProtection($true, $false)
      $network = New-Object Security.Principal.SecurityIdentifier('S-1-5-2')
      $acl.AddAccessRule((New-Object IO.Pipes.PipeAccessRule($network, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Deny)))
      $acl.AddAccessRule((New-Object IO.Pipes.PipeAccessRule($identity.User, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)))
      $pipe.SetAccessControl($acl)
    }
    $pipe.GetAccessControl().GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  } finally { $pipe.Dispose() }
  exit 0
}
throw 'Unknown worker host operation'
