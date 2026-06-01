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

# Stage the provisioning scripts so they install under INSTALLDIR\wix-resources\ (referenced by the
# main.wxs custom actions). Harmless for the default (no-override) MSI — they just sit unused.
$wixRes = Join-Path $root 'packaging\windows\wix-resources'
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'wix-resources') | Out-Null
Copy-Item (Join-Path $wixRes 'provision-install.ps1')   (Join-Path $staging 'wix-resources') -Force
Copy-Item (Join-Path $wixRes 'provision-uninstall.ps1') (Join-Path $staging 'wix-resources') -Force

$out = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# Keep jpackage's working dir so we can archive the generated WiX source (capture template / verify override).
$jpTemp = Join-Path $env:TEMP 'eudss-jp-temp'
Remove-Item -Recurse -Force $jpTemp -ErrorAction SilentlyContinue

$jpArgs = @(
  '--type','msi',
  '--name','EU-DSS Agent',
  '--app-version',$version,
  '--vendor','LINAGORA',
  '--input',$staging,
  '--main-jar',$jar,
  '--main-class','com.linagora.eudss.agent.AgentMain',
  '--win-console',
  '--win-menu',
  '--win-shortcut',
  '--temp',$jpTemp,
  '--verbose',
  '--dest',$out
)

# When a WiX override exists, jpackage uses it as the main.wxs template (perMachine + provisioning
# custom actions). Absent, jpackage emits its default template — which we still archive below so we
# can capture it as the editing base.
$mainWxs = Join-Path $wixRes 'main.wxs'
if (Test-Path $mainWxs) {
  $jpArgs += @('--resource-dir',$wixRes)
  Write-Host "Using WiX override: $mainWxs (--resource-dir $wixRes)"
} else {
  Write-Host "No WiX override (wix-resources\main.wxs absent) -- building default jpackage MSI."
}

& jpackage @jpArgs
$jpExit = $LASTEXITCODE

# Surface the effective WiX source so CI can archive it (capture jpackage's template / verify our override compiled).
# Done even on failure so a candle/light error can be diagnosed from the exact post-substitution file.
$genWxs = Join-Path $jpTemp 'config\main.wxs'
if (Test-Path $genWxs) {
  Copy-Item $genWxs (Join-Path $out 'main.wxs') -Force
  Write-Host "Captured effective WiX to dist\main.wxs"
} else {
  Write-Warning "jpackage did not produce $genWxs (config dir layout may differ)"
}

if ($jpExit -ne 0) { Write-Error "jpackage failed with exit code $jpExit"; exit $jpExit }
Write-Host "MSI written to $out"
