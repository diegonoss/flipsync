#!/usr/bin/env bash
# FlipSync — Real-Time Sync Client for Linux / macOS
# Usage: ./sync-client.sh --server <URL> [--token <TOKEN>] [--target <FOLDER>] [--once]

set -euo pipefail

SERVER="${SYNC_SERVER:-}"
TOKEN="${SYNC_TOKEN:-}"
TARGET="${SYNC_TARGET:-.}"
ONCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server|-s) SERVER="$2"; shift 2 ;;
        --token|-t) TOKEN="$2"; shift 2 ;;
        --target) TARGET="$2"; shift 2 ;;
        --once) ONCE=true; shift ;;
        --help|-h)
            echo "Usage: ./sync-client.sh --server <URL> [--token <TOKEN>] [--target <FOLDER>] [--once]"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [[ -z "$SERVER" ]]; then
    echo "Usage: ./sync-client.sh --server <URL> [--token <TOKEN>] [--target <FOLDER>] [--once]"
    exit 1
fi

SERVER="${SERVER%/}"
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

echo "================================================================"
echo "       FlipSync -- Linux/macOS Real-Time Sync Client"
echo "================================================================"
echo "  Server:      $SERVER"
echo "  Destination: $TARGET"
if [[ -n "$TOKEN" ]]; then
    echo "  Auth:        Bearer Token Configured"
    TOKEN_QUERY="?token=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$TOKEN" 2>/dev/null || echo "$TOKEN")"
else
    echo "  Auth:        None (Open Access)"
    TOKEN_QUERY=""
fi
echo "================================================================"

url_encode() {
    local str="$1"
    if command -v node >/dev/null 2>&1; then
        node -e 'console.log(process.argv[1].split("/").map(encodeURIComponent).join("/"))' "$str" 2>/dev/null && return
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import sys, urllib.parse; print("/".join(urllib.parse.quote(p) for p in sys.argv[1].split("/")), end="")' "$str" 2>/dev/null && return
    fi
    # Posix fallback
    echo "$str"
}

calc_sha256() {
    local f="$1"
    command -v sha256sum >/dev/null 2>&1 && sha256sum "$f" | awk '{print $1}' && return
    command -v shasum >/dev/null 2>&1 && shasum -a 256 "$f" | awk '{print $1}' && return
    node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" "$f"
}

format_bytes() {
    local b="${1:-0}"
    if (( b >= 1073741824 )); then
        local gb=$(( b / 1073741824 ))
        local dec=$(( (b % 1073741824) * 10 / 1073741824 ))
        echo "${gb}.${dec} GB"
    elif (( b >= 1048576 )); then
        local mb=$(( b / 1048576 ))
        local dec=$(( (b % 1048576) * 10 / 1048576 ))
        echo "${mb}.${dec} MB"
    elif (( b >= 1024 )); then
        local kb=$(( b / 1024 ))
        local dec=$(( (b % 1024) * 10 / 1024 ))
        echo "${kb}.${dec} KB"
    else
        echo "${b} B"
    fi
}

format_speed() {
    local bps="${1:-0}"
    echo "$(format_bytes "$bps")/s"
}

format_eta() {
    local s="${1:-0}"
    if (( s < 60 )); then
        echo "${s}s"
    elif (( s < 3600 )); then
        echo "$(( s / 60 ))m $(( s % 60 ))s"
    else
        echo "$(( s / 3600 ))h $(( (s % 3600) / 60 ))m"
    fi
}

get_progress_bar() {
    local pct="${1:-0}" width="${2:-16}"
    local filled=$(( width * pct / 100 ))
    (( filled > width )) && filled=$width
    (( filled < 0 )) && filled=0
    local empty=$(( width - filled ))
    local bar=""
    if (( filled > 0 && empty > 0 )); then
        local eq=$(( filled - 1 ))
        printf -v eq_str "%*s" "$eq" ""
        bar="${eq_str// /=}>"
        printf -v sp_str "%*s" "$empty" ""
        bar+="${sp_str}"
    elif (( filled == width )); then
        printf -v eq_str "%*s" "$width" ""
        bar="${eq_str// /=}"
    else
        printf -v sp_str "%*s" "$width" ""
        bar="${sp_str}"
    fi
    echo "$bar"
}

get_file_size() {
    local f="$1"
    if [[ ! -e "$f" ]]; then
        echo 0
        return
    fi
    stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo 0
}

get_time_ms() {
    local now
    now="$(date +%s%N 2>/dev/null || true)"
    if [[ "$now" =~ ^[0-9]{13,}$ ]]; then
        echo "${now:0:13}"
        return
    fi
    if [[ -f /proc/uptime ]]; then
        local up
        read -r up _ < /proc/uptime
        local sec=${up%.*}
        local cs=${up#*.}
        echo "$(( sec * 1000 + cs * 10 ))"
        return
    fi
    echo "$(( $(date +%s) * 1000 ))"
}

check_auth() {
    local code="$1"
    local ctx="${2:-}"
    if [[ "$code" == "401" || "$code" == "403" ]]; then
        echo "[CLIENT] [FATAL] Authentication failed${ctx:+ $ctx} (HTTP $code). A valid bearer token is required." >&2
        exit 1
    fi
}

curl_fetch() {
    local url="$1"
    local out="$2"
    local code
    code="$(curl -s -w "%{http_code}" -o "$out" "$url" || echo "000")"
    check_auth "$code" "${3:-}"
    [[ "$code" == "200" ]]
}

format_progress_line() {
    local prefix="$1"
    local filename="$2"
    local pct="$3"
    local cur="$4"
    local tot="$5"
    local spd="$6"
    local eta="$7"
    local max_width="${8:-80}"

    local limit=$(( max_width - 1 ))
    (( limit < 30 )) && limit=30

    local stats
    if [[ -n "$tot" ]]; then
        stats=" $(printf "%3d%%" "$pct") (${cur}/${tot}) ${spd} ETA ${eta}"
    else
        stats=" ${cur} (${spd})"
    fi

    local overhead=$(( ${#prefix} + 1 + ${#stats} ))
    local rem=$(( limit - overhead ))

    local bar_str=""
    if [[ -n "$tot" && rem -ge 24 ]]; then
        local bar_w=$(( rem - 20 ))
        (( bar_w > 14 )) && bar_w=14
        (( bar_w < 8 )) && bar_w=8
        local bar
        bar="$(get_progress_bar "$pct" "$bar_w")"
        bar_str=" [${bar}]"
    fi

    local tail="${bar_str}${stats}"
    local avail=$(( limit - ${#prefix} - 1 - ${#tail} ))
    local name="$filename"
    if (( ${#name} > avail )); then
        if (( avail >= 7 )); then
            local left=$(( (avail - 3) / 2 ))
            local right=$(( avail - 3 - left ))
            name="${filename:0:$left}...${filename: -right}"
        elif (( avail >= 4 )); then
            name="${filename:0:$(( avail - 3 ))}..."
        elif (( avail > 0 )); then
            name="${filename:0:$avail}"
        else
            name=""
        fi
    fi

    local line="${prefix} ${name}${tail}"
    local pad=$(( limit - ${#line} ))
    if (( pad > 0 )); then
        printf -v pad_str "%*s" "$pad" ""
        printf "%s%s" "$line" "$pad_str"
    elif (( ${#line} > limit )); then
        printf "%s" "${line:0:$limit}"
    else
        printf "%s" "$line"
    fi
}

CURRENT_CURL_PID=""
CURRENT_TMP_FILE=""
WAS_UPDATED=0

cleanup_download() {
    if [[ -n "${CURRENT_CURL_PID:-}" ]]; then
        kill "$CURRENT_CURL_PID" 2>/dev/null || true
        CURRENT_CURL_PID=""
    fi
    if [[ -n "${CURRENT_TMP_FILE:-}" && -f "${CURRENT_TMP_FILE:-}" ]]; then
        rm -f "$CURRENT_TMP_FILE" 2>/dev/null || true
        CURRENT_TMP_FILE=""
    fi
}
trap cleanup_download INT TERM

sync_file() {
    local name="$1"
    local expected_hash="$2"
    local total_size="${3:-0}"
    local file_idx="${4:-0}"
    local total_files="${5:-0}"

    if [[ "$name" == *".."* || "$name" == /* ]]; then
        echo "[ERROR] Path traversal blocked for $name" >&2
        return 1
    fi
    local dest="$TARGET/$name"
    local parent_dir
    parent_dir="$(dirname "$dest")"
    mkdir -p "$parent_dir"

    if [[ -f "$dest" && "$(calc_sha256 "$dest")" == "$expected_hash" ]]; then
        return 0
    fi

    local enc_name tmp="$parent_dir/.$(basename "$name").tmp.$$.$RANDOM"
    enc_name="$(url_encode "$name")"
    local download_url="$SERVER/api/download/$enc_name$TOKEN_QUERY"

    local is_tty=0
    [[ -t 1 ]] && is_tty=1

    local prefix="[SYNC]"
    if (( total_files > 1 && file_idx > 0 )); then
        prefix="[SYNC] [$file_idx/$total_files]"
    fi

    local cols=80
    if (( is_tty )); then
        cols=$(tput cols 2>/dev/null || echo 80)
        (( cols < 40 )) && cols=80
    fi

    local code_file
    code_file="$(mktemp)"
    CURRENT_TMP_FILE="$tmp"

    curl -s --connect-timeout 30 --speed-time 30 --speed-limit 100 -w "%{http_code}" -o "$tmp" "$download_url" > "$code_file" &
    CURRENT_CURL_PID=$!

    local start_time_ms
    start_time_ms="$(get_time_ms)"
    local loop_count=0
    local prev_bytes=0
    local instant_speed=0
    local cur_bytes=0

    while kill -0 "$CURRENT_CURL_PID" 2>/dev/null; do
        sleep 0.15
        cur_bytes="$(get_file_size "$tmp")"
        loop_count=$(( loop_count + 1 ))

        if (( loop_count % 3 == 0 )); then
            instant_speed=$(( (cur_bytes - prev_bytes) * 10 / 45 ))
            prev_bytes=$cur_bytes
        fi
        if (( instant_speed == 0 && cur_bytes > 0 )); then
            local est_elapsed=$(( (loop_count * 15) / 100 ))
            (( est_elapsed < 1 )) && est_elapsed=1
            instant_speed=$(( cur_bytes / est_elapsed ))
        fi

        if (( is_tty )); then
            local spd_str
            spd_str="$(format_speed "$instant_speed")"
            if (( total_size > 0 )); then
                local pct=$(( cur_bytes * 100 / total_size ))
                (( pct > 100 )) && pct=100
                local cur_str
                cur_str="$(format_bytes "$cur_bytes")"
                local tot_str
                tot_str="$(format_bytes "$total_size")"
                local eta_str="--:--"
                if (( instant_speed > 0 && cur_bytes < total_size )); then
                    local rem=$(( (total_size - cur_bytes) / instant_speed ))
                    eta_str="$(format_eta "$rem")"
                elif (( cur_bytes >= total_size )); then
                    eta_str="0s"
                fi
                local line
                line="$(format_progress_line "$prefix" "$name" "$pct" "$cur_str" "$tot_str" "$spd_str" "$eta_str" "$cols")"
                printf "\r%s" "$line"
            else
                local cur_str
                cur_str="$(format_bytes "$cur_bytes")"
                local line
                line="$(format_progress_line "$prefix" "$name" 0 "$cur_str" "" "$spd_str" "" "$cols")"
                printf "\r%s" "$line"
            fi
        fi
    done

    wait "$CURRENT_CURL_PID" 2>/dev/null || true
    CURRENT_CURL_PID=""

    local code
    code="$(cat "$code_file" 2>/dev/null || echo "000")"
    rm -f "$code_file"

    if (( is_tty )); then
        local limit=$(( cols - 1 ))
        (( limit < 30 )) && limit=30
        local verify_msg="${prefix} Verifying checksum for ${name}..."
        if (( ${#verify_msg} > limit )); then
            verify_msg="${verify_msg:0:$limit}"
        fi
        local pad=$(( limit - ${#verify_msg} ))
        (( pad < 0 )) && pad=0
        printf -v pad_str "%*s" "$pad" ""
        printf "\r%s%s" "$verify_msg" "$pad_str"
    fi

    check_auth "$code" "downloading $name"
    if [[ "$code" != "200" ]]; then
        rm -f "$tmp"
        CURRENT_TMP_FILE=""
        echo "[ERROR] Download failed for $name (HTTP $code)" >&2
        return 1
    fi

    if [[ "$(calc_sha256 "$tmp")" != "$expected_hash" ]]; then
        rm -f "$tmp"
        CURRENT_TMP_FILE=""
        echo "[ERROR] Checksum mismatch for $name!" >&2
        return 1
    fi

    mv "$tmp" "$dest"
    CURRENT_TMP_FILE=""
    WAS_UPDATED=1

    local end_time_ms
    end_time_ms="$(get_time_ms)"
    local dur_ms=$(( end_time_ms - start_time_ms ))
    (( dur_ms < 1 )) && dur_ms=1
    local final_size
    final_size="$(get_file_size "$dest")"
    local avg_speed=$(( (final_size * 1000) / dur_ms ))
    local final_str
    final_str="$(format_bytes "$final_size")"
    local final_spd_str
    final_spd_str="$(format_speed "$avg_speed")"
    local time_str
    if (( dur_ms < 1000 )); then
        time_str="${dur_ms}ms"
    else
        time_str="$(( dur_ms / 1000 )).$(( (dur_ms % 1000) / 100 ))s"
    fi

    if (( is_tty )); then
        local limit=$(( cols - 1 ))
        (( limit < 30 )) && limit=30
        printf -v blank "%*s" "$limit" ""
        printf "\r%s\r" "$blank"
    fi

    echo "[$(date +%T)] $prefix Received $name ($final_str) in $time_str ($final_spd_str) -> $dest"
}

sync_manifest() {
    local tmp_manifest
    tmp_manifest="$(mktemp)"
    if ! curl_fetch "$SERVER/api/manifest$TOKEN_QUERY" "$tmp_manifest"; then
        rm -f "$tmp_manifest"
        echo "[CLIENT] [ERROR] Manifest request failed" >&2
        [[ "$ONCE" == "true" ]] && exit 1
        return 1
    fi

    local tmp_list
    tmp_list="$(mktemp)"
    node -e '
        const manifest = JSON.parse(process.argv[1]);
        for (const [name, meta] of Object.entries(manifest.files || {})) {
            console.log(`${meta.name}\t${meta.sha256}\t${meta.size}`);
        }
    ' "$(cat "$tmp_manifest")" > "$tmp_list"
    rm -f "$tmp_manifest"

    local total_files=0
    if [[ -s "$tmp_list" ]]; then
        total_files="$(wc -l < "$tmp_list" | tr -d ' ')"
    fi

    local count=0
    local updated=0
    while IFS=$'\t' read -r fname fhash fsize; do
        [[ -z "$fname" ]] && continue
        count=$(( count + 1 ))
        WAS_UPDATED=0
        sync_file "$fname" "$fhash" "${fsize:-0}" "$count" "$total_files"
        if (( WAS_UPDATED == 1 )); then
            updated=$(( updated + 1 ))
        fi
    done < "$tmp_list"
    rm -f "$tmp_list"

    echo "[CLIENT] Remote check: $total_files file(s) verified, $updated updated."
}

# Initial synchronization
sync_manifest

if [[ "$ONCE" == "true" ]]; then
    echo "[CLIENT] Sync complete (--once). Exiting."
    exit 0
fi

echo "[CLIENT] Listening for real-time file updates..."

BACKOFF=1
MAX_BACKOFF=30

while true; do
    if [[ $BACKOFF -gt $MAX_BACKOFF ]]; then
        echo "[CLIENT] [FATAL] Connection lost. Retry timer (${BACKOFF}s) exceeded limit (${MAX_BACKOFF}s). Terminating." >&2
        exit 1
    fi

    curl_err="$(mktemp)"
    curl -N -sS -f -H "Accept: text/event-stream" "$SERVER/api/events$TOKEN_QUERY" 2>"$curl_err" | while read -r line; do
        if [[ "$line" =~ ^event:[[:space:]]*file_changed ]]; then
            read -r data_line
            if [[ "$data_line" =~ ^data:[[:space:]]*(.*) ]]; then
                node -e '
                    const d = JSON.parse(process.argv[1]);
                    if (d.file) console.log(`${d.file.name}\t${d.file.sha256}\t${d.file.size}`);
                ' "${BASH_REMATCH[1]}" | while IFS=$'\t' read -r fname fhash fsize; do
                    sync_file "$fname" "$fhash" "${fsize:-0}" 1 1
                done
            fi
        fi
    done || true

    err_output="$(cat "$curl_err" 2>/dev/null || echo "")"
    rm -f "$curl_err"

    if [[ "$err_output" =~ 401|403 ]]; then
        echo "[CLIENT] [FATAL] Authentication failed on event stream. A valid bearer token is required." >&2
        exit 1
    fi

    echo "[CLIENT] Connection interrupted. Reconnecting in ${BACKOFF}s..."
    sleep "$BACKOFF"
    BACKOFF=$(( BACKOFF * 2 ))
    sync_manifest || true
done
