param([string]$ConfigFile = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
if (!$ConfigFile) { $ConfigFile = Join-Path $repoRoot '.env' }
if (!(Test-Path -LiteralPath $ConfigFile)) { throw "Startup configuration missing: $ConfigFile" }
# Read data, never execute the environment file as PowerShell code.
foreach ($line in Get-Content -LiteralPath $ConfigFile -Encoding UTF8) {
  $entry = $line.Trim()
  if (!$entry -or $entry.StartsWith('#')) { continue }
  if ($entry -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { throw 'Invalid KEY=VALUE line in startup configuration' }
  $key = $Matches[1]; $value = $Matches[2].Trim()
  if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { $value = $value.Substring(1, $value.Length - 2) }
  [Environment]::SetEnvironmentVariable($key, $value, 'Process')
}
& node --import tsx src/server.ts
exit $LASTEXITCODE
