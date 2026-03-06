# Clipping UI From Transcript Segments

- Author: Marcio Galli
- Date: 2026-03-06

## Introduction

This memo defines a new `Clipping` UI that comes after the transcriber service. The clipping flow uses transcript segments as its first provisioning source, so the first clip pass is generated directly from segment boundaries.

The clips are not a replacement for the existing layer model. They are intermediary clip objects associated with the existing layer video. In other words, a layer still carries the source video and its timeline position, while the clip collection is relative to that same video and is used for more detailed cut work.

## Design

### New Right-Side Panel

- Add a new right-side sibling panel named `Clipping`. This panel lives after `Transcriber`. It is collapsible like the other service panels.

- Its first action is `Provision Clips`, `Provision Clips` creates one clip per transcript segment, using each segment start and end as the initial clip bounds. After provisioning, the panel should show the selected clip inspector, not another video preview.

### Clip Data Understanding

- Clips are associated with the existing source video already attached to the selected layer.
- Clips are conceptually closer to transcript segments than to layers.
- The layer still defines where the whole video sits in the project timeline.
- The clip collection is relative to that layer video and operates inside that source range.
- Each clip should carry over the transcript text that came from the original segment used to provision it.

### Center Stretch Area

- When the clipping mode is active, the center stretch area changes from the current multi-layer horizontal timeline into a clip-focused vertical view.
- Inside the center canvas area, the left column for the rows becomes a vertical clip row column.
- The draggable pan behavior for this view belongs to that row-label column inside the center canvas area, and it scrolls vertically.
- The page grows downward as more clips exist.
- The timeline portion of each row remains horizontally oriented because each clip still has a start and end inside the same source video.

### Clip Row Structure

- Each row represents one clip.
- Each row shows the clip as a horizontal visual range.
- The clip text should appear inline in that row, inside the actual clip timeline representation.
- The user should still be able to see shaded media before the active clip start and after the active clip end.
- This is important so the user can adjust the beginning and end of the clip by dragging horizontally. By the way, the adjustment here is not on the timeline. It's going to be done by the inspector. 
- The beginning and end should behave like independent trim handles.
- If the clip start is moved toward the minus side of the source timeline, the clip above it should be adjusted as well so the shared boundary stays coherent.
- If the clip end is moved toward the right, the next clip should be adjusted as well, because that edit changes the shared boundary with the following clip.

### Selection and Sync

- Clicking a clip row selects that clip.
- Clicking a clip row also moves the playhead to the beginning of that clip.
- That sync happens through the existing `Video` panel preview.
- The `Clipping` panel does not need to duplicate the video preview.
- The `Clipping` panel acts as the inspector for the selected clip attributes.

### Clipping Inspector

- The clipping inspector should show the selected clip.
- It should show the current clip start.
- It should show the current clip end.
- It should show the current clip text in an editable text area.
- It should support direct value edits for start and end.
- It should support increase/decrease controls for those values.
- It should allow the user to edit the text manually, because clip boundary changes may require wording adjustments.
- It should show the current playhead position when relevant.
- It should offer `Split Clip`.
- It should offer `Delete Clip`.

### Save Behavior

- Clip edits participate in the same project save flow as the rest of the editor state.
- If the user changes clip bounds, clip text, mute state, or clip structure, that should mark the project as dirty.
- The top `Save` action should persist clipping changes as well, including edited clip text, mute state, and delete/split results.

### Playhead Behavior

- The video preview remains the playback reference.
- Play and pause continue to act on the video preview.
- The playhead should represent the current source position for the selected clip context.
- When the user taps a clip row, the playhead should always move to the beginning of that row.
- The clipping workflow does not need separate timeline playback controls inside the clip rows themselves.

### Split Behavior

- Splitting happens at the current playhead position for the selected clip.
- The split creates a new clip after the current one.
- The new clip starts at the split position.
- The previous clip ends at the split position.
- The operation preserves continuity between the current clip and the next clip region.
- This is a split-at-playhead action, not a generic separate clip action.

### Delete Behavior

- The selected clip can be deleted from the clipping inspector.
- Deleting a clip removes that intermediary clip segment from the clip collection for the current source video context.
- Deleting a clip should also heal the neighboring boundary instead of leaving a gap.
- The preferred behavior is to take the end of the prior clip and extend it so that it meets the beginning of the next clip region, preserving continuity after deletion.

### Mute Behavior

- Each clip should have a `muted` state.
- Muting a clip is a clip attribute change only; it marks that clip as muted.
- The clip UI should expose an action to mute and unmute the selected clip.
- In the clip timeline visuals, a muted clip should look visibly different.
- The preferred visual treatment is a whitish overlay or a blur treatment over that clip so the muted state is obvious in the canvas.

## Interaction Summary

1. User transcribes the selected layer video into timestamped segments.
2. User opens the `Clipping` panel.
3. User runs `Provision Clips`.
4. The system creates initial clips one-to-one from transcript segments.
5. The center area switches into the vertical clip view.
6. User clicks a clip row.
7. The row becomes selected and the playhead jumps to that clip start.
8. The `Video` panel preview syncs to that position.
9. The `Clipping` panel inspector shows the selected clip start, end, and actions.
10. User can trim start/end, split at the current playhead, or delete the selected clip.

## To-Do Plan

- Add the new `Clipping` right-side sibling panel.

- Define a persisted clip collection associated with the selected layer video.

- Implement `Provision Clips` from transcript segment start/end pairs.

- Add the vertical clip-focused center view with vertical drag-pan on the left row column.

- Implement clip row selection and sync the existing video preview to the selected clip start.

- Add the clip inspector with start/end editing, playhead-aware split, and delete actions.

- Implement horizontal trim interaction for clip start and clip end while preserving visible shaded media outside the active clip bounds.

## Changes

- Added persisted clipping state to the project model so each layer can carry a clip collection with `selectedClipId`, clip bounds, text, and mute state.

- Added a new right-side `Clipping` sibling panel with `Provision Clips`, selected clip inspection, text editing, mute toggle, split, delete, and start/end step controls.

- Added a clip-focused center canvas mode that activates when the `Clipping` panel is expanded, switching the stretch area from the multi-layer timeline into a vertical clip editor.

- Implemented clip provisioning from transcript segment start/end boundaries and transcript text.

- Implemented clip row selection so the existing `Video` preview seeks to the clip start and the playhead moves to the same source position.

- Added vertical drag-pan on the clip row-label column inside the center canvas area.

- Added inline clip text rendering inside the clip canvas rows and a muted visual treatment for muted clips.

- Implemented clip boundary editing rules so moving a shared boundary adjusts the neighboring clip instead of leaving gaps.
