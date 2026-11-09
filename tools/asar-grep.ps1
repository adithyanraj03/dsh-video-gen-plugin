param([string]$Asar, [string]$Pattern, [int]$Context = 160, [int]$Max = 12)
$bytes = [System.IO.File]::ReadAllBytes($Asar)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
$rx = [regex]([regex]::Escape($Pattern))
$count = 0
foreach ($m in $rx.Matches($text)) {
  if ($count -ge $Max) { break }
  $s = [math]::Max(0, $m.Index - $Context)
  $len = [math]::Min($Pattern.Length + 2 * $Context, $text.Length - $s)
  $snippet = $text.Substring($s, $len) -replace "[`r`n]+", ' '
  Write-Host ('---- at ' + $m.Index)
  Write-Host $snippet
  $count++
}
Write-Host ("total shown: " + $count)
