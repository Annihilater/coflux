# Plan 20260918-inline-maple-mono-cn: Desktop ships its own font instead of guessing at the system's

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 8b656e2e..HEAD -- apps/desktop/src/renderer/index.css apps/desktop/src/renderer/main.tsx apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/package.json apps/desktop/src/main/app-protocol-pure.ts apps/desktop/electron.vite.config.ts apps/desktop/electron-builder.yml`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: dx
- Execution: subagent(opus) — departure check, 2026-09-18
- Stop after: implementation — departure check autopilot item (advisor review, then execute)
- Plan review: advisor — departure check autopilot item; the review ran at
  `8b656e2e` and its findings are folded in, marked `(revised on advisor review)`
- Workspace: isolated — cut from the main worktree at plan time (`pending: 0`)
- Planned at: `8b656e2e`, 2026-09-18

## Requirement

Every font declaration in the desktop renderer is a ghost declaration: it names
fonts that are not installed and silently renders something else. Measured on
this machine with CoreText (`CTFontCreateWithName` + `CTFontCopyFamilyName`),
**not one third-party font is installed** — `Inter`, `JetBrains Mono`,
`Fira Code`, `SF Mono`, `SFMono-Regular`, `Consolas`, `Liberation Mono`, `Hack`,
`Source Code Pro`, `IBM Plex Mono`, `Cascadia Code`, `Iosevka`, `Geist Mono`,
`Commit Mono`, `Berkeley Mono`, `MonoLisa` all resolve to Helvetica. Only
`Menlo`, `Monaco`, `Andale Mono` and `PT Mono` exist.

So today:

| Declared | Actually rendered |
| --- | --- |
| `--coflux-font-sans: Inter, ui-sans-serif, …` (`index.css:19`) | SF Pro — `Inter` was never installed and there is no `@font-face` anywhere in the repo |
| `--coflux-font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace` (`index.css:20`) | Menlo |
| terminal `fontFamily` (`terminal-pane.tsx:220`, same string) | Menlo |
| any CJK text | PingFang SC fallback |

The visible defect this fixes is **CJK misalignment in the terminal**. Menlo's
latin advance is 0.602em; xterm allocates two cells for a CJK codepoint, i.e.
1.204em; PingFang SC's CJK advance is 1.0em. Chinese characters therefore sit in
a cell wider than the glyph, leaving uneven gaps and breaking column alignment
against latin text around them. Agents in this product output Chinese
continuously, so this is on screen constantly.

Maple Mono CN is drawn for exactly this: latin 0.600em, CJK 1.200em — an exact
2:1 ratio that fills the two-cell allocation precisely.

**What is true when this is done**: the desktop app carries its own font and
renders identically on any machine regardless of what is installed. The terminal
renders Maple Mono CN at 12px with line height 1.25; Chinese and latin line up on
the same grid; TUI box-drawing borders stay continuous; UI code spans use the
same font as the terminal; UI body text uses the platform's own system font
(SF Pro for latin, PingFang SC for Chinese on macOS) and no longer claims to be
a font that is not there.

This is a perceptible change whose acceptance is a real-machine walkthrough by
the user. Per `no-frontend-verification`, agents do not perform UI walkthroughs
or drive Playwright for it; the automated gates below still run.

## Decisions & tradeoffs

- **Inline Maple Mono CN v7.9, all four faces** (Regular, Bold, Italic,
  BoldItalic), converted to woff2, ≈21MB total. Rejected: shipping only
  Regular+Bold (≈10.4MB) and letting the browser synthesise oblique and faux
  bold — the user chose full coverage at the departure check. Rejected: the
  Nerd Font variant (+20MB) — this machine's zsh is bare (no `starship`,
  `powerlevel10k` or `oh-my-posh` in `~/.zshrc`), so no prompt needs private-use
  icons. Based on: measured with fontTools against the real
  `MapleMono-CN-Regular.ttf` — `unitsPerEm=1000`, `M`/`i`/`W`/`0` = 600,
  `中`/`文`/`测` = 1200, `█`/`│`/`─`/`●` = 600, 23,275 glyphs; 17.7MB ttf
  compresses to 5.2MB woff2 via `fonttools ttLib.woff2 compress`.

- **Version v7.9, not the V8 line**: the upstream `variable` branch README states
  V8 "is still under development and has not been officially released" and points
  at the stable line. Release v7.9 is itself built from that branch, so v7.9 is
  both current and stable. Rejected: tracking `variable`/V8 — unreleased.

- **The four woff2 files are committed to the repository**, under the renderer's
  `public/` directory, alongside the upstream `OFL.txt`. Rejected: fetching and
  converting at build time — it would put a 140MB download plus a Python
  (`fonttools` + `brotli`) toolchain on the critical path of every CI build and
  of `.github/workflows/desktop-release.yml`, trading a one-time 21MB repository
  cost for a permanently more fragile, network-dependent release. Rejected: Git
  LFS — the repository has no LFS today (`.gitattributes` exists with zero `lfs`
  entries) and adopting it would impose LFS setup on every clone and CI job for
  one directory of static, never-changing binaries. Based on: `.git` is currently
  99MB; `electron-builder.yml:13-16` packages `out/**/*` with `asar: true` and
  `enableEmbeddedAsarIntegrityValidation: true`, so the font must be present at
  build time and cannot be injected into the asar afterwards. This decision is
  consistent with the product's existing bias toward self-contained shipping (the
  daemon is already bundled into the app).

- **The font is licensed OFL-1.1, which permits redistribution inside the app**,
  provided the licence travels with it. The `OFL.txt` from the upstream release
  archive must be committed next to the font files. This is a redistribution
  obligation, not a nicety.

- **The font wait happens exactly once, in `main.tsx`'s `boot()`, before
  `createRoot().render()` — never inside `TerminalPane`** *(revised on advisor
  review)*. `await loadFonts(["<family>"])` (from `@xterm/addon-web-fonts`) goes
  into the existing async `boot()` at `main.tsx:75-89`, which already awaits the
  session token, is already covered by the cold-start overlay, and runs after
  `main.tsx:9`'s `import "./index.css"` has registered the faces. By the time any
  `TerminalPane` mounts, the font has settled. Rejected — and this is the trap,
  not a stylistic preference: making `TerminalPane`'s mount effect async so it can
  await the font itself. That effect (`terminal-pane.tsx:197`) constructs the
  terminal and calls `props.onReady` (`:520`) **synchronously**, and the
  `[props.sessionId]` effect (`:693-711`) that follows it in the same commit bails
  out on `if (!sessionId || !terminal || !controller) return;` and never re-runs,
  because its dependency array holds only `props.sessionId`. Since
  `terminal-panes.tsx:34` passes `sessionId={task.sessionId ?? null}` on the very
  first mount, every already-RUNNING task — cold start, ⌘R, workspace switch —
  would get a permanently blank terminal, with no error and every gate green.
  Rejected: `await document.fonts.ready` alone; rejected: constructing the
  terminal first and repairing with `refresh()` or `clearTextureAtlas()`; both are
  called out as insufficient by the addon's own README. Pin
  `@xterm/addon-web-fonts@0.2.0-beta.215` to stay on the same beta line as the
  addons already in `apps/desktop/package.json:40-45` (xterm `6.1.0-beta.304`,
  addon-fit `0.12.0-beta.301`, addon-webgl `0.20.0-beta.300`); its peer range
  `^6.1.0-beta.304` matches the pinned xterm exactly.

- **A failed font load must not stop the app from booting** *(revised on advisor
  review)*. `loadFonts()` rejects when the family is not registered in
  `document.fonts`, and it rejects with a **plain string, not an `Error`** — a
  handler that reads `.message` off it gets `undefined`. Because the wait lives in
  `boot()`, the only correct handling is to swallow the rejection and render
  anyway: the CSS stack's own fallback then does its job. Rendering in the wrong
  font is a cosmetic regression; an app that does not boot is an outage.

- **Terminal typography: `fontSize: 12`, `lineHeight: 1.25`** *(revised 2026-09-18:
  the owner set these after reading 2.1.0 on a real machine)*. This is what the
  terminal used up to 2.0.2; 2.1.0 followed Cursor down to `lineHeight: 1.0` and
  reads cramped. The plan had proposed 13 / 1.2 — it renders a hair looser still,
  but the number that matters is the one the owner reads all day, so 12 / 1.25 wins
  over both the earlier proposal and any editor's default. **`customGlyphs` is not an
  `ITerminalOptions` member on the pinned xterm** *(revised on advisor review)* —
  it has zero hits in `@xterm/xterm@6.1.0-beta.304`'s typings and now lives as a
  `WebglAddon` constructor option, defaulting to `true`. Leave that default alone:
  it is what keeps box-drawing runs continuous above line height 1.0, and it
  applies only while the WebGL renderer is live. After an `onContextLoss` fallback
  to the DOM renderer (`terminal-pane.tsx:444`) box-drawing verticals will show
  seams at 1.2 — accepted, not a defect to chase.

- **No ligature support is added.** Maple Mono ships ligatures, but they cannot
  render in the terminal at all: the WebGL renderer rasterises per glyph and the
  DOM renderer emits one span per cell, so no cross-character ligature can form,
  and `xtermjs/xterm.js#3303` (WebGL + ligatures misrendering) is still open. Do
  **not** add `@xterm/addon-ligatures`. Ligatures will render in UI code spans,
  which are ordinary DOM text — that asymmetry is accepted, not a bug to chase.

- **`--coflux-font-sans` drops the ghost `Inter` and resolves to the platform
  system font** (`ui-sans-serif, system-ui, -apple-system, …`), which on macOS
  gives SF Pro for latin and PingFang SC for CJK automatically. Rejected:
  inlining Inter (~100KB) — the user reversed this at the departure check.
  Rejected: naming `"PingFang SC"` explicitly in the stack — placed before the
  system font it would hand latin rendering to PingFang's inferior western
  glyphs, and placed after it, it is redundant because `system-ui` already
  resolves CJK to PingFang SC. The rendered result is unchanged from today; what
  changes is that the declaration stops lying.

- **`--coflux-font-mono` becomes Maple Mono CN**, reusing the already-loaded
  font at zero additional cost, so terminal and UI code spans match. Based on:
  `index.css:20` is the single source of truth, consumed at `index.css:85`
  (`--font-mono`) and `main.tsx:28` (`--font-family-code`).

- **Fonts live in `apps/desktop/src/renderer/public/fonts/` and are referenced by
  root-absolute URL** (`url(/fonts/…)`), matching the existing `public/favicon.svg`
  precedent (`index.html:9`). Rejected: `src/renderer/assets/` with a bundler
  import — hashing and inlining buy nothing for a local app, and the `?raw`
  import convention there (`clawd-glyph.tsx:3-5`) is for inlined SVG. Based on:
  `electron.vite.config.ts` sets `RENDERER_ROOT = src/renderer` and forces
  `base: "/"` via the `absoluteBase()` post-hook precisely so root-absolute
  public asset paths resolve under `coflux-app://app/`.

- **No CSP or MIME change is needed or permitted.** `app-protocol-pure.ts:26`
  already allows `font-src 'self' data:` and `:51` already maps
  `.woff2 → font/woff2`. Any diff to the CSP is out of scope.

## Direction

Three milestones, **strictly serial — one work package, do not fan out**
*(revised on advisor review)*. M1 registers the faces that M2's `loadFonts()`
call needs, and M2 and M3 both edit `apps/desktop/src/renderer/main.tsx` — M2 adds
the await in `boot()`, M3 corrects the stale `Inter` comment — so they are not
scope-disjoint and must not run as concurrent work packages.

### Milestone 1: The font ships with the app

The four Maple Mono CN v7.9 woff2 files and the upstream `OFL.txt` are committed
under the renderer's public directory, and `@font-face` rules register them as a
single family — one family name, four faces distinguished by `font-weight`
(400/700) and `font-style` (normal/italic). After a renderer build, the files are
present in the build output.

Two placement constraints *(revised on advisor review)*: the `@font-face` block
must sit **after** `index.css`'s `@import` run (`index.css:5-11`) — CSS requires
`@import` to precede other rules, and putting the faces first makes postcss-import
skip the imports that follow. And the family string in the `@font-face` rules must
be character-identical to the one passed to `loadFonts()`, which matches on the
unquoted family name and rejects on no match. Registration itself needs no
`font-display` trick: applying the stylesheet is what puts the faces into
`document.fonts`.

Obtaining the files (upstream publishes **no** woff2 and **no** variable build
for the CN family — only 16 static ttf files inside a 140.8MB archive; the
`@fontsource/maple-mono` npm package and ZeoSeven item 443 are **latin-only** and
cannot be used):

1. Download `MapleMono-CN.zip` from the v7.9 release
   (`https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMono-CN.zip`)
   and extract `MapleMono-CN-Regular.ttf`, `-Bold.ttf`, `-Italic.ttf`,
   `-BoldItalic.ttf` plus the licence.
2. Convert each with `fonttools ttLib.woff2 compress` (needs `fonttools` and
   `brotli`; a throwaway venv is sufficient and must not be committed).

Both steps are one-off authoring work, not part of the build.

Validation: `pnpm -C apps/desktop build` -> exit 0, and the four woff2 files are
present under the renderer output directory.

### Milestone 2: The terminal renders Maple Mono CN

The font load is awaited in `main.tsx`'s `boot()` before React mounts, so that it
has settled — resolved *or* rejected — before any terminal is constructed. The
terminal then renders at `fontSize: 12` / `lineHeight: 1.25` with Maple Mono CN
leading its family stack (keep a system monospace fallback behind it).

**`TerminalPane`'s mount effect stays synchronous.** Do not make it async, do not
await anything inside it, do not defer `new Terminal()` or `props.onReady` past
the synchronous run of that effect — see Decisions and Landmines for the blank
terminal that produces. The existing ordering is otherwise untouched:
`new Terminal()` (`:201`) -> `term.open()` -> dynamic WebGL addon import
(`:439-451`) -> `fitAddon.fit()` (`:468-491`).

Everything else about the terminal — `allowProposedApi`,
`macOptionClickForcesSelection`, `altClickMovesCursor`, `cursorBlink`,
`cursorStyle`, `minimumContrastRatio`, `rescaleOverlappingGlyphs`, `scrollback`,
`vtExtensions`, the theme, the addons, the WebGL context-loss handling — is
unchanged, and `WebglAddon` keeps being constructed with no options.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0;
`pnpm -C apps/desktop test` -> exit 0.

### Milestone 3: UI font declarations stop lying

`--coflux-font-sans` drops `Inter` and leads with the platform system stack;
`--coflux-font-mono` leads with Maple Mono CN. Both remain single sources of
truth for their consumers (`--font-mono` at `index.css:85`, `--font-family-code`
at `main.tsx:28`, `body` at `index.css:195-205`) — consumers keep reading the
custom properties rather than naming a family themselves.

Comments count *(revised on advisor review)*: `main.tsx:17` ("13px + Inter") and
`terminal-pane.tsx:216-217` (which explains the old Menlo resolution) describe the
arrangement this plan replaces, and must be brought in line rather than left to
contradict the code.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0;
`pnpm -C apps/desktop test` -> exit 0.

## Landmines

- **xterm.js caches glyph metrics synchronously at first use, permanently.**
  The DOM renderer measures character width and the WebGL renderer builds a
  glyph texture, both in synchronous code, both cached. If the web font has not
  finished loading when `new Terminal()` runs, xterm measures a *fallback* font
  and keeps those wrong metrics for the terminal's whole life — a later
  `refresh()` does not repair it. This is the single most likely way to
  implement this plan and end up with a terminal that looks subtly wrong
  (misaligned columns, clipped glyphs) with no error anywhere. The addon's own
  README explicitly warns against after-the-fact refresh hacks. The fix is
  ordering, not repair: the font must have settled **before** the first
  `new Terminal()` (`terminal-pane.tsx:201`). The only safe place to wait is
  `main.tsx`'s `boot()`, for the reason in the next landmine.

- **Awaiting the font inside `TerminalPane` silently blanks every running
  terminal** *(found on advisor review)*. This is the trap that looks like the
  obvious implementation. The mount effect at `terminal-pane.tsx:197` is
  synchronous today and the code after it depends on that: it assigns
  `terminalRef`/`controllerRef` and calls `props.onReady` (`:520`) synchronously,
  and the `[props.sessionId]` effect at `:693-711` — which runs in the same commit
  — starts with `if (!sessionId || !terminal || !controller) return;` and has only
  `props.sessionId` in its dependency array, so it never runs again. Make the
  mount effect async and those refs are still null when the second effect checks
  them: the ptyOutput consumer is never registered, `props.onSessionReady` never
  fires, and `terminal-attach.ts:117`'s `beginAttach` returns early. Every task
  that mounts with a session already attached — which is all of them on cold
  start, ⌘R, or a workspace switch, because `terminal-panes.tsx:34` passes
  `sessionId` on first mount — shows an empty terminal, with no error, while
  typecheck and `pnpm test` both stay green (no test imports `terminal-pane.tsx`).

- **`await document.fonts.ready` is not sufficient on its own.** It settles the
  *currently pending* font loads, and an `@font-face` rule that no element has
  used yet may not have started loading at all — so it can resolve while the
  font is still unloaded. `loadFonts()` wraps `document.fonts.load()` per face,
  which is the reliable primitive.

- **`loadFonts(['Family'])` rejects when the family is not registered in
  `document.fonts`.** It snapshots `Array.from(document.fonts)` and filters by
  exact unquoted family name, so a typo in the family name, or a stylesheet that
  has not been applied yet, produces a rejected promise rather than a silent
  no-op — **and it rejects with a plain string, not an `Error`**, so a handler
  that reads `.message` off it gets `undefined`. The family string in the
  `@font-face` rules and the one passed to `loadFonts()` must match exactly. It
  does match *all* faces of the family (bold and italic included), so one family
  name covers all four files.

- **The WebGL addon is loaded dynamically and must stay that way.**
  `terminal-pane.tsx:439-451` imports `@xterm/addon-webgl` lazily and disposes it
  on context loss (`:444`) so xterm falls back to the DOM renderer. Font work must
  not make that import eager or reorder it ahead of `term.open()`.

- **`asar: true` with `enableEmbeddedAsarIntegrityValidation: true`**
  (`electron-builder.yml:16` and `:26`) means nothing may modify the asar after it
  is built — any "copy the font in afterwards" packaging step produces an app that
  crashes on launch. The font must be in the renderer output before packaging.

- **`base` is deliberately `"/"`, not `"./"`.** `electron.vite.config.ts`'s
  `absoluteBase()` post-hook overrides electron-vite's renderer preset
  specifically so root-absolute asset paths work under the `coflux-app://app/`
  standard scheme. Font URLs follow that convention; do not "fix" them to
  relative paths.

- **`fitAddon.fit()` must still run after the font is in place.** Changing
  `fontSize`/`lineHeight` changes cell geometry and therefore the PTY's row and
  column count; the existing fit/resize path (`terminal-pane.tsx:468-491`) must
  keep working. Note what the zero-size guard there actually does: it **prevents**
  FitAddon from clamping a `display:none` pane to 2×1 and pushing that size to the
  remote PTY — it does not clamp. Do not "simplify" it away.

## Scope

In scope:
- `apps/desktop/src/renderer/public/fonts/` (new: four woff2 files + `OFL.txt`)
- `apps/desktop/src/renderer/index.css`
- `apps/desktop/src/renderer/main.tsx` — the single `loadFonts()` await in
  `boot()`, plus the stale `Inter` comment
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`
- `apps/desktop/package.json` (one dependency: `@xterm/addon-web-fonts`)

Out of scope:
- `apps/desktop/src/main/app-protocol-pure.ts` — CSP and the woff2 MIME entry
  already support this; changing them is a security-surface change with no need.
- `apps/desktop/electron.vite.config.ts`, `apps/desktop/electron-builder.yml` —
  `public/` assets and `out/**/*` packaging already carry the files.
- `apps/ios`, `apps/server`, `crates/**` — no font surface.
- Nerd Font icon coverage, ligature rendering in the terminal, and font
  configurability (a settings UI for choosing a font) — each is its own
  requirement.
- Releasing. This plan lands on its branch; version bumps, tagging and
  publishing are the user's call.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Renderer build | `pnpm -C apps/desktop build` | exit 0, fonts present in output |
| Desktop dev preview (acceptance) | `pnpm dev:desktop` | see the walkthrough below |

The repository has no lint tool configured — no eslint/oxlint/biome/prettier
config and no lint script at any level, so do not invent a lint step. (The
`eslint-disable-next-line` at `terminal-pane.tsx:710` is a leftover, not evidence
of a linter.) CI runs exactly typecheck + test + build for this package.

**No automated gate touches the terminal rendering path at all** — no test
imports `terminal-pane.tsx` — so acceptance rests entirely on the user's
walkthrough *(added on advisor review)*. The walkthrough that matters: cold-start
(or ⌘R) the dev preview with at least one **RUNNING** task, and confirm that task's
terminal attaches and prints output. That is precisely the failure mode an
in-pane font await would introduce, and nothing else would catch it. Per
`no-frontend-verification` the executor does not run UI walkthroughs or
Playwright for this change.

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] Four Maple Mono CN v7.9 woff2 faces plus `OFL.txt` are committed under the
      renderer's `public/fonts/`, and appear in the renderer build output.
- [ ] The font load is awaited in `boot()` and has settled — resolved or
      rejected — before React mounts; a rejection still boots the app.
- [ ] `TerminalPane`'s mount effect is still synchronous: it constructs the
      terminal and calls `props.onReady` in the same synchronous run as before.
- [ ] Terminal renders at `fontSize: 12`, `lineHeight: 1.25`; no other terminal
      option is changed and `WebglAddon` is still constructed with no options.
- [ ] `Inter` appears nowhere in the code or its comments; the Maple Mono CN
      family string appears only in `index.css` (the `@font-face` rules and
      `--coflux-font-mono`), in `terminal-pane.tsx`'s `fontFamily`, and at the one
      `loadFonts()` call site.
- [ ] No CSP, MIME, electron-vite or electron-builder file is modified.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The v7.9 release archive or its expected member files are unavailable, or a
  converted woff2 lands far from the measured 5.2MB — the source may have
  changed; report rather than substituting a different font or version.
- `@xterm/addon-web-fonts@0.2.0-beta.215` is incompatible with the pinned xterm
  `6.1.0-beta.304` — report rather than upgrading the whole xterm line, which
  would be a much larger change than this plan authorises.
- The outcome appears to require touching the CSP, the app protocol, or the
  build configuration.
- Awaiting the font in `boot()` turns out not to work. Report it — do **not**
  fall back to awaiting inside `TerminalPane`, and do not make its mount effect
  async to work around the problem. That path fails silently and passes every
  gate; a stop here is much cheaper than shipping it.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- The font files are static and versioned by their upstream release. Bumping
  Maple Mono means repeating M1's two authoring steps (download the CN archive,
  convert to woff2) and re-measuring — the CN family has no woff2 or variable
  build upstream, so there is no dependency to bump and no automation to rely on.
- Because CN has no variable build, each additional weight or style is another
  ~5MB file. Resist adding faces without a concrete need.
- The 2:1 latin-to-CJK advance ratio is the property that makes this font worth
  21MB. Any future font swap that does not preserve it reintroduces the
  misalignment this plan fixed.
- If a font-selection setting is ever added, a family name is bound in four
  places — `index.css`'s `@font-face` rules and its two custom properties, the
  terminal's `fontFamily`, and the `loadFonts()` call in `boot()` — and the
  font-settled-before-construction constraint applies to any runtime font change
  as well: changing `fontFamily` on a live terminal under WebGL has its own known
  repaint bug, and the await still cannot move into `TerminalPane` without
  breaking the synchronous mount contract described in Landmines.
