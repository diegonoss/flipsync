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

function Get-FileSha256 {
    param([string]$FilePath)
    if (-not (Test-Path $FilePath)) { return $null }
    try {
        $stream = [System.IO.File]::OpenRead($FilePath)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $hashBytes = $sha.ComputeHash($stream)
        $stream.Close()
        $sb = New-Object System.Text.StringBuilder
        foreach ($b in $hashBytes) {
            [void]$sb.Append($b.ToString("x2"))
        }
        return $sb.ToString()
    } catch {
        return $null
    }
}

function Sync-File {
    param(
        [string]$FileName,
        [string]$ExpectedHash,
        [long]$Size
    )

    $dest = Join-Path $ResolvedTarget $FileName
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
    $encodedName = [System.Uri]::EscapeDataString($FileName)
    $downloadUrl = "$Server/api/download/$encodedName"
    if ($Token) {
        $downloadUrl += "?token=$([System.Uri]::EscapeDataString($Token))"
    }

    $tempFile = Join-Path $parentDir ".$(Split-Path $FileName -Leaf).tmp.$([System.DateTime]::UtcNow.Ticks)"
    
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
        Write-Host "[ERROR] Failed downloading $($FileName): $_" -ForegroundColor Red
        return $false
    }
}

function Sync-AllFiles {
    try {
        $manifestUrl = "$Server/api/manifest"
        if ($Token) {
            $manifestUrl += "?token=$([System.Uri]::EscapeDataString($Token))"
        }

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

while ($true) {
    try {
        $waitUrl = "$Server/api/wait-change?since=$lastTime"
        if ($Token) {
            $waitUrl += "&token=$([System.Uri]::EscapeDataString($Token))"
        }

        # Long-poll: waits on host until a change occurs (up to 25s)
        $res = Invoke-RestMethod -Uri $waitUrl -UseBasicParsing -UserAgent "FlipSync/1.0" -TimeoutSec 35

        if ($res.timestamp) {
            $lastTime = $res.timestamp
        }

        if ($res.changed) {
            if ($res.file) {
                [void](Sync-File -FileName $res.file.name -ExpectedHash $res.file.sha256 -Size $res.file.size)
            } else {
                Sync-AllFiles
            }
        }
    } catch {
        $msg = "$_"
        if ($msg -match "timed out" -or $msg -match "The operation has timed out") {
            continue
        }
        Write-Host "[CLIENT] Connection interrupted: $msg. Reconnecting in 1s..." -ForegroundColor DarkYellow
        Start-Sleep -Seconds 1
        Sync-AllFiles
        $lastTime = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
}
