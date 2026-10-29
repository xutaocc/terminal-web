# Bootstrap only the escli client; never install or start Everything itself.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\twsshProjecTemp'
$target = Join-Path $root 'escli.exe'
$installed = $false
if (-not [Environment]::Is64BitOperatingSystem) { throw 'The supplied escli package requires 64-bit Windows.' }
if (-not (Test-Path -LiteralPath $root)) { [void][IO.Directory]::CreateDirectory($root) }
$item = Get-Item -LiteralPath $root -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe TWSSH home.' }
if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe escli executable path.' }
} else {
    Add-Type -AssemblyName System.Net.Http
    Add-Type -AssemblyName System.IO.Compression
    $http = New-Object Net.Http.HttpClient
    $http.Timeout = [TimeSpan]::FromSeconds(60)
    $http.MaxResponseContentBufferSize = 16777216
    $memory = $null; $zip = $null; $stream = $null; $output = $null; $stage = $null
    try {
        $bytes = $http.GetByteArrayAsync('https://www.voidtools.com/ES-1.1.0.38.x64.zip').GetAwaiter().GetResult()
        $memory = [IO.MemoryStream]::new($bytes, $false)
        $zip = [IO.Compression.ZipArchive]::new($memory, [IO.Compression.ZipArchiveMode]::Read)
        $entries = @($zip.Entries | Where-Object { $_.FullName -ceq 'es.exe' })
        if ($entries.Count -ne 1 -or $entries[0].Length -lt 2 -or $entries[0].Length -gt 8388608) { throw 'Unexpected escli archive contents.' }
        $stream = $entries[0].Open()
        $stage = Join-Path $root ('.twssh-escli-install-' + [guid]::NewGuid().ToString() + '.exe')
        $output = [IO.File]::Open($stage, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.CopyTo($output); $output.Dispose(); $output = $null
        # File.Move does not overwrite an existing destination.
        [IO.File]::Move($stage, $target)
        $stage = $null; $installed = $true
    } catch {
        if ($stage) { Write-Warning "Installation incomplete; retain and inspect this exact file: $stage" }
        throw
    } finally {
        if ($output) { $output.Dispose() }; if ($stream) { $stream.Dispose() }
        if ($zip) { $zip.Dispose() }; if ($memory) { $memory.Dispose() }; $http.Dispose()
    }
}
# Hidden, bounded probe: avoid console flashing and unbounded IPC waits.
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = $target
$info.Arguments = '-timeout 5000 -get-everything-version'
$info.UseShellExecute = $false; $info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
$process = New-Object Diagnostics.Process
$process.StartInfo = $info
try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) {
        $process.Kill(); $process.WaitForExit()
        throw 'escli probe timed out. Check the Everything instance; do not reinstall automatically.'
    }
    $code = $process.ExitCode
    $out = $stdout.GetAwaiter().GetResult().Trim()
    $err = $stderr.GetAwaiter().GetResult().Trim()
    [ordered]@{
        path = $target; installed = $installed; backendReady = ($code -eq 0)
        exitCode = $code; version = $out; error = $err
        note = $(if ($code -eq 0) { 'Ready' } else { 'Everything is missing, not running, or inaccessible to this account/instance. Check the main program; do not auto-install or start it.' })
    } | ConvertTo-Json -Compress
} finally { $process.Dispose() }
