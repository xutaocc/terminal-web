# Build a zip from an explicit manifest: no recursion, so the entries the user
# excluded stay out, and symlinks are not followed. Names are stored as UTF-8.
# Called by src/file-api.ts on Windows (which has no `zip`):
#   pwsh -File zip-manifest.ps1 <parent dir> <manifest file> <output zip>
# The manifest is UTF-8, one entry per line, relative to the parent; a
# directory entry ends with "/".
#
# Run it with PowerShell 7 (pwsh): Windows PowerShell 5.1's .NET Framework does
# not mark UTF-8 names in the zip, so other tools show Chinese names garbled.
param([string]$Parent, [string]$Manifest, [string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$entries = [IO.File]::ReadAllLines($Manifest, [Text.UTF8Encoding]::new($false))
$zip = [IO.Compression.ZipFile]::Open($Output, [IO.Compression.ZipArchiveMode]::Create, [Text.UTF8Encoding]::new($false))
try {
  foreach ($entry in $entries) {
    if (-not $entry) { continue }
    if ($entry.EndsWith('/')) { [void]$zip.CreateEntry($entry); continue }
    $source = Join-Path $Parent ($entry -replace '/', '\')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $source, $entry, [IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $zip.Dispose() }
