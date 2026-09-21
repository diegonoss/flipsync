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

calc_sha256() {
    local f="$1"
    command -v sha256sum >/dev/null 2>&1 && sha256sum "$f" | awk '{print $1}' && return
    command -v shasum >/dev/null 2>&1 && shasum -a 256 "$f" | awk '{print $1}' && return
    node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" "$f"
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

sync_file() {
    local name="$1"
    local expected_hash="$2"
    local dest="$TARGET/$name"
    local parent_dir
    parent_dir="$(dirname "$dest")"
    mkdir -p "$parent_dir"

    if [[ -f "$dest" && "$(calc_sha256 "$dest")" == "$expected_hash" ]]; then
        return 0
    fi

    local enc_name tmp="$parent_dir/.$(basename "$name").tmp.$$"
    enc_name="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$name" 2>/dev/null || echo "$name")"

    if ! curl_fetch "$SERVER/api/download/$enc_name$TOKEN_QUERY" "$tmp" "downloading $name"; then
        rm -f "$tmp"
        echo "[ERROR] Download failed for $name" >&2
        return 1
    fi

    if [[ "$(calc_sha256 "$tmp")" != "$expected_hash" ]]; then
        rm -f "$tmp"
        echo "[ERROR] Checksum mismatch for $name!" >&2
        return 1
    fi

    mv "$tmp" "$dest"
    echo "[$(date +%T)] [SYNC] Transferred $name -> $dest"
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

    node -e '
        const manifest = JSON.parse(process.argv[1]);
        for (const [name, meta] of Object.entries(manifest.files || {})) {
            console.log(`${meta.name}\t${meta.sha256}\t${meta.size}`);
        }
    ' "$(cat "$tmp_manifest")" | while IFS=$'\t' read -r fname fhash fsize; do
        sync_file "$fname" "$fhash"
    done
    rm -f "$tmp_manifest"
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
                    sync_file "$fname" "$fhash"
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
