# Updating the System with a Transcriber and a Video Cut Element

- Author: Marcio Galli
- Date: 2026-03-06

## Introduction

The system already supports multiple source projects as isolated folders and uses ffmpeg/ffprobe for conversion and editor rendering. We keep the established **editor view** workflow and focus this change there (`src/editor/index.js` + `public-editor/`), instead of building a separate converter-side editor flow.

The target behavior is to add a dedicated transcriber capability in the right-side tool area while continuing to keep all timeline editing in the middle stretch timeline. This keeps the work anchored to an already stable composition model.

## Initial Analysis

### Analysis of the current code

The architecture already has two relevant runtimes:
- `src/server.js`: source upload and conversion.
- `src/editor/index.js`: per-project editable timelines, persistence, and render orchestration.

The editor already follows a strong per-project contract:
- `db/editor/index.json` stores discoverable editor project metadata.
- `db/editor/projects/<projectId>.json` stores project timeline state.
- `db/editor/projects/<projectId>/` is already the right artifact boundary for editor-generated files and outputs.

Layer and clip structures are already explicit and suitable for extension:
- Each layer carries `clip` with source path, start/trim values, and media binding.
- Selection and timeline rendering are already driven from `state.project.layers`.
- Layer/state merge and normalization paths can be extended to persist additional tool metadata without affecting existing rendering behavior.

From this baseline, adding transcribe means extending existing persistence and adding service endpoints, not replacing editor mechanics.

## Changes

- Added dedicated transcription service backend module: `src/editor/services/transcription-service.js`.
- Added editor OpenAI config loading in `src/editor/config.js`, including fallback to `OLD_KEY` in `config.json` for documentation/traceability.
- Extended editor API in `src/editor/index.js`:
  - `POST /api/editor/transcribe/:projectId/:layerId/audio` (local FFmpeg extraction to MP3)
  - `POST /api/editor/transcribe/:projectId/:layerId/transcript` (OpenAI transcription call)
  - `GET /api/editor/transcribe/:projectId/:layerId` (load persisted transcription payload)
- Extended state normalization/persistence to include `transcription` on layers:
  - Incoming merge and persisted project loading now sanitize and persist transcription metadata.
- Added frontend transcriber service object in `public-editor/editor.js` (`transcribeCaptionerService`) with explicit endpoint methods.
- Added right-side **Transcribe Captioner** UI in the existing tool sidebar so each selected layer can:
  - extract audio
  - request transcription
  - open saved transcript JSON
  - see audio/transcript size metadata and status
- Added render-center log/timeline switching behavior so the middle stretch area is now a single workflow region controlled by right-side tab selection.
- Updated editor styling to keep parent sidebars transparent while preserving stronger panel treatment for tool/log subpanels.
- Reworked right-side tool stacking so `Video` and `Transcriber` are sibling collapsible subpanels directly under the tools context, with no aggregate bright wrapper on the parent container.

## Design

The right context remains the place for service actions, not a separate editor composer route. The transcriber is treated as a layer service panel integrated into the existing right-side tools shell.

- Tools/Logs are tabbed from the right side.
- Logs are shown by swapping the center stretch area between timeline and log view.
- The timeline remains the canonical editing surface for composition, zoom, add layer, save, and render actions.
- Transcription state is layer-bound and reloaded/saved as part of project persistence.

### Architectural/Layout Stability Note

- Keep the left/right sidebar parent containers visually minimal (transparent, no hard border emphasis, no extra contrast compared to subpanels).
- Keep action subpanels visually stronger so they stand out as intentional interaction surfaces.
- Do not add nested center tabs for logs; the center region must remain a single swap surface driven by right-side controls.

### Major Layout Styling Decision (Sibling Panel Pattern)

- Right-side tools context should not use a shared visual wrapper around service panels.
- `Video` and `Transcriber` are now rendered as independent, bright sibling panels, each with its own collapse state and header/action controls.
- Parent `#tools-tab-panel` / parent tab body is intentionally muted/transparent with no dominant background or border emphasis.
- Spacing between the sibling panels is intentional (increased to `20px`) so each surface remains visually separable while keeping the same sidebar workflow.
