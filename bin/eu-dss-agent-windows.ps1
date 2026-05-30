# eu-dss agent launcher (Windows)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$jar  = Join-Path $root 'eu-dss-agent\target\eu-dss-agent-0.1.0-SNAPSHOT.jar'
if (-not (Test-Path $jar)) { Write-Error "Jar not found: $jar`nBuild first: mvn -DskipTests package"; exit 1 }

if (-not $env:EUDSS_PKCS11_DRIVER) { $env:EUDSS_PKCS11_DRIVER = 'C:\Windows\System32\idop11.dll' }
if (-not $env:EUDSS_PKCS11_SLOT)   { $env:EUDSS_PKCS11_SLOT = '0' }
if (-not $env:EUDSS_AGENT_PORT)    { $env:EUDSS_AGENT_PORT = '9795' }

Write-Host "eu-dss agent (Windows)"
Write-Host "  PKCS#11 driver : $env:EUDSS_PKCS11_DRIVER  (slot 0 = signing cert, 4-digit Card PIN)"
Write-Host "  port           : $env:EUDSS_AGENT_PORT (HTTPS)"
Write-Host "Enter your Card PIN when prompted."
& java -jar $jar
