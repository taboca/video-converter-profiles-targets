#!/usr/bin/env bash
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required but not found in PATH." >&2
  exit 1
fi

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <input-file> <output-file> [max-width] [max-height] [crf]" >&2
  echo "Example: $0 db/input/source.mp4 db/output/source-720p.mp4 1280 720 24" >&2
  exit 1
fi

INPUT="$1"
OUTPUT="$2"
MAX_WIDTH="${3:-960}"
MAX_HEIGHT="${4:-540}"
CRF="${5:-24}"

echo "Converting:"
echo "  input:  $INPUT"
echo "  output: $OUTPUT"
echo "  scale:  <= ${MAX_WIDTH}x${MAX_HEIGHT}"
echo "  crf:    ${CRF}"

ffmpeg -y \
  -i "$INPUT" \
  -vf "scale=${MAX_WIDTH}:${MAX_HEIGHT}:force_original_aspect_ratio=decrease" \
  -c:v libx264 -preset medium -crf "${CRF}" \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  "$OUTPUT"

echo "Done."
