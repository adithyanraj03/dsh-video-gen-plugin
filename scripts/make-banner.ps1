# Compose the README banners from a QA screenshot of the real card.
#
#   pwsh -File scripts/make-banner.ps1 -Source <screenshot.png> [-Crop x,y,w,h]
#
# Produces (all 1400x400, matching the sibling plugin's banner):
#   assets/card-rendering.png   the clean card crop the banners are built from
#   assets/banner-dark.png    dark theme
#   assets/banner-light.png   light theme
param(
  [string]$Source = '',
  [string]$Crop = '0,0,760,418'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Add-Type -AssemblyName System.Drawing

$cardPath = Join-Path $root 'assets\card-rendering.png'

if ($Source -ne '') {
  $box = $Crop.Split(',') | ForEach-Object { [int]$_ }
  $img = [System.Drawing.Image]::FromFile($Source)
  $rect = New-Object System.Drawing.Rectangle $box[0], $box[1], $box[2], $box[3]
  $card = New-Object System.Drawing.Bitmap $box[2], $box[3]
  $cg = [System.Drawing.Graphics]::FromImage($card)
  $cg.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $box[2], $box[3]), $rect, [System.Drawing.GraphicsUnit]::Pixel)
  $cg.Dispose()
  $img.Dispose()
  $card.Save($cardPath, [System.Drawing.Imaging.ImageFormat]::Png)
  "wrote assets/card-rendering.png ($($box[2])x$($box[3]))"
}

$cardImage = [System.Drawing.Image]::FromFile($cardPath)

function Add-Glow {
  param($g, [int]$x, [int]$y, [int]$w, [int]$h, [System.Drawing.Color]$color)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($x, $y, $w, $h)
  $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
  $brush.CenterColor = $color
  $brush.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, $color.R, $color.G, $color.B))
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
}

function New-Banner {
  param([string]$Mode, [string]$Out)

  $dark = $Mode -eq 'dark'
  $bg = if ($dark) { [System.Drawing.Color]::FromArgb(14, 16, 21) } else { [System.Drawing.Color]::FromArgb(247, 247, 251) }
  $ink = if ($dark) { [System.Drawing.Color]::FromArgb(243, 243, 248) } else { [System.Drawing.Color]::FromArgb(20, 22, 30) }
  $dim = if ($dark) { [System.Drawing.Color]::FromArgb(185, 184, 208) } else { [System.Drawing.Color]::FromArgb(92, 96, 112) }
  $label = if ($dark) { [System.Drawing.Color]::FromArgb(139, 144, 176) } else { [System.Drawing.Color]::FromArgb(122, 126, 148) }

  $bmp = New-Object System.Drawing.Bitmap 1400, 400
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear($bg)

  # Two soft pools of light: lavender behind the wordmark, cooler behind the card.
  $strength = if ($dark) { 78 } else { 90 }
  Add-Glow $g 40 60 780 380 ([System.Drawing.Color]::FromArgb($strength, 150, 152, 215))
  Add-Glow $g 760 140 700 320 ([System.Drawing.Color]::FromArgb([int]($strength * 0.55), 120, 150, 190))

  $labelFont = New-Object System.Drawing.Font 'Consolas', 15, ([System.Drawing.FontStyle]::Regular)
  $labelBrush = New-Object System.Drawing.SolidBrush $label
  $g.DrawString('DEEPSEEK HARNESS PLUGIN', $labelFont, $labelBrush, 74, 84)
  $labelFont.Dispose(); $labelBrush.Dispose()

  $markFont = New-Object System.Drawing.Font 'Segoe UI', 78, ([System.Drawing.FontStyle]::Bold)
  $markBrush = New-Object System.Drawing.SolidBrush $ink
  $g.DrawString('video-gen', $markFont, $markBrush, 66, 106)
  $markFont.Dispose(); $markBrush.Dispose()

  $tagFont = New-Object System.Drawing.Font 'Consolas', 18, ([System.Drawing.FontStyle]::Regular)
  $tagBrush = New-Object System.Drawing.SolidBrush $dim
  $tag = 'text-to-video · your endpoint · live progress · plays inline'
  # Shrink until the line clears the card, then draw it.
  while ($g.MeasureString($tag, $tagFont).Width -gt 660 -and $tagFont.Size -gt 10) {
    $next = New-Object System.Drawing.Font 'Consolas', ($tagFont.Size - 1), ([System.Drawing.FontStyle]::Regular)
    $tagFont.Dispose(); $tagFont = $next
  }
  $g.DrawString($tag, $tagFont, $tagBrush, 74, 252)
  $tagFont.Dispose(); $tagBrush.Dispose()

  # The real card, tilted slightly, on the right.
  $cw = 566
  $ch = [int]($cw * ($cardImage.Height / $cardImage.Width))
  $state = $g.Save()
  $g.TranslateTransform(1058, 200)
  $g.RotateTransform(-4)
  $g.DrawImage($cardImage, [int](-$cw / 2), [int](-$ch / 2), $cw, $ch)
  $g.Restore($state)

  $bmp.Save((Join-Path $root $Out), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  "wrote $Out"
}

New-Banner 'dark' 'assets\banner-dark.png'
New-Banner 'light' 'assets\banner-light.png'
$cardImage.Dispose()


