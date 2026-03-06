# Nonlinear Video Editor Memo (Spec + To-Do Plan)

This memo defines a new, separate app inside this repository: a basic nonlinear video editor that reuses already converted videos as source media.

## 1) Product Intent

Build a lightweight editor with:

- Project management (create/select project from a JSON index).
- A timeline workspace with:
- one **Master Timeline** (final sequence). Should allow total video time selection. 
- multiple **Layer Timelines** (one per video layer/track).
- Layer selection + right sidebar inspector.
- Assigning existing converted videos to each layer.
- Horizontal panning of clips in time (start position in master timeline).
- Trim/crop-in and trim/crop-out handles per clip (non-destructive).
- Timeline zoom control.
- Frame-strip preview thumbnails (sampled via ffmpeg).
- Render context that executes a recipe:
- trim each layer clip to its selected in/out.
- then concatenate in master timeline order.
- Render queue + render logs in the stretch canvas, with output link in the right sidebar when done.

This is not a replacement of the current converter UI. It is a separate server entrypoint and separate frontend.

## 2) Scope for V1

V1 should include:
  
- Separate backend server entrypoint (for example `src/editor/index.js`).
- Separate frontend app (for example `public-editor/`).
- Editor projects persisted in JSON files.
- Left sidebar project list + add project.
- Timeline with selectable layers.
- Inspector to bind a layer clip to an existing converted video.
- Drag clip left/right for timeline position (`startMs`).
- Trim start/end (`trimInMs`, `trimOutMs`).
- Zoom slider for timeline scale.
- Frame-strip thumbnail generation (small sampled set).
- Render pipeline with status logs and preview.

Out of scope for V1:

- Audio mixing controls.
- Crossfades/transitions/effects.
- Time stretching/speed ramps.
- Multi-user collaboration.
- Undo/redo history (can be added later).

## 3) Reuse of Existing Media

Source media for editor layers must come from already generated converter outputs under existing project directories.

Expected source pattern:

- `db/input/dir-video-*/outputs/*.mp4|*.webm|*.mov`

Editor backend should expose a media browser endpoint that lists available converted videos with metadata (duration, size, width/height, codec if available).

## 4) Data Model (JSON Persistence)

### 4.1 Project index

Create a global editor index file:

- `db/editor/index.json`

Example:

```json
{
  "version": 1,
  "projects": [
    {
      "id": "ed-20260208-001",
      "name": "Episode rough cut",
      "createdAt": "2026-02-08T12:00:00.000Z",
      "updatedAt": "2026-02-08T12:00:00.000Z",
      "stateFile": "db/editor/projects/ed-20260208-001.json"
    }
  ]
}
```

### 4.2 Editor project state

Each editor project has one state file:

- `db/editor/projects/<projectId>.json`

Example:

```json
{
  "id": "ed-20260208-001",
  "name": "Episode rough cut",
  "timeline": {
    "zoom": 0.2,
    "durationMs": 180000,
    "masterOrder": ["layer-1", "layer-2", "layer-3"]
  },
  "layers": [
    {
      "id": "layer-1",
      "name": "Layer 1",
      "selected": false,
      "clip": {
        "sourceVideoId": "dir-video-abc/output-1.mp4",
        "sourcePath": "/media/input/dir-video-abc/outputs/output-1.mp4",
        "sourceDurationMs": 24000,
        "startMs": 0,
        "trimInMs": 0,
        "trimOutMs": 24000,
        "thumbnails": [
          "/media/editor/thumbs/....jpg"
        ]
      }
    }
  ],
  "lastRender": {
    "status": "idle",
    "outputPath": null,
    "logs": []
  },
  "createdAt": "2026-02-08T12:00:00.000Z",
  "updatedAt": "2026-02-08T12:00:00.000Z"
}
```

## 5) UI Layout Specification

### Left sidebar

- Project list (from `db/editor/index.json`).
- Add project button (V1 mandatory).
- Project selection state.

### Center workspace (stretch canvas)

- Top toolbar:
- timeline zoom control.
- render status indicator.
- Master timeline row at top.
- Layer rows below (one row per layer).
- Each layer row displays:
- clip block with sampled frame-strip thumbnails.
- visual selected state when row/clip is active.
- cold/hot/cold visual for trimmed area:
- left cold = trimmed-out head.
- middle hot = active kept segment.
- right cold = trimmed-out tail.

### Right sidebar (inspector)

When a layer is selected:

- media picker (existing converted videos).
- selected source media metadata (duration, resolution, size, codec if available).
- numeric controls (optional) for start/trim values.
- quick actions (clear clip, reset trims).

When the project render context is selected:

- render start button
- queue totals (segments, consolidated jobs, muted segments)
- per-render progress state
- last output file name and open-render link

## 6) Timeline Behavior Rules

- No time stretching in V1.
- Clip effective duration:
- `effectiveDuration = max(0, trimOutMs - trimInMs)`.
- Clip timeline span:
- starts at `startMs`.
- ends at `startMs + effectiveDuration`.
- Dragging clip horizontally updates `startMs`.
- Trim handles:
- left handle updates `trimInMs`.
- right handle updates `trimOutMs`.
- Always clamp:
- `0 <= trimInMs <= trimOutMs <= sourceDurationMs`.
- Zoom changes horizontal pixel-to-millisecond mapping only (does not change source timing).

## 7) Backend API Sketch (Editor Server)

Suggested endpoints (separate namespace/server):

- `GET /api/editor/health`
- `GET /api/editor/projects`
- `POST /api/editor/projects` (create project)
- `GET /api/editor/projects/:id`
- `PUT /api/editor/projects/:id` (save full state or patch)
- `GET /api/editor/media` (list converted source videos)
- `POST /api/editor/thumbnails` (generate frame-strip for one source clip)
- `POST /api/editor/render/:id` (start render job)
- `GET /api/editor/render/:id/status` (poll logs + status)

## 8) Thumbnail Generation

Purpose: visual representation in timeline blocks.

Behavior:

- For a selected source video, extract a small set of frames (for example 6-12).
- Store under:
- `db/editor/projects/<projectId>/thumbs/<layerId>/...jpg`
- Return URLs for UI rendering.

Implementation idea:

- Use ffmpeg with either:
- `fps=<n/duration>` strategy, or
- explicit timestamps (`-ss` per frame extraction loop).

## 9) Render Recipe (FFmpeg-Oriented)

Given current project state:

1. For each layer with a valid source clip:
- trim/crop by in/out:
- `-ss trimInSec -to trimOutSec -i source ...`
- output temp file in render workspace.
2. Order temp files by master timeline rule.
3. Concatenate into final output (concat demuxer or filter_complex strategy).
4. Persist render output path in project state.
5. Emit logs through status endpoint.

Suggested directories:

- `db/editor/projects/<projectId>/renders/<renderId>/`
- temp segment files + final output.

## 10) State Persistence Rules

- Any layer/project edit updates project JSON and `updatedAt`.
- Render status/logs should also be persisted so refresh does not lose progress context.
- One-to-one mapping required:
- UI timeline state <-> render recipe inputs.

## 11) Technical Architecture Notes

- Keep editor server isolated from existing converter server.
- Reuse existing ffmpeg helper patterns for spawn + error handling.
- Keep API payloads explicit and serializable (JSON only).
- Prefer idempotent saves for project state (`PUT` full state).

## 12) Phased To-Do Plan

### Phase 1: Bootstrap editor app

- Create editor server entrypoint (separate port, separate static folder).
- Add editor frontend skeleton with 3-column layout.
- Add `db/editor/index.json` and project state file utilities.

### Phase 2: Project management

- Implement project list API + create project API.
- Build left sidebar listing and create action.
- Persist and reload selected project.

### Phase 3: Timeline core

- Implement master row + layer rows rendering.
- Add layer selection state.
- Add clip horizontal drag for `startMs`.
- Add trim in/out handles with clamp logic.
- Add zoom slider mapped to timeline scale.

### Phase 4: Media association

- Implement `/api/editor/media` from existing converted outputs.
- Inspector media picker for selected layer.
- Show source metadata in inspector.

### Phase 5: Thumbnails

- Implement thumbnail generation endpoint + storage.
- Load and display frame-strip inside clip blocks.

### Phase 6: Rendering pipeline

- Build recipe compiler from project state.
- Implement per-layer trim process + concat final output.
- Add render logs/status endpoint.
- Show render logs and inline preview in UI.

### Phase 7: Hardening

- Validation for malformed state payloads.
- Better render failure messages.
- Basic integration tests for:
- create project.
- save/load timeline state.
- render output existence.

## 13) Acceptance Criteria (V1)

- User can create a project from left sidebar.
- User can select a layer and assign a converted video source.
- User can move clip in timeline and trim in/out.
- User can zoom timeline.
- User sees sampled thumbnails in clip block.
- User can render and see progressive logs.
- Final output is previewable inline after completion.
- Reopening a project restores full timeline/layer state.

## 14) Open Decisions (to confirm before implementation)

- Single clip per layer in V1, or multiple clips per layer.
- How master timeline order is determined:
- by row order, by explicit list, or by clip start time.
- Default render format and profile.
- Whether audio tracks are preserved, mixed, or dropped in V1.
