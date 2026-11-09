# Build the self-contained panel QA page: compiles video-panel.ts and inlines
# both scripts so the page runs from file:// (no module CORS, no server).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  New-Item -ItemType Directory -Force 'tools\qa' | Out-Null
  & pnpm exec tsc src/client/video-panel.ts --ignoreConfig --outDir tools/qa --module esnext --target es2022 --strict --skipLibCheck
  if ($LASTEXITCODE -ne 0) { throw 'tsc failed' }
  $panel = (Get-Content 'tools\qa\video-panel.js' -Raw -Encoding utf8) -replace 'export function ', 'function '
  $app = Get-Content 'tools\panel-test-app.js' -Raw -Encoding utf8
  $html = Get-Content 'tools\panel-test.template.html' -Raw -Encoding utf8
  $html = $html.Replace('/*__PANEL_JS__*/', $panel).Replace('/*__APP_JS__*/', $app)
  [System.IO.File]::WriteAllText((Join-Path $root 'tools\qa\panel-test.html'), $html, (New-Object System.Text.UTF8Encoding($false)))
  "built tools\qa\panel-test.html ($([Math]::Round((Get-Item 'tools\qa\panel-test.html').Length / 1024, 1)) KiB)"
} finally { Pop-Location }
