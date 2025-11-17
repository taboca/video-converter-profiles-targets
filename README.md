# Video Converter Smaller

An ffmpeg-powered control room for slimming vertical videos. Drop clips onto the stack, probe codecs and file sizes, dial in a render profile, and compare the before/after streams side-by-side. Every upload is isolated inside its own workspace directory (`dir-video-uuid`) so that the original clip and all of its outputs live together.

## Features

- ⚡️ Drag-and-drop uploader that creates a scoped project directory for each video (`db/input/dir-video-xxxx/`).
- 🧪 Automatic `ffprobe` runs on both the source clip and every render to surface duration, codec, resolution, bitrate, and file size.
- 🎚️ Opinionated render profiles plus manual overrides for width, height, CRF, format, and FPS.
- 🗂️ Output history per video with quick toggles to review older renders from the right-hand panel.
- 🔁 Simple REST API (`/api/upload`, `/api/videos`, `/api/convert`) that can be reused by other tools or scripts.

## Requirements

- Node.js 18+ (for `crypto.randomUUID` and modern syntax)
- `ffmpeg` and `ffprobe` available on your `$PATH`

## Getting Started

1. Install dependencies: `npm install`
2. Start the server:
   - Development with automatic reload: `npm run dev`
   - Production: `npm start`
3. Open [http://localhost:4000](http://localhost:4000) and drop a video into the left sidebar.

## Workflow Overview

1. **Drop or browse videos** – The left rail now includes a “Drag videos here” tray. Each file you drop is streamed to `/api/upload`.
2. **Per-video directories** – The backend creates `db/input/dir-video-<uuid>/` with:
   ```
   db/
     input/
       dir-video-1234/
         metadata.json
         my-clip.mp4
         outputs/
           my-clip-mp4-2024-03-01T12-00-00.mp4
   ```
3. **Inspect probes** – Selecting a clip loads its ffprobe metadata (size, resolution, duration, bitrate) in the left panel while the right panel shows the latest render (plus history chips to toggle older ones).
4. **Render** – Choose a profile or set custom sizing, then hit **Render**. Outputs land inside that video’s `outputs/` folder and are available immediately in the comparison view.

## API 

- `GET /api/health` – quick readiness probe.
- `GET /api/profiles` – built-in render presets.
- `GET /api/videos` – list of uploaded videos along with probes and per-video outputs.
- `POST /api/upload` – accepts `multipart/form-data` (`videos[]`) and stores each file in its own directory.
- `POST /api/convert` – body includes `projectId`, sizing options, and optional profile ID.
- `GET /api/output` – flattened view of every render across all projects.

## Tips

- Keep `db/input` under version control ignore rules; it holds user-generated content.
- Because `ffmpeg` writes directly into each project’s `outputs/` directory, you can inspect or share renders straight from `db/input/dir-video-*/outputs/`.
- The UI surfaces file size for both the original clip and every render, so it’s easy to confirm savings before sharing the output.

## Educational Goal

This experiment helps authors, educators, and engineers see why some automated renderers produce blank thumbnails, and how loading strategy impacts perceived completeness.

MIT License Copyright (c) 2025 Marcio S. Galli

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Marcio’s Additional Terms

LIFE LIFE LIFE PROVIDED “AS IS” WITHOUT WARRANTIES OF ANY KIND. THE FOLLOWING TERMS AND CONDITIONS GOVERN YOUR USE OF THIS SERVICE AND ANY OTHER RELATED MATERIAL. IF YOU DO NOT AGREE TO THE TERMS AND CONDITIONS PROVIDED HERE, DO NOT USE THE SERVICE.

UNDER NO CIRCUMSTANCES, INCLUDING, BUT NOT LIMITED TO, ANY CIRCUMSTANCE, SHALL THIS SERVICE, ITS CREATOR AND/OR PARENT ENTITIES OR AFFILIATES BE LIABLE FOR ANY DIRECT OR INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES FROM THE DIRECT OR INDIRECT USE OF, OR THE INABILITY TO USE.

THIS SERVICE SHOULD NOT BE USED FOR MISSION CRITICAL APPLICATIONS, SUCH AS AIRCRAFT CONTROL, RADAR MONITORING, GLOBAL TERMONUCLEAR WAR CONTROL. LIFE, THOUGHT, CONTENT, OR ANY OTHER RELATED MATERIAL, IS SUBJECT TO FAILURE OR CHANGES WITHOUT PRIOR NOTICE. THIS AGREEMENT IS EFFECTIVE TIL TERMINATED BY THE SERVICE CREATOR, AT ANY TIME WITHOUT NOTICE. IN THE EVENT OF FINAL TERMINATION, YOU ARE NO LONGER AUTHORIZED TO LIVE IN, ENJOY, CREATE, MODIFY, AND EVOLVE. USE THIS AT YOUR OWN RISK AND, JUST ENJOY.

Say thanks if this helped you 💛, the bitcoin address:

bc1qd7y7d2875ujj5uzm2eufe5zjj42ps0ye6g9cq5

