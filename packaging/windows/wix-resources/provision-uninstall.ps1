# Runs elevated at MSI uninstall. Reverses provision-install.
$ErrorActionPreference = 'Continue'
$dataDir = Join-Path $env:ProgramData 'eudss-agent'
$tpFile = Join-Path $dataDir 'trusted-thumbprint.txt'

if (Test-Path $tpFile) {
  $tp = (Get-Content -Raw $tpFile).Trim()
  Get-ChildItem 'Cert:\LocalMachine\Root' | Where-Object { $_.Thumbprint -eq $tp } | Remove-Item -Force -ErrorAction SilentlyContinue
}
Remove-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'EU-DSS Agent' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
Write-Host "EU-DSS unprovisioned: cert untrusted, auto-start + data removed."
