# Mobile Live Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Phone-friendly live page, stats moved to Settings, and a "Camera default (720p)" label.

**Spec:** `docs/superpowers/specs/2026-11-27-mobile-live-page-design.md`

## Global Constraints

- Copy: "Camera default (720p)", "Now streaming 1280×720 · 15 fps · 42 kb/s", aria labels "Snapshot", "Pop out", "Fullscreen".
- Phone breakpoint: `max-width: 900px` (existing).
- Touch delay before a PTZ move: 150 ms.

## Review Focus

- A camera that's already streaming at a saved size never overwrites `cameraDefaultSize`.
- Switching cameras drops `cameraDefaultSize`.
- A quick tap on a PTZ arrow (under 150 ms) still pans one step.
- Tapping the video while a control overlay (sound badge) shows still toggles fullscreen.

### Task 1: Server: learn the default size

- `LiveHub` option `onVideoSize?(width: number, height: number): void`, called when the video format is detected.
- `server.ts`: for a Kasa camera with no `streamResolution`, save `cameraDefaultSize` = `${w}x${h}` when it differs.
- Store: `cameraDefaultSize?: string` (zod `/^\d+x\d+$/`), round-trip; `withCamera` keeps it only for the same camera.
- `SettingsResponse.cameraDefaultSize: string | null`.
- Tests: hub calls `onVideoSize`; store round-trip; `withCamera` drops it; GET returns it; a server test that streaming at default saves it and streaming at a saved size doesn't.

### Task 2: Web: label and stats in Video

- `VideoQuality` gets `defaultSize: string | null`; label `Camera default (720p)` via `sizeName("1280x720")` → `720p` (1080 → `1080p`, 1440/1296 → `2K`, 360 → `360p`, else `W×H`).
- "Now streaming …" line from `api.status()` polled every 5 s.
- Tests for both.

### Task 3: Web: live page

- Remove `stage-meta` and the View panel; top bar gets Snapshot and Pop out icon buttons.
- `LiveStage` `onTap` toggles fullscreen (with the iPhone fallback); drop `onDoubleClick`.
- PTZ touch delay; `touch-action: pan-y` on PTZ buttons and range inputs; full-width stage CSS on phones.
- Tests: no stats over the video; no View heading; Snapshot button in the header; tapping the video calls fullscreen; PTZ quick tap pans, touch cancelled within 150 ms doesn't.
- Look at it at 390px and 1280px.

### Task 4: README mentions; commit; review; push; PR; merge.
