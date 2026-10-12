# Plan 20261012-device-os-icons: Devices show their OS mark, so the monitor glyph means only "screen"

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 004c60d0..HEAD -- apps/desktop/src/renderer/components/workbench/sidebar.tsx apps/desktop/src/renderer/components/workbench/command-palette.tsx apps/desktop/src/renderer/components/workbench/command-palette-data.ts apps/desktop/src/renderer/components/workbench/import-project-wizard.tsx apps/desktop/src/renderer/components/settings/settings-page.tsx apps/desktop/src/renderer/components/settings/agent-logos.tsx crates/runtime/src/main.rs`

## Status

- Priority: P3
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (autopilot with plan audit)
- Plan review: audit — departure check
- Workspace: isolated — the session started in the main worktree; this plan lives on `dev/20261012-device-os-icons` in `.claude/worktrees/20261012-device-os-icons`
- Planned at: `004c60d0`, 2026-10-12

## Requirement

In the desktop app a device and a device's remote screen are drawn with the same lucide `Monitor`
glyph. Since the standalone screen view (plan 20261011-standalone-device-screen) the screen row sits
directly under its device row in the sidebar, so two identical icons stack on top of each other and
the user cannot tell "this machine" from "this machine's screen" at a glance.

Once this is done, every surface that shows **one specific device** draws that device's operating
system mark instead of `Monitor`, and `Monitor` is used only for the screen.

Product conclusions (confirmed by the user during exploration):

- **Marks**: macOS → the Apple mark; Linux → the Tux (Linux penguin) mark; any other or empty
  platform → lucide `Server`. The legacy value `darwin` is macOS. Marks are monochrome and paint
  with `currentColor`, so they follow the surrounding text colour and its opacity in both themes,
  exactly like the monochrome agent marks.
- **Granularity**: OS level only. No Linux distribution marks, no form-factor distinction
  (laptop vs server), no colour logos.
- **Interaction**: unchanged. Only icons (and one tooltip label) change. Online/offline styling and
  the route icon (Zap / Radio / Cloud) in front of the device row stay as they are.
- **Surfaces that switch to the device's OS mark**:
  - Sidebar device row (today `Monitor` in `sidebar.tsx:633`).
  - Sidebar device tooltip, the `host / platform` row (`sidebar.tsx:578`): the row's icon becomes
    the OS mark and its text shows a readable OS name instead of the raw platform string, e.g.
    `wsq-mbp · macOS` / `debian · Linux`. Exact separator and layout are the executor's call.
  - Workspace hover card, the device line (`sidebar.tsx:380`).
  - ⌘K command palette device entries: each device entry shows its own OS mark
    (`command-palette.tsx:69` today maps the whole `device` kind to `Monitor`).
  - Import-project wizard device list (`import-project-wizard.tsx:380`).
- **Surfaces that mean "device" in general**:
  - Settings page 「本机」 section (`settings-page.tsx:39`) → the Apple mark: the desktop app runs
    only on macOS, so "this machine" is always a Mac.
  - Sidebar empty state 「添加第一台设备」 (`sidebar.tsx:515`) → lucide `Plus`.
- **Surfaces that keep `Monitor`** (they mean the screen): the screen sub-row under a device
  (`sidebar.tsx:72`), the 「打开屏幕」 button and the top-bar screen toggle
  (`workbench.tsx:1925`, `workbench.tsx:2141`), and the screen view's status bar and empty state
  (`screen-view.tsx:346`, `screen-view.tsx:631`). The status bar at `screen-view.tsx:346` shows the
  device name next to `Monitor`; it is the screen view's own header and stays `Monitor`.
- **What the user observes when done**: in the sidebar, Mac devices show the Apple mark and Linux
  devices show Tux, and the screen row below a device still shows the monitor glyph, so the two are
  distinguishable at a glance. In ⌘K, each device entry carries its own OS mark. No device surface
  in the renderer draws `Monitor` any more.

Non-goals: protocol or runtime changes, distribution detection, iOS app changes, colour marks.

## Decisions & tradeoffs

- **Source of the OS**: the existing `platform` string the daemon already reports, normalised on the
  desktop side. Rejected: adding an OS/distro field to the protocol — the user chose OS-level marks
  only, and a protocol change would need a runtime release before anything shows. Based on:
  `crates/runtime/src/main.rs:703` (`platform: std::env::consts::OS`, i.e. `macos` / `linux`);
  release targets are macOS and Linux only (`.github/workflows/release.yml:133-136`). The server
  stores `platform` only at enrolment and never updates it (`apps/server/src/store.ts:603`, sent from
  the DB row at `apps/server/src/hub.ts:1010`), and the retired TS daemon enrolled with
  `process.platform`, so devices enrolled before the Rust runtime carry `darwin` permanently; any
  trimmed string up to 64 bytes is possible (`hub.ts:134`). `(revised on plan audit)`
- **One device-identity module owns the mapping**: a single renderer module, next to
  `apps/desktop/src/renderer/components/settings/agent-logos.tsx` or wherever the executor finds
  most natural, owns (a) normalising a raw platform string to mac / linux / unknown, (b) the readable
  OS name for each, and (c) the icon component for each. Every specific-device surface listed above
  gets its icon and OS name from this module. Rejected: comparing `daemon.platform` against string
  literals at each call site — five surfaces would each re-decide `darwin` vs `macos` and drift.
  Normalisation must be case-insensitive and treat `darwin` and `macos` as mac, `linux` as linux,
  everything else (including empty) as unknown. The helpers accept `string | undefined`: the
  workspace hover card resolves its daemon with `find` and already handles a missing device record
  (`sidebar.tsx:245`, 「设备记录缺失」).
- **Brand marks are inlined SVG path data from simple-icons, no new dependency**: copy the Apple and
  Linux paths from simple-icons (CC0) into the module, with a comment naming the package and
  version, following the precedent of `agent-logos.tsx` (path data inlined, `currentColor`,
  `aria-hidden`, `shrink-0`, size from the caller's class). Rejected: adding `simple-icons` or an
  icon-pack package — two paths do not justify a dependency; rejected: lucide's `Apple` (it is the
  fruit, not the brand mark). Based on: `agent-logos.tsx:6-12`.
- **Unknown platform uses lucide `Server`, never `Monitor`**: `Monitor` is reserved for the screen
  after this change. Based on the user's confirmation.
- **⌘K device entries carry their own icon; other kinds keep the per-kind default**: `KIND_ICON`
  stays the icon source for workspace / project / terminal / action entries. How a device entry
  carries its platform or icon (a field on `PaletteEntry`, or resolving from the target's daemon)
  is the executor's call. Based on: `command-palette.tsx:65-71`, `command-palette.tsx:177`,
  `command-palette-data.ts:227-238`.
- **Settings 「本机」 uses the Apple mark unconditionally** rather than resolving the local daemon's
  platform: the desktop app ships only for macOS. `(decided while planning)` — the settings nav icon
  is static per section (`settings-page.tsx:36-41`), and resolving it dynamically would add state
  for a value that cannot differ.
- **The import wizard's 「没有在线设备」 empty state keeps lucide `MonitorUp`**
  (`import-project-wizard.tsx:397`): it is a different glyph from `Monitor`, sits nowhere near a
  screen surface, and was not among the surfaces confirmed with the user. `(revised on plan audit)`
- **Left to the executor**: file and export names, size classes (match the `Monitor` sizes they
  replace), the tooltip row's exact copy and separator, and the palette entry shape.

## Direction

A renderer-only change in `apps/desktop`. One milestone: the module exists and every listed surface
uses it.

### Milestone 1: Device surfaces draw OS marks; `Monitor` is screen-only

The device-identity module exists and every surface in the Requirement's lists draws the specified
icon; the tooltip row shows the readable OS name. After this, the only remaining `Monitor` uses in
`apps/desktop/src/renderer` are the screen surfaces listed under "keep `Monitor`".

Validation:
- `pnpm -C apps/desktop typecheck` -> exit 0
- `pnpm -C apps/desktop build` -> exit 0
- `grep -rnw Monitor apps/desktop/src/renderer --include='*.tsx' --include='*.ts'` (word match, so
  `MonitorUp` is excluded) -> only imports and uses in `sidebar.tsx` (screen sub-row only),
  `workbench.tsx` (open-screen button and top-bar toggle), and `screen-view.tsx`
- `grep -rnw Server apps/desktop/src/renderer --include='*.tsx' --include='*.ts'` -> only inside the
  new device-identity module (it is unused in the renderer today), so no surface hard-codes the
  fallback
- `sidebar.tsx`, `command-palette.tsx`, `import-project-wizard.tsx` and `settings-page.tsx` each
  import from the new module

## Landmines

- `sidebar.tsx` imports `Monitor` for both device and screen uses in the same file
  (`sidebar.tsx:72` is the screen sub-row and must stay; `:380`, `:515`, `:578`, `:633` change). A
  blanket replace in that file breaks the screen row.
- Three icon slots are typed `LucideIcon`: the device tooltip rows
  (`{ icon: LucideIcon; text: string }[]`, `sidebar.tsx:577`), `KIND_ICON`
  (`Record<PaletteEntryKind, LucideIcon>`, `command-palette.tsx:65`) and `SECTION_ICONS`
  (`Record<SettingsSectionId, LucideIcon>`, `settings-page.tsx:36`, rendered at `:131`). The inline
  brand marks are plain components taking `className`, not `LucideIcon`; widen the types rather than
  casting. `(settings site added on plan audit)`
- `command-palette-data.ts:234` already uses `daemon.platform` as hidden search keywords. Keep the
  raw value searchable (users may type `linux` or `macos`); adding the readable name is fine.
- `command-palette-data.ts` builds plain data and is covered by `command-palette-data.test.ts`
  (run via `node --import tsx --test`, `apps/desktop/package.json:13`; it resolves `@/` and `.tsx`
  fine, so importing JSX there would not break the loader). Preferred shape: carry a plain value
  (the platform string or the normalised OS kind) on the entry and resolve the icon in
  `command-palette.tsx`, which also has `state.daemons` (`command-palette.tsx:231`). The tests compare
  keys/ids/targets, not whole entries, so adding a field is safe. Existing tests must still pass; do
  not add new tests for this change. `(revised on plan audit)`

## Merge and deploy

Pure desktop renderer change. No server deploy, no runtime release ordering, no migrations, no
environment variables. Ships with the next desktop release. UI walkthrough is done by the user.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx`
- `apps/desktop/src/renderer/components/workbench/command-palette.tsx`
- `apps/desktop/src/renderer/components/workbench/command-palette-data.ts`
- `apps/desktop/src/renderer/components/workbench/import-project-wizard.tsx`
- `apps/desktop/src/renderer/components/settings/settings-page.tsx`
- one new renderer module for the device marks (location is the executor's call, under
  `apps/desktop/src/renderer/`)
- `wiki/plans/README.md`, this plan

Out of scope:
- `apps/desktop/src/renderer/components/workbench/screen-view.tsx`,
  `apps/desktop/src/renderer/components/workbench/workbench.tsx` — screen surfaces keep `Monitor`
- `crates/`, `packages/`, `apps/server`, `apps/ios` — no protocol, runtime, or iOS change
- `apps/desktop/package.json` — no new dependency

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Monitor audit | `grep -rnw Monitor apps/desktop/src/renderer --include='*.tsx' --include='*.ts'` | only screen surfaces |
| Server audit | `grep -rnw Server apps/desktop/src/renderer --include='*.tsx' --include='*.ts'` | only the device-identity module |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod`, by the user | Mac devices show Apple, Linux devices Tux, screen row keeps the monitor glyph |

## Done criteria

- [ ] All listed commands pass (walkthrough left to the user).
- [ ] Sidebar device rows, the device tooltip host row, the workspace hover card device line, ⌘K
      device entries and the import wizard device list draw the device's OS mark from the single
      device-identity module.
- [ ] `darwin` and `macos` both render the Apple mark; `linux` renders Tux; anything else renders
      lucide `Server`.
- [ ] The tooltip host row shows a readable OS name (`macOS` / `Linux`), not the raw platform string.
- [ ] Settings 「本机」 shows the Apple mark; the empty state 「添加第一台设备」 shows `Plus`.
- [ ] `Monitor` (word match) remains only on screen surfaces; `Server` appears only in the
      device-identity module; the four surface files import from that module.
- [ ] Brand path data is inlined with a simple-icons version and licence comment; no new dependency.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. the runtime reports platform
  differently, or a Windows target appears in the release matrix).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- `docs/design-guidelines.md:54-56` asks for the same icon semantics on desktop and iOS; iOS uses
  `laptopcomputer` / `desktopcomputer` for devices (`apps/ios/Coflux/Views/DevicesView.swift`).
  Out of scope here; the divergence is accepted until iOS gets the same treatment.

- If a Windows or other daemon target is ever added, extend the device-identity module; every
  device surface picks it up from there.
- Distribution-level marks would need the runtime to report a distribution (protocol change in both
  `crates/protocol` and `packages/protocol`); the module is the place the extra mark would land.
