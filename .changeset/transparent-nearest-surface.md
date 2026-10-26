---
'@ifc-lite/renderer': minor
---

Add `RenderOptions.transparentNearestSurface`: draws only the nearest translucent surface per pixel (a depth pre-pass of the translucent batches, then their colour at that depth), so a model drawn mostly see-through no longer paints what lies behind a surface over it in batch order. X-Ray ghosts keep their faint whole shell. Off by default.
