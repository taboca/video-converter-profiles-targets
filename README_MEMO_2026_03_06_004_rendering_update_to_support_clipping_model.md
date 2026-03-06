# Rendering Update To Support Clipping Model

- Author: Marcio Galli
- Date: 2026-03-06

## Introduction

The editor now includes a clipping system that allows the user to create, split, delete, trim, and mute clips derived from transcript segments.

Clips are intermediary objects attached to a video inside a layer. They define which portions of the source video should appear in the final output.

The renderer already understands layers, but it does not yet interpret the clip collection associated with each layer.

This memo defines the required update to the rendering pipeline so that rendering respects clip boundaries and mute state.

## Scope of This Update

This update concerns the per-layer rendering stage.

Each layer that contains a video source must render according to the clip collection associated with that layer.

The renderer must resolve the clips of that layer into a single staged media output representing the edited result of that layer.

If the project contains only one video layer, the result of this stage already becomes the final output.

If the project contains multiple layers, this stage produces the resolved media for each layer. A later stage may then combine those layer outputs according to the existing multi-layer compositing logic.

Handling the full multi-layer composition is outside the scope of this memo, but the implementation must remain compatible with it.

Note: in the layer model, the last layer is visually above the others.

## Rendering Principle

The renderer must trust the clip collection stored in the project JSON.

The renderer should not attempt to reconstruct editing history.

Operations such as:

- split
- delete
- ripple adjustments
- boundary propagation

belong to the editor phase only.

By the time rendering begins, the clip collection stored in the project represents the final state.

Rendering must simply respect that state.

## Rendering Model

Rendering remains a project-level action.

When the user triggers render, the system should:

1. Iterate through project layers.
2. For each layer that contains a video source, read the clip collection attached to that layer.
3. Generate rendering operations for each clip that is not muted.

Muted clips must not generate rendering jobs.

## Clip-Level Rendering Jobs

Each active clip generates one FFmpeg trimming operation against the source video.

Conceptually:

```text
ffmpeg trim sourceVideo start end -> staged clip output
```

Example clip collection:

```text
Clip 1  start=0   end=10   muted=false
Clip 2  start=10  end=15   muted=true
Clip 3  start=15  end=22   muted=false
```

Render jobs produced:

```text
clip_001  trim 0-10
clip_002  trim 15-22
```

Clip 2 is skipped because it is muted.

## Rendering Queue

Trim operations should be executed through a rendering queue.

The queue should:

- process trimming operations
- stage the resulting media fragments
- preserve deterministic ordering
- expose per-job status so the editor can show pending, running, completed, and failed work

## Queue Consolidation

The queue should not blindly create one render job for every active clip object.

If two active clips are contiguous and there is no muted clip gap between them, they should be consolidated into one render job before FFmpeg execution.

Example:

```text
Clip 1  start=0   end=10  muted=false
Clip 2  start=10  end=18  muted=false
Clip 3  start=18  end=22  muted=true
Clip 4  start=22  end=30  muted=false
```

Queue produced:

```text
job_001  trim 0-18   sourceSegments=2
job_002  trim 22-30  sourceSegments=1
```

This reduces unnecessary FFmpeg work while preserving the effective editorial result.

## Staging Output

Each trimming operation produces a staged media fragment.

Example:

```text
/render_stage/
  clip_001.mp4
  clip_002.mp4
```

These fragments represent the edited clip sequence for the layer.

## Final Concatenation (Per Layer)

After all trim jobs complete, the system should concatenate the staged clip fragments to produce the final resolved media for that layer.

Conceptually:

```text
concat clip_001.mp4
concat clip_002.mp4
```

This produces a single continuous video output representing the final timeline of that layer.

If the project contains only one layer, this becomes the final render.

If the project contains multiple layers, this output is passed to the multi-layer composition stage.

## Layer Preference And Overlap

- The renderer should trust layer start positions and layer ordering when multiple resolved layer outputs overlap.
- The visually higher layer takes precedence.
- In the current model, when a higher layer begins while a lower layer is still active, the lower layer output should end at that higher layer start boundary.
- This means the overlap is resolved by cutting the lower layer sequence at the start of the higher layer sequence.
- The system may still pre-render all clips for all layers before this visibility resolution step.

## Final Crop Direction

- The old project-level `Final Crop In/Out` concept should not drive the clipping-aware render path.
- In the clipping model, the effective final duration should come from the resolved clips and resolved layers themselves.
- If the user wants shorter output, that edit belongs at clip or segment level, not as a second editorial crop above the whole project.
- The editor UI should no longer expose the old final crop controls in the project inspector for the clipping-aware render path.
- Project summary metrics should instead show expected output values computed from the current clip and layer state.

## Refactoring Requirement

The renderer must be updated so that it:

- reads the clip collection associated with each layer
- skips muted clips
- consolidates adjacent active clips into fewer render jobs when no muted gap exists between them
- executes those jobs through a render queue
- stages clip outputs
- concatenates staged clips to produce the resolved media for the layer

## Render UI Integration

Rendering is still a project-level action, but it is no longer initiated from the top toolbar.

The project summary area should open a dedicated Render context.

That Render context must provide:

- a queue view in the stretch canvas area
- the render logs beside that queue view
- a render inspector in the right sidebar
- queue totals such as source segments and consolidated jobs
- the last output file reference and an `Open Render` link in the render inspector

The button in the project summary opens this Render context.
The actual render execution control lives inside the render inspector itself.

The existing renderer already supports layers, but it must be extended to interpret the clip model.

## Expected Outcome

After this update:

- rendering respects clip start and end boundaries
- muted clips are skipped
- each layer resolves its clip collection into a single rendered media output
- the pipeline remains compatible with multi-layer compositing
- the final video reflects the clipping decisions made in the editor

## Changes

- Updated the render pipeline in `src/editor/index.js` so rendering is now clip-aware on a per-layer basis.
- The renderer now reads `layer.clipping.clips` when present and treats those clips as the authoritative render plan for that layer.
- Muted clips are skipped and do not produce trim jobs.
- Active clips are consolidated into fewer render jobs when their ranges touch and no muted break exists between them.
- The persisted render state now tracks queue summary data and per-job execution state.
- Each consolidated render job now generates a staged FFmpeg trim output under the render root before concatenation.
- Each layer now produces its own resolved media output by concatenating its staged clip fragments.
- The final project render now uses those resolved layer outputs as the input to the last stage of the render pipeline.
- The clipping-aware render path no longer applies the old project-level final crop logic.
- When multiple resolved layers overlap, the final stage now prefers the visually higher layer and cuts the lower layer sequence at the overlap boundary.
- The project inspector now reflects expected clip-aware output metrics instead of the old final crop controls.
- The editor UI now opens rendering through a dedicated Render context with queue, logs, inspector controls, and moved output link placement.
- Existing non-clipping projects remain supported through a legacy fallback that renders the layer trim range as a single clip when no clip collection exists yet.
