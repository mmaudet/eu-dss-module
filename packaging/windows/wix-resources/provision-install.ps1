# Runs elevated at MSI install. Provisions the agent's localhost cert, trusts it machine-wide, sets auto-start.
$ErrorActionPreference = 'Stop'
$exe = Join-Path ${env:ProgramFiles} 'EU-DSS Agent\EU-DSS Agent.exe'
$dataDir = Join-Path $env:ProgramData 'eudss-agent'
$cer = Join-Path $dataDir 'agent.cer'

# 1. Generate keystore + export agent.cer (agent writes to C:\ProgramData\eudss-agent on Windows)
& "$exe" --provision-cert | Out-Null
if ($LASTEXITCODE -ne 0) { throw "provision-cert exited $LASTEXITCODE" }
if (-not (Test-Path $cer)) { throw "provision-cert did not produce $cer" }

# 2. Trust the cert machine-wide (Edge/Chrome/IE use LocalMachine\Root)
$import = Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\Root'
Set-Content -Path (Join-Path $dataDir 'trusted-thumbprint.txt') -Value $import.Thumbprint -Encoding ASCII -NoNewline

# 3. Auto-start at login, in the user's session (NOT a service)
New-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' `
  -Name 'EU-DSS Agent' -Value ('"' + $exe + '"') -PropertyType String -Force | Out-Null

Write-Host "EU-DSS provisioned: cert trusted (thumbprint $($import.Thumbprint)), auto-start set."
