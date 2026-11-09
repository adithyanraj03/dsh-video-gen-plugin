$as = 'C:\Application\DeepSeek Harness\resources\app.asar'
$fs = [System.IO.File]::OpenRead($as)
$b = New-Object byte[] 128
[void]$fs.Read($b, 0, 128)
$fs.Dispose()
$hex = (($b[0..15] | ForEach-Object { '{0:x2}' -f $_ }) -join ' ')
Write-Host $hex
Write-Host ('v4 = ' + [BitConverter]::ToInt32($b, 4))
Write-Host ('v8 = ' + [BitConverter]::ToInt32($b, 8))
$u = [System.Text.Encoding]::UTF8
Write-Host ('@12: ' + $u.GetString($b, 12, 80).TrimEnd("`0"))
$fs = [System.IO.File]::OpenRead($as)
$fs.Seek(16, 'Begin') | Out-Null
$b2 = New-Object byte[] 96
[void]$fs.Read($b2, 0, 96)
$fs.Dispose()
Write-Host ('@16: ' + $u.GetString($b2))
