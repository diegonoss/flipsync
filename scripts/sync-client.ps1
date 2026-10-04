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
    [System.Net.ServicePointManager]::DefaultConnectionLimit = 64
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

<#
.SYNOPSIS
    Formats a byte count into a human-readable size string.
#>
function Format-ByteSize {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return "{0:N1} GB" -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return "{0:N1} MB" -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return "{0:N1} KB" -f ($Bytes / 1KB) }
    return "$Bytes B"
}

<#
.SYNOPSIS
    Formats a transfer rate into a human-readable speed string.
#>
function Format-Speed {
    param([double]$BytesPerSec)
    if ($BytesPerSec -ge 1GB) { return "{0:N1} GB/s" -f ($BytesPerSec / 1GB) }
    if ($BytesPerSec -ge 1MB) { return "{0:N1} MB/s" -f ($BytesPerSec / 1MB) }
    if ($BytesPerSec -ge 1KB) { return "{0:N1} KB/s" -f ($BytesPerSec / 1KB) }
    return "{0:N0} B/s" -f $BytesPerSec
}

<#
.SYNOPSIS
    Formats estimated remaining seconds into an ETA string.
#>
function Format-Eta {
    param([int]$Seconds)
    if ($Seconds -lt 60) { return "${Seconds}s" }
    if ($Seconds -lt 3600) { return "$([int]($Seconds / 60))m $($Seconds % 60)s" }
    return "$([int]($Seconds / 3600))h $([int](($Seconds % 3600) / 60))m"
}

<#
.SYNOPSIS
    Generates an ASCII progress bar string of specified character width.
#>
function Get-ProgressBar {
    param([int]$Percent, [int]$Width = 10)
    $filled = [math]::Max(0, [math]::Min($Width, [int]($Width * $Percent / 100)))
    $empty = $Width - $filled
    if ($filled -gt 0 -and $empty -gt 0) {
        return ("=" * ($filled - 1)) + ">" + (" " * $empty)
    } elseif ($filled -eq $Width) {
        return "=" * $Width
    } else {
        return " " * $Width
    }
}

<#
.SYNOPSIS
    Strips ANSI escape sequences and replaces control characters for safe terminal output.
#>
function Sanitize-ForTerminal {
    param([string]$Text)
    if (-not $Text) { return "" }
    $stripped = [regex]::Replace($Text, '\x1b\[[0-9;]*[a-zA-Z]', '')
    return [regex]::Replace($stripped, '[\x00-\x1f\x7f-\x9f]', '?')
}

<#
.SYNOPSIS
    Formats a single-line progress indicator clamped to terminal width.
#>
function Format-ProgressLine {
    param(
        [string]$Prefix,
        [string]$FileName,
        [int]$Percent,
        [string]$CurStr,
        [string]$TotStr,
        [string]$SpeedStr,
        [string]$EtaStr,
        [int]$MaxWidth = 80
    )

    $limit = if ($MaxWidth -gt 1) { $MaxWidth - 1 } else { 1 }
    $safeName = Sanitize-ForTerminal $FileName
    $pctStr = "{0,3}" -f $Percent

    $stats = if ($TotStr) {
        " $pctStr% ($CurStr / $TotStr) $SpeedStr ETA $EtaStr"
    } else {
        " $CurStr ($SpeedStr)"
    }

    $overhead = $Prefix.Length + 1 + $stats.Length
    $rem = $limit - $overhead

    $barStr = ""
    if ($TotStr -and $rem -ge 24) {
        $barWidth = [math]::Min(14, [math]::Max(8, $rem - 20))
        $bar = Get-ProgressBar -Percent $Percent -Width $barWidth
        $barStr = " [$bar]"
    }

    $tail = "$barStr$stats"
    $avail = $limit - $Prefix.Length - 1 - $tail.Length
    $name = $safeName
    if ($name.Length -gt $avail) {
        if ($avail -ge 7) {
            $left = [int](($avail - 3) / 2)
            $right = $avail - 3 - $left
            $name = $safeName.Substring(0, $left) + "..." + $safeName.Substring($safeName.Length - $right)
        } elseif ($avail -ge 4) {
            $name = $safeName.Substring(0, $avail - 3) + "..."
        } elseif ($avail -gt 0) {
            $name = $safeName.Substring(0, $avail)
        } else {
            $name = ""
        }
    }

    $line = "$Prefix $name$tail"
    if ($line.Length -lt $limit) {
        $line = $line.PadRight($limit, ' ')
    } elseif ($line.Length -gt $limit) {
        $line = $line.Substring(0, $limit)
    }
    return $line
}

<#
.SYNOPSIS
    Computes the SHA-256 hash of a local file.
#>
function Get-FileSha256 {
    param([string]$FilePath)
    if (-not (Test-Path $FilePath)) { return $null }
    try {
        return (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash.ToLower()
    } catch {
        return $null
    }
}

<#
.SYNOPSIS
    Checks for HTTP 401 or 403 unauthorized responses and terminates execution.
#>
function Check-AuthError {
    param($Err, [string]$Context = "")
    if (($Err.Exception -and $Err.Exception.Response -and [int]$Err.Exception.Response.StatusCode -in 401, 403) -or
        ("$Err" -match '\b(401|403)\b|Unauthorized|Forbidden')) {
        $detail = if ($Context) { " $Context" } else { "" }
        Write-Host "[CLIENT] [FATAL] Authentication failed$detail (HTTP 401/403). A valid bearer token is required." -ForegroundColor Red
        exit 1
    }
}

<#
.SYNOPSIS
    Downloads and atomically writes a file if missing or modified.
#>
function Sync-File {
    param(
        [string]$FileName,
        [string]$ExpectedHash,
        [long]$Size,
        [int]$Index = 0,
        [int]$TotalFiles = 0
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

    $displayName = Sanitize-ForTerminal $FileName
    $prefix = "[SYNC]"
    if ($TotalFiles -gt 1 -and $Index -gt 0) {
        $prefix = "[SYNC] [$Index/$TotalFiles]"
    }

    $cols = 80
    try {
        if ([Console]::WindowWidth -gt 0) {
            $cols = [Console]::WindowWidth
        }
    } catch {}

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $encodedPath = (($FileName -replace '\\', '/').Split('/') | ForEach-Object { [System.Uri]::EscapeDataString($_) }) -join '/'
    $downloadUrl = "$Server/api/download/$encodedPath$TokenQuery"
    $tempFile = Join-Path $parentDir ".$(Split-Path $dest -Leaf).tmp.$([System.DateTime]::UtcNow.Ticks)"

    $req = $null
    $response = $null
    $responseStream = $null
    $fileStream = $null

    try {
        $req = [System.Net.HttpWebRequest]::Create($downloadUrl)
        $req.Method = "GET"
        $req.UserAgent = "FlipSync/1.0"
        $req.Timeout = 60000
        try { $req.ReadWriteTimeout = 30000 } catch {}

        $response = $req.GetResponse()
        $totalBytes = $response.ContentLength
        if ($totalBytes -le 0 -and $Size -gt 0) {
            $totalBytes = $Size
        }

        $responseStream = $response.GetResponseStream()
        try { $responseStream.ReadTimeout = 30000 } catch {}
        $fileStream = [System.IO.File]::Create($tempFile)
        $buffer = New-Object byte[] 65536

        $receivedBytes = 0
        $lastUpdateMs = 0
        $prevBytes = 0
        $instantSpeed = 0.0

        $isInteractive = $false
        try { $isInteractive = -not [System.Console]::IsOutputRedirected } catch {}

        while (($bytesRead = $responseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $bytesRead)
            $receivedBytes += $bytesRead

            $elapsedMs = $sw.ElapsedMilliseconds
            if ($elapsedMs - $lastUpdateMs -ge 100 -or ($totalBytes -gt 0 -and $receivedBytes -ge $totalBytes)) {
                $dtSec = ($elapsedMs - $lastUpdateMs) / 1000.0
                if ($dtSec -gt 0) {
                    $instantSpeed = ($receivedBytes - $prevBytes) / $dtSec
                }
                $lastUpdateMs = $elapsedMs
                $prevBytes = $receivedBytes

                if ($isInteractive) {
                    $spdStr = Format-Speed $instantSpeed
                    $pct = if ($totalBytes -gt 0) { [math]::Min(100, [math]::Max(0, [int](($receivedBytes * 100) / $totalBytes))) } else { 0 }
                    $curStr = Format-ByteSize $receivedBytes
                    $totStr = if ($totalBytes -gt 0) { Format-ByteSize $totalBytes } else { "" }
                    $etaStr = "--:--"
                    if ($instantSpeed -gt 0 -and $totalBytes -gt 0 -and $receivedBytes -lt $totalBytes) {
                        $remSec = [int](($totalBytes - $receivedBytes) / $instantSpeed)
                        $etaStr = Format-Eta $remSec
                    } elseif ($totalBytes -gt 0 -and $receivedBytes -ge $totalBytes) {
                        $etaStr = "0s"
                    }

                    $line = Format-ProgressLine -Prefix $prefix -FileName $FileName -Percent $pct -CurStr $curStr -TotStr $totStr -SpeedStr $spdStr -EtaStr $etaStr -MaxWidth $cols

                    try {
                        [Console]::CursorLeft = 0
                        [Console]::Write($line)
                    } catch {
                        Write-Host -NoNewline "`r$line"
                    }
                }
            }
        }

        $fileStream.Dispose()
        $fileStream = $null
        $responseStream.Dispose()
        $responseStream = $null
        $response.Dispose()
        $response = $null
        $sw.Stop()

        if ($isInteractive) {
            $limit = if ($cols -gt 1) { $cols - 1 } else { 1 }
            $verifyMsg = "$prefix Verifying checksum for $displayName..."
            if ($verifyMsg.Length -gt $limit) {
                $verifyMsg = $verifyMsg.Substring(0, $limit)
            } else {
                $verifyMsg = $verifyMsg.PadRight($limit, ' ')
            }
            try {
                [Console]::CursorLeft = 0
                [Console]::Write($verifyMsg)
                [Console]::CursorLeft = 0
            } catch {
                Write-Host -NoNewline ("`r" + (" " * $limit) + "`r")
            }
        }

        $downloadedHash = Get-FileSha256 -FilePath $tempFile
        if ($downloadedHash -ne $ExpectedHash) {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
            Write-Host "`n[ERROR] Checksum mismatch for $displayName! Expected $ExpectedHash, got $downloadedHash" -ForegroundColor Red
            return $false
        }

        # Atomic replacement
        Move-Item -Path $tempFile -Destination $dest -Force

        if ($isInteractive) {
            $limit = if ($cols -gt 1) { $cols - 1 } else { 1 }
            try {
                [Console]::CursorLeft = 0
                [Console]::Write(" " * $limit)
                [Console]::CursorLeft = 0
            } catch {
                Write-Host -NoNewline ("`r" + (" " * $limit) + "`r")
            }
        }

        $totalDurSec = [math]::Max(0.001, $sw.ElapsedMilliseconds / 1000.0)
        $avgSpeed = if ($totalDurSec -gt 0) { $receivedBytes / $totalDurSec } else { 0 }
        $finalSizeStr = Format-ByteSize $receivedBytes
        $finalSpeedStr = Format-Speed $avgSpeed
        $timeStr = if ($sw.ElapsedMilliseconds -lt 1000) { "$($sw.ElapsedMilliseconds)ms" } else { "{0:N1}s" -f $totalDurSec }

        Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $prefix Received $displayName ($finalSizeStr) in $timeStr ($finalSpeedStr) -> $dest" -ForegroundColor Green
        return $true
    } catch {
        if ($fileStream) { $fileStream.Dispose(); $fileStream = $null }
        if ($responseStream) { $responseStream.Dispose(); $responseStream = $null }
        if ($response) { $response.Dispose(); $response = $null }
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
        Check-AuthError $_ "downloading $displayName"
        Write-Host "`n[ERROR] Failed downloading $($displayName): $_" -ForegroundColor Red
        return $false
    }
}

<#
.SYNOPSIS
    Queries the host manifest and synchronizes all files.
#>
function Sync-AllFiles {
    try {
        $manifestUrl = "$Server/api/manifest$TokenQuery"

        $res = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing -UserAgent "FlipSync/1.0"
        $files = $res.files.PSObject.Properties

        $count = 0
        $updated = 0
        $props = @($files)
        $totalFiles = $props.Count
        foreach ($prop in $props) {
            $file = $prop.Value
            $count++
            if (Sync-File -FileName $file.name -ExpectedHash $file.sha256 -Size $file.size -Index $count -TotalFiles $totalFiles) {
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
