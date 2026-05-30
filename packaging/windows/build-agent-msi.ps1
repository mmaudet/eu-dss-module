# Build the EU-DSS Agent Windows MSI with jpackage. Run on Windows with JDK 21 + WiX 3 on PATH.
$ErrorActionPreference = 'Stop'
$root    = (Resolve-Path "$PSScriptRoot\..\..").Path
$version = '0.1.0'
$jarDir  = Join-Path $root 'eu-dss-agent\target'
$jar     = "eu-dss-agent-$version-SNAPSHOT.jar"
if (-not (Test-Path (Join-Path $jarDir $jar))) { Write-Error "Build the agent jar first (mvn -pl eu-dss-agent -am -DskipTests package)"; exit 1 }

$staging = Join-Path $env:TEMP 'eudss-msi-input'
Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item (Join-Path $jarDir $jar) $staging

$out = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $out | Out-Null

& jpackage `
  --type msi `
  --name 'EU-DSS Agent' `
  --app-version $version `
  --vendor 'LINAGORA' `
  --input $staging `
  --main-jar $jar `
  --main-class com.linagora.eudss.agent.AgentMain `
  --win-console `
  --win-menu `
  --win-shortcut `
  --dest $out
Write-Host "MSI written to $out"
