$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dst = Join-Path $env:USERPROFILE ".gemini\config\plugins\agy-monitor"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force "$src\plugin.json", "$src\assets", "$src\sidecars" $dst
$readme = Get-Content -Raw -Encoding UTF8 "$src\README.md"
$readme = [regex]::Replace($readme, '(?s)## 界面预览\r?\n.*?---\r?\n\r?\n', '')
$readme = [regex]::Replace($readme, '(?s)\r?\n---\r?\n\r?\n## 贡献与协议\r?\n.*$', '')
Set-Content -Path "$dst\README.md" -Value $readme -Encoding UTF8 -NoNewline
Write-Output "Synced to $dst"
