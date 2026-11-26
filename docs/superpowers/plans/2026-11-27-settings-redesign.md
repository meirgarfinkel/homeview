# Settings Redesign and Video Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings gets a desktop sidebar-and-pane layout and a Video quality choice that changes the camera's stream size.

**Architecture:** The server saves `streamResolution` in settings.json, builds the stream path from it unless `KASA_STREAM_RESOLUTION` is set, and reloads after a change (the same `reloadAfterReply` the ONVIF stream choice uses). The web page renders every category as a group; CSS shows one group beside a sidebar on wide screens and all groups stacked on narrow ones.

**Tech Stack:** Fastify, zod, React, Vitest, Testing Library, plain CSS.

**Spec:** `docs/superpowers/specs/2026-11-27-settings-redesign-design.md`

## Global Constraints

- Choices and values: Camera default (`null`), 720p (`720P`), 1080p (`1080P`), 2K (`2560x1440` or `2304x1296`, whichever the camera reports). No 4K.
- 2K is offered only when `CameraInfo.resolution` is `2560x1440` or `2304x1296`, or the saved value already is one of those.
- `KASA_STREAM_RESOLUTION` wins over the saved choice; the page then shows the choice locked with the text "Set in .env".
- Anyone signed in may change video quality (no local-only check).
- Wide layout breakpoint: wider than 900px. Settings block centered, `width: min(960px, 100%)`.
- Back button: icon only, accessible name "Back", left of the "Settings" title.
- Categories and order: Camera, Video, Access, App. A category with nothing to show is not rendered (no sidebar entry either). Camera is selected first; if hidden, the first shown one.
- Copy follows `~/.claude/skills/unslop/SKILL.md`.
- Commits end with the session trailers; work on branch `app-icon-logo`.

## Review Focus

- A settings.json written before this change (no `streamResolution`) loads with the camera default and still saves cleanly.
- Saving the camera login, viewer password or ONVIF profile after choosing a resolution keeps the resolution (every `save` caller spreads `load()`; the store must round-trip the field).
- A bad body (`"4K"`, a number, a missing field) gets 400 and changes nothing.
- The camera info call fails or reports no resolution: the Video group still shows Camera default, 720p and 1080p, and 2K only if it's the saved value.
- Phone width: no sidebar, every group visible with its heading, so nothing is unreachable.

---

### Task 1: Server: save, apply and expose the stream resolution

**Files:**
- Modify: `packages/shared/src/index.ts` (`StreamResolution`, `SettingsResponse`)
- Modify: `apps/server/src/settings/store.ts` (`Settings`, `diskSchema`, `load`, `save`)
- Modify: `apps/server/src/config.ts` (`fromEnv`, `streamPath` argument)
- Modify: `apps/server/src/routes/settings.ts` (GET field, new PUT)
- Test: `apps/server/test/settingsStore.test.ts`, `apps/server/test/configSettings.test.ts`, `apps/server/test/settingsRoutes.test.ts`

**Interfaces:**
- Produces: `export type StreamResolution = '2560x1440' | '2304x1296' | '1080P' | '720P';` in `@kasa/shared`.
- Produces: `SettingsResponse.streamResolution: StreamResolution | null` (the value in effect from env or settings; `null` = camera default) and `'streamResolution'` added to the `managedByEnv` union.
- Produces: `PUT /api/settings/stream-resolution` body `{ resolution: StreamResolution | null }` → 204 then reload; 400 on schema failure; 409 `{ error: 'resolution-from-env', message: 'The video quality comes from KASA_STREAM_RESOLUTION, so change it there.' }` when env sets it.
- Produces: `Settings.streamResolution?: StreamResolution`; `Config.fromEnv.streamResolution: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// settingsStore.test.ts
it('keeps the stream resolution across a save and load', () => {
  store.save({ streamResolution: '1080P' });
  expect(store.load().streamResolution).toBe('1080P');
});
it('loads an older file without a stream resolution', () => {
  writeFileSync(store.file, JSON.stringify({ viewerPasswordHash: 'x' }));
  expect(store.load()).toEqual({ viewerPasswordHash: 'x' });
});

// configSettings.test.ts
it('streams at the saved resolution', () => {
  const c = loadConfig(baseEnv, { ...baseSettings, streamResolution: '1080P' });
  expect(c.camera.streamPath).toContain('resolution=1080P');
  expect(c.fromEnv.streamResolution).toBe(false);
});
it('lets KASA_STREAM_RESOLUTION win over the saved resolution', () => {
  const c = loadConfig({ ...baseEnv, KASA_STREAM_RESOLUTION: '720P' }, { ...baseSettings, streamResolution: '1080P' });
  expect(c.camera.streamPath).toContain('resolution=720P');
  expect(c.fromEnv.streamResolution).toBe(true);
});

// settingsRoutes.test.ts
describe('PUT /api/settings/stream-resolution', () => {
  it('saves the choice, keeps the camera login and reloads', async () => {
    // PUT { resolution: '1080P' } → 204; settings.load().streamResolution === '1080P';
    // settings.load().camera?.username === USER; GET /api/settings → streamResolution '1080P'
  });
  it('goes back to the camera default with null', async () => { /* 204, load().streamResolution undefined, GET → null */ });
  it('refuses 4K and other values', async () => { /* { resolution: '4K' } and {} → 400, nothing saved */ });
  it('refuses when the environment sets it', async () => {
    // env KASA_STREAM_RESOLUTION=720P → 409 error 'resolution-from-env';
    // GET → streamResolution '720P', managedByEnv contains 'streamResolution'
  });
  it('needs a session', async () => { /* no cookie → 401 */ });
});
```

Use the names the existing test files already use for their fixtures (`baseEnv` etc. are placeholders for those).

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/server && mise exec -- pnpm vitest run test/settingsStore.test.ts test/configSettings.test.ts test/settingsRoutes.test.ts`
Expected: the new tests FAIL (unknown field / 404 route); old ones pass.

- [ ] **Step 3: Implement**

- Store: `streamResolution: z.enum(['2560x1440','2304x1296','1080P','720P']).optional()` in `diskSchema`; copy it in `load` and `save` only when defined.
- Config: `streamPath(e.KASA_STREAM_RESOLUTION ?? settings?.streamResolution)`; `fromEnv.streamResolution = e.KASA_STREAM_RESOLUTION !== undefined`. Keep the env enum as is (it also allows `360P`).
- GET: `streamResolution` = the resolution in the stream path in effect (env value or saved value, else `null`). Store the chosen value on `Config.camera.streamResolution?: string` when building config rather than parsing the path. If env is `360P`, return it as is (type the field `StreamResolution | '360P' | null` if needed; the page shows a 360P env value as locked text).
- PUT: schema `{ resolution: { anyOf: [{ type: 'null' }, { enum: [...] }] } }`, required, `additionalProperties: false`. 409 when `config.fromEnv.streamResolution`. Save `{ ...settings.load(), streamResolution }` (omit the key for `null`), then `reloadAfterReply(deps, reply)`, 204.

- [ ] **Step 4: Run the tests and the server suite**

Run: `cd apps/server && mise exec -- pnpm vitest run`
Expected: all pass.

- [ ] **Step 5: Commit** `Server: save a stream resolution in settings and apply it`

### Task 2: Web: the Video quality section

**Files:**
- Create: `apps/web/src/components/settings/VideoQuality.tsx`
- Modify: `apps/web/src/lib/api.ts` (`setStreamResolution`)
- Test: `apps/web/src/components/settings/VideoQuality.test.tsx`
- Modify fixtures that build `SettingsResponse` (e.g. `CameraSection.test.tsx`, `Settings.test.tsx`) to add `streamResolution: null`.

**Interfaces:**
- Consumes: Task 1's `StreamResolution`, `SettingsResponse.streamResolution`, the PUT route.
- Produces: `api.setStreamResolution(resolution: StreamResolution | null): Promise<void>`.
- Produces: `export function VideoQuality({ saved, fromEnv }: { saved: string | null; fromEnv: boolean })` — no outer panel or heading; Task 3 wraps it.

- [ ] **Step 1: Write the failing tests**

```tsx
it('offers 2K when the camera reports 2560x1440', async () => {
  // api.camera resolves { ..., resolution: '2560x1440' }
  render(<VideoQuality saved={null} fromEnv={false} />);
  expect(await screen.findByRole('radio', { name: /2K/ })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Camera default/ })).toBeChecked();
});
it('leaves out 2K for a 1080p camera', async () => {
  // resolution: '1080P' → radios: Camera default, 720p, 1080p only
});
it('still offers the saved 2K when the camera info fails', async () => {
  // api.camera rejects; saved '2304x1296' → 2K radio exists and is checked
});
it('saves a new choice', async () => {
  // click 1080p → api.setStreamResolution called with '1080P'; text "Saved. The picture changes in a few seconds."
});
it('goes back to the old choice when saving fails', async () => {
  // setStreamResolution rejects with message 'nope' → previous radio checked again, error text shown
});
it('is locked when .env sets it', async () => {
  // fromEnv, saved '720P' → every radio disabled, 720p checked, text "Set in .env"
});
```

Mock `api` the way `Settings.test.tsx` does.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/web && mise exec -- pnpm vitest run src/components/settings/VideoQuality.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — a radio group (`<fieldset>`, legend visually hidden "Video quality") with a size hint per option (720p `1280×720`, 1080p `1920×1080`, 2K from the value, e.g. `2560×1440`) and one line under it: "Higher looks sharper and uses more data." Save on change.

- [ ] **Step 4: Run** `cd apps/web && mise exec -- pnpm vitest run` — all pass.

- [ ] **Step 5: Commit** `Settings: choose the video quality`

### Task 3: Web: sidebar-and-pane layout

**Files:**
- Modify: `apps/web/src/components/Settings.tsx` (layout only; the section components stay)
- Modify: `apps/web/src/styles/app.css` (`.settings*` rules)
- Test: `apps/web/src/components/Settings.test.tsx`

**Interfaces:**
- Consumes: Task 2's `VideoQuality`; existing `ArrowIcon` with a left direction (add `left` to `ARROW_ROTATION` if missing).
- Produces: markup `nav.settings-nav` (buttons with `aria-current="page"` on the selected one) and `section.settings-group` per category, with class `is-active` on the selected one and an `h2.settings-group-title`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('puts an icon-only Back button before the title', async () => {
  // button name 'Back' has no text content; it comes before the h1 in document order; click → onClose
});
it('lists Camera, Video, Access and App in the sidebar in the desktop app', async () => {
  // settings local+desktop → nav buttons in that order; Camera has aria-current="page"
});
it('shows the chosen category', async () => {
  // click Video → Video button aria-current="page"; group containing the Video quality fieldset has class is-active; Camera group does not
});
it('leaves out App when not in the desktop app', async () => {
  // desktop false → no App button and no App group
});
it('keeps every group in the page for the phone layout', async () => {
  // all shown groups render their h2 headings and content (CSS decides what a wide screen hides)
});
```

Existing Settings tests must keep passing unchanged except for fixture fields.

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/web && mise exec -- pnpm vitest run src/components/Settings.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement** — build `{ id, label, content }[]` for the four categories from the same conditions used today (Video: Kasa → `VideoQuality`; ONVIF → move `StreamChoice` there, exporting it from `CameraSection.tsx`), drop empty ones, keep `selected` in state. CSS: above 900px, grid `220px 1fr`, nav visible, only `.settings-group.is-active` shown, its h2 shown as the pane title; at 900px or below, nav hidden, all groups shown stacked with headings. Header row: back button then h1.

- [ ] **Step 4: Run** `mise exec -- pnpm check` from the repo root — passes.

- [ ] **Step 5: Look at it.** Run the dev server, view Settings at 1280px and 390px wide, screenshot both, fix anything off.

- [ ] **Step 6: Commit** `Settings: sidebar and pane on a computer, centered, back arrow on the left`

### Task 4: Docs

- [ ] Update the README's Settings description and the `KASA_STREAM_RESOLUTION` row ("overrides the Video quality choice in Settings"). Commit `README: video quality in Settings`.
