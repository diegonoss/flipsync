<#
.SYNOPSIS
    FlipSync — Zero-Install Real-Time Sync Client for Windows PowerShell
.DESCRIPTION
    Monitors a remote FlipSync host server across networks (via Cloudflare Tunnel,
    Tailscale, or LAN) and automatically downloads new or updated files into your
    local destination folder with SHA-256 checksum verification and atomic writes.
.EXAMPLE
    .\sync-client.ps1 -Server "https://xyz.trycloudflare.com" -Token "secret" -Target "C:\SyncFolder"
.EXAMPLE
    $s="https://xyz.trycloudflare.com"; $t="secret"; irm "$s/client.ps1" | iex
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$Server = $env:SYNC_SERVER,

    [Parameter(Mandatory = $false)]
    [string]$Token = $env:SYNC_TOKEN,

    [Parameter(Mandatory = $false)]
    [string]$Target = (Get-Location).Path,

    [Parameter(Mandatory = $false)]
    [switch]$Once
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
} catch {}

if (-not $Server) {
    if (Test-Path Variable:s) { $Server = $s }
    elseif (Test-Path Variable:global:s) { $Server = $global:s }
}

if (-not $Token) {
    if (Test-Path Variable:t) { $Token = $t }
    elseif (Test-Path Variable:global:t) { $Token = $global:t }
}

if (-not $Server) {
    Write-Host "Usage: .\sync-client.ps1 -Server <URL> [-Token <TOKEN>] [-Target <FOLDER>] [-Once]" -ForegroundColor Yellow
    $Server = Read-Host "Enter FlipSync Host URL (e.g. https://xxxx.trycloudflare.com or http://192.168.1.50:7890)"
    if (-not $Server) {
        Write-Error "Server URL is required."
        exit 1
    }
}

$Server = $Server.TrimEnd('/')

if (-not (Test-Path $Target)) {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
}

$ResolvedTarget = (Resolve-Path $Target).Path

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "       FlipSync -- Windows PowerShell Real-Time Client" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Server:      $Server" -ForegroundColor White
Write-Host "  Destination: $ResolvedTarget" -ForegroundColor White
if ($Token) {
    Write-Host "  Auth:        Bearer Token Configured" -ForegroundColor White
} else {
    Write-Host "  Auth:        None (Open Access)" -ForegroundColor White
}
Write-Host "================================================================`n" -ForegroundColor Cyan

$TokenQuery = if ($Token) { "?token=$([System.Uri]::EscapeDataString($Token))" } else { "" }
$TokenParam = if ($Token) { "&token=$([System.Uri]::EscapeDataString($Token))" } else { "" }

function Get-FileSha256 {
    param([string]$FilePath)
    if (-not (Test-Path $FilePath)) { return $null }
    try {
        return (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash.ToLower()
    } catch {
        return $null
    }
}

function Check-AuthError {
    param($Err, [string]$Context = "")
    if (($Err.Exception -and $Err.Exception.Response -and [int]$Err.Exception.Response.StatusCode -in 401, 403) -or
        ("$Err" -match '\b(401|403)\b|Unauthorized|Forbidden')) {
        $detail = if ($Context) { " $Context" } else { "" }
        Write-Host "[CLIENT] [FATAL] Authentication failed$detail (HTTP 401/403). A valid bearer token is required." -ForegroundColor Red
        exit 1
    }
}

function Sync-File {
    param(
        [string]$FileName,
        [string]$ExpectedHash,
        [long]$Size
    )

    if ($FileName -like "*..*" -or [System.IO.Path]::IsPathRooted($FileName)) {
        Write-Host "[ERROR] Path traversal blocked: $FileName" -ForegroundColor Red
        return $false
    }

    $dest = Join-Path $ResolvedTarget ($FileName -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    $parentDir = Split-Path $dest -Parent
    if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }

    if (Test-Path $dest) {
        $localHash = Get-FileSha256 -FilePath $dest
        if ($localHash -eq $ExpectedHash) {
            return $false
        }
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $encodedPath = (($FileName -replace '\\', '/').Split('/') | ForEach-Object { [System.Uri]::EscapeDataString($_) }) -join '/'
    $downloadUrl = "$Server/api/download/$encodedPath$TokenQuery"
    $tempFile = Join-Path $parentDir ".$(Split-Path $dest -Leaf).tmp.$([System.DateTime]::UtcNow.Ticks)"

    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tempFile -UseBasicParsing -UserAgent "FlipSync/1.0"
        $downloadedHash = Get-FileSha256 -FilePath $tempFile

        if ($downloadedHash -ne $ExpectedHash) {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
            Write-Host "[ERROR] Checksum mismatch for $FileName! Expected $ExpectedHash, got $downloadedHash" -ForegroundColor Red
            return $false
        }

        # Atomic replacement
        Move-Item -Path $tempFile -Destination $dest -Force
        $sw.Stop()
        $kb = [math]::Round($Size / 1KB, 1)
        Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] [SYNC] Received $FileName (${kb} KB) in $($sw.ElapsedMilliseconds)ms -> $dest" -ForegroundColor Green
        return $true
    } catch {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
        Check-AuthError $_ "downloading $FileName"
        Write-Host "[ERROR] Failed downloading $($FileName): $_" -ForegroundColor Red
        return $false
    }
}

function Sync-AllFiles {
    try {
        $manifestUrl = "$Server/api/manifest$TokenQuery"

        $res = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing -UserAgent "FlipSync/1.0"
        $files = $res.files.PSObject.Properties

        $count = 0
        $updated = 0
        foreach ($prop in $files) {
            $file = $prop.Value
            $count++
            if (Sync-File -FileName $file.name -ExpectedHash $file.sha256 -Size $file.size) {
                $updated++
            }
        }
        Write-Host "[CLIENT] Manifest checked: $count file(s) verified, $updated updated." -ForegroundColor Cyan
    } catch {
        Check-AuthError $_
        Write-Host "[CLIENT] Manifest check failed: $_" -ForegroundColor Red
        if ($Once) { throw $_ }
    }
}

# Initial synchronization
Sync-AllFiles

if ($Once) {
    Write-Host "[CLIENT] Sync complete (-Once specified). Exiting." -ForegroundColor Green
    exit 0
}

Write-Host "`n[CLIENT] Listening for real-time file updates from host..." -ForegroundColor Yellow

$lastTime = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$retryDelay = 1
$maxRetryDelay = 30

while ($true) {
    try {
        $waitUrl = "$Server/api/wait-change?since=$lastTime$TokenParam"

        # Long-poll: waits on host until a change occurs (up to 25s)
        $res = Invoke-RestMethod -Uri $waitUrl -UseBasicParsing -UserAgent "FlipSync/1.0" -TimeoutSec 35

        # Successful connection, reset retry backoff
        $retryDelay = 1

        if ($res.timestamp) {
            $lastTime = $res.timestamp
        }

        if ($res.changed) {
            if ($res.deleted) {
                if (-not ($res.deleted -like "*..*") -and -not [System.IO.Path]::IsPathRooted($res.deleted)) {
                    $targetFile = Join-Path $ResolvedTarget ($res.deleted -replace '/', [System.IO.Path]::DirectorySeparatorChar)
                    if (Test-Path $targetFile) {
                        Remove-Item $targetFile -Force -ErrorAction SilentlyContinue
                        Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] [DELETE] Removed $($res.deleted) (deleted on host)" -ForegroundColor Yellow
                    }
                }
            } elseif ($res.file) {
                [void](Sync-File -FileName $res.file.name -ExpectedHash $res.file.sha256 -Size $res.file.size)
            } else {
                Sync-AllFiles
            }
        }
    } catch {
        Check-AuthError $_
        if ("$_" -match "timed out|The operation has timed out") {
            $retryDelay = 1
            continue
        }
        if ($retryDelay -gt $maxRetryDelay) {
            Write-Host "[CLIENT] [FATAL] Connection lost. Retry delay (${retryDelay}s) exceeded limit (${maxRetryDelay}s). Terminating." -ForegroundColor Red
            exit 1
        }
        Write-Host "[CLIENT] Connection interrupted: $_. Reconnecting in ${retryDelay}s..." -ForegroundColor DarkYellow
        Start-Sleep -Seconds $retryDelay
        $retryDelay = $retryDelay * 2
        Sync-AllFiles
        $lastTime = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
}
