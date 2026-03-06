# Edit or Transcribe Your Service

- Author: Marcio Galli
- Date: 2026-03-06

## Introduction

The new transcriber service should be implemented as a per-layer editor service. The UI action path is already clear (`public-editor/editor.js`), and the backend service orchestration is split into API routes plus a dedicated transcription service module.

Implementation focus now splits into two practical modes:
- `gpt-4o-transcribe` remains valid for plain transcript text and lightweight JSON storage.
- `whisper-1` becomes the current timeline-aligned path when timestamped transcript structure is required for editor operations.

## Initial Analysis

### Analysis of the current code

The current editor stack supports per-layer operations and already stores all project state in `db/editor/projects/<projectId>.json`. That lets the transcriber behave like any other layer service: each layer can have an attached transcription record without changing the rest of the timeline model.

At implementation time, the call chain is now:
- UI button -> transcriber service object (`public-editor/editor.js`)
- API route in `src/editor/index.js`
- FFmpeg extraction + OpenAI request in `src/editor/services/transcription-service.js`
- Persisted payload + file metadata saved back into layer state

This makes the transcribe pipeline auditable and replaceable without cross-wiring converter endpoints.

## OpenAI Audio API (plain text and timeline-aligned modes)

- Endpoint family: `/v1/audio/transcriptions` and `/v1/audio/translations`.
- The transcribe endpoint accepts files in: `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm`.
- File limit is 25 MB per upload request.
- `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and `gpt-4o-transcribe-diarize` are the current transcribe model family; this service path uses `gpt-4o-transcribe`.
- For this model, `json` or `text` response formats are supported.
- `gpt-4o-transcribe` currently supports prompt options and, where available, logprob-related metadata.
- `gpt-4o-transcribe-diarize` adds speaker-level JSON segmentation (`diarized_json`) and needs `chunking_strategy` when audio exceeds 30 seconds.
- For translation use cases, only `whisper-1` is supported and output is English-only.
- `timestamp_granularities` is available with `whisper-1`; `gpt-4o-transcribe` is JSON/text oriented in this implementation.

## Timestamped Transcript Path For Timeline Work

- When the objective is transcript-to-timeline alignment, the API can return structured timing data instead of plain text only.
- The practical path is: video -> extracted audio -> transcription request with timestamps -> structured JSON segments -> later timeline or subtitle logic.
- `whisper-1` currently supports `response_format="verbose_json"` with `timestamp_granularities` for `segment`, `word`, or both.
- Segment timestamps are the strongest default for editing workflows because they map more cleanly to subtitle cues, quote extraction, and clip boundaries than per-word output.
- Example structured segment shape:

```json
{
  "segments": [
    {
      "start": 12.4,
      "end": 16.2,
      "text": "This is the first important idea."
    }
  ]
}
```

- This means the transcript payload can directly carry time windows that later drive automatic clip extraction from the source video.
- For multi-speaker recordings, `gpt-4o-transcribe-diarize` is the future branch for speaker-aware segment objects, but the first editor implementation should stay simpler and focus on timestamped segment JSON.

## Design

### Proposed service pipeline (editor layer-bound)

1. User selects a layer with a source clip in the right-side tools area.
2. `Convert to Audio` triggers local extraction (FFmpeg) into the per-layer transcript directory.
3. `Run Transcription` sends that audio file with `model: gpt-4o-transcribe` to `/v1/audio/transcriptions`.
4. For timeline-aware transcripts, `Run Transcription` should use `whisper-1`, `response_format: verbose_json`, and `timestamp_granularities: ["segment"]`.
5. Response metadata and transcript payload are persisted on layer state, including whether the transcript is segment-oriented and how many segments were returned.
6. The transcript JSON is available from the same panel and can later feed subtitle views, quote scoring, and time-bound video cuts.

### Architectural/Layout Stability Point

- Keep the right-side sidebar container transparent and minimally styled; keep subpanels emphasized.
- Keep center stretch area as a single large context swap region: timeline is default, logs is alternate view.
- Do not introduce extra nested tab controls in the middle area.
- Keep transcriber concerns inside the layer inspector so timeline and log behavior stay independent.
- Keep the right-side tool subpanels (`Video`, `Transcriber`) as independent sibling panels with separate collapsible state, and do not wrap them in one emphasized parent container.

## Notes on large inputs and segment control

For long recordings, the first practical path is to split audio before transcription to stay within the 25 MB request limit. This is done with local segmentation (FFmpeg or similar), then transcribing each chunk in sequence and reconciling timings using segment boundaries that are derived from chunk offsets. That gives practical control of timing/segment boundaries without waiting on a single monolithic request and makes it easier to map transcript segments back to timeline edits.

If segment-level voice control is needed, split at meaningful boundaries (scene boundaries, pauses, or fixed intervals with overlap) before transcription, then maintain an index from segment index to timeline offsets when rendering cues.

## Changes

- The editor transcriber service now prepares for timeline-aware transcript JSON by using timestamp-capable request settings for the transcription run.
- Persisted layer transcription state now carries transcript structure metadata such as response format, timestamp mode, segment count, and word count.
- The right-side transcriber panel now exposes whether the stored transcript is plain text, word-oriented, or segment-oriented so the next editing stage can rely on visible state instead of implicit assumptions.
