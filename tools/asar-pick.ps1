# Minimal asar reader in PowerShell.
# usage: pwsh asar-pick.ps1 <asar> list <needle>
#        pwsh asar-pick.ps1 <asar> get <relpath> <outfile>
param([string]$Asar, [string]$Mode, [string]$A, [string]$B, [int]$Cap = 60)

$fs = [System.IO.File]::OpenRead($Asar)
try {
  $head = New-Object byte[] 16
  [void]$fs.Read($head, 0, 16)
  $jsonLen = [BitConverter]::ToInt32($head, 8)
  $jsonBuf = New-Object byte[] $jsonLen
  $fs.Position = 16
  [void]$fs.Read($jsonBuf, 0, $jsonLen)
  $header = [System.Text.Encoding]::UTF8.GetString($jsonBuf)
  # trim padding after the final closing brace
  $lastBrace = $header.LastIndexOf('}')
  if ($lastBrace -ge 0) { $header = $header.Substring(0, $lastBrace + 1) }
  $h = $header | ConvertFrom-Json
  $padded = [int]([math]::Ceiling($jsonLen / 4) * 4)
  $dataStart = 16 + $padded

  function Walk($node, $prefix) {
    foreach ($name in $node.files.PSObject.Properties.Name) {
      $child = $node.files.$name
      $p = if ($prefix) { "$prefix/$name" } else { $name }
      if ($child.files) { Walk $child $p }
      elseif ($null -ne $child.offset) {
        [pscustomobject]@{ p = $p; offset = [long]$child.offset; size = [long]$child.size }
      }
    }
  }

  if ($Mode -eq 'list') {
    Walk $h '' | Where-Object { $_.p -like "*$A*" } |
      Sort-Object p | Select-Object -First $Cap |
      ForEach-Object { "{0}`t{1}`t{2}" -f $_.size, $_.p, $_.offset }
  }
  elseif ($Mode -eq 'get') {
    $match = Walk $h '' | Where-Object { $_.p -eq $A } | Select-Object -First 1
    if (-not $match) { Write-Error "not found: $A"; exit 1 }
    $fs.Position = $dataStart + $match.offset
    $out = New-Object byte[] $match.size
    $read = 0
    while ($read -lt $match.size) {
      $n = $fs.Read($out, $read, $match.size - $read)
      if ($n -le 0) { break }
      $read += $n
    }
    [System.IO.File]::WriteAllBytes($B, $out)
    Write-Host "wrote $B ($($match.size) bytes)"
  }
} finally {
  $fs.Dispose()
}
