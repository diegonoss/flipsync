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
else
    echo "  Auth:        None (Open Access)"
fi
echo "================================================================"

calc_sha256() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        node -e "const fs=require('fs'),crypto=require('crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$file"
    fi
}

sync_file() {
    local name="$1"
    local expected_hash="$2"
    local dest="$TARGET/$name"
    local parent_dir
    parent_dir="$(dirname "$dest")"
    mkdir -p "$parent_dir"

    if [[ -f "$dest" ]]; then
        local current_hash
        current_hash="$(calc_sha256 "$dest")"
        if [[ "$current_hash" == "$expected_hash" ]]; then
            return 0
        fi
    fi

    local encoded_name
    encoded_name="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$name" 2>/dev/null || echo "$name")"
    local url="$SERVER/api/download/$encoded_name"
    if [[ -n "$TOKEN" ]]; then
        local encoded_token
        encoded_token="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$TOKEN" 2>/dev/null || echo "$TOKEN")"
        url="$url?token=$encoded_token"
    fi

    local tmp="$parent_dir/.$(basename "$name").tmp.$$"
    curl -sSfL "$url" -o "$tmp"
    local downloaded_hash
    downloaded_hash="$(calc_sha256 "$tmp")"

    if [[ "$downloaded_hash" != "$expected_hash" ]]; then
        rm -f "$tmp"
        echo "[ERROR] Checksum mismatch for $name!"
        return 1
    fi

    mv "$tmp" "$dest"
    echo "[$(date +%T)] [SYNC] Transferred $name -> $dest"
}

sync_manifest() {
    local url="$SERVER/api/manifest"
    if [[ -n "$TOKEN" ]]; then
        local encoded_token
        encoded_token="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$TOKEN" 2>/dev/null || echo "$TOKEN")"
        url="$url?token=$encoded_token"
    fi

    local manifest_json
    manifest_json="$(curl -sSfL "$url")"

    node -e '
        const manifest = JSON.parse(process.argv[1]);
        for (const [name, meta] of Object.entries(manifest.files || {})) {
            console.log(`${meta.name}\t${meta.sha256}\t${meta.size}`);
        }
    ' "$manifest_json" | while IFS=$'\t' read -r fname fhash fsize; do
        sync_file "$fname" "$fhash"
    done
}

# Initial synchronization
sync_manifest

if [[ "$ONCE" == "true" ]]; then
    echo "[CLIENT] Sync complete (--once). Exiting."
    exit 0
fi

echo "[CLIENT] Listening for real-time file updates..."

BACKOFF=2
while true; do
    url="$SERVER/api/events"
    if [[ -n "$TOKEN" ]]; then
        local encoded_token
        encoded_token="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$TOKEN" 2>/dev/null || echo "$TOKEN")"
        url="$url?token=$encoded_token"
    fi

    # Stream SSE via curl
    curl -N -sSfL -H "Accept: text/event-stream" "$url" | while read -r line; do
        if [[ "$line" =~ ^event:[[:space:]]*file_changed ]]; then
            read -r data_line
            if [[ "$data_line" =~ ^data:[[:space:]]*(.*) ]]; then
                json_str="${BASH_REMATCH[1]}"
                node -e '
                    const d = JSON.parse(process.argv[1]);
                    if (d.file) console.log(`${d.file.name}\t${d.file.sha256}\t${d.file.size}`);
                ' "$json_str" | while IFS=$'\t' read -r fname fhash fsize; do
                    sync_file "$fname" "$fhash"
                done
            fi
        fi
    done || true

    echo "[CLIENT] Connection interrupted. Reconnecting in ${BACKOFF}s..."
    sleep "$BACKOFF"
    BACKOFF=$(( BACKOFF < 15 ? BACKOFF * 2 : 15 ))
    sync_manifest
done
