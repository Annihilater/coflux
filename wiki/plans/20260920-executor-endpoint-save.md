# Plan 20260920-executor-endpoint-save: A custom endpoint survives being added

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat f037003d..HEAD -- apps/desktop/src/main/executor-catalog.ts apps/desktop/src/main/executor-host.ts apps/desktop/src/main/executor-config.ts apps/desktop/src/main/executor-runtime.ts apps/desktop/src/renderer/components/settings apps/desktop/src/shared/desktop-bridge.ts`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check, 2026-09-20
- Stop after: implementation — departure check (autopilot item chose the advisor review)
- Plan review: advisor
- Workspace: isolated — cut `dev/20260920-executor-endpoint-save` from the main worktree at `f037003d`
- Planned at: `f037003d`, 2026-09-20

## Requirement

### The problem

Adding a custom endpoint in the desktop settings page (Executor → "+ 添加" →
fill the dialog → "保存端点") appears to work — the endpoint shows up in the
list — but it never reaches the centre. Close the settings page and reopen it
and the endpoint is gone. Measured on the reporting user's machine: the daemon
cache `~/.coflux/executor-settings.json` holds `provider: ""`, `modelId: ""`,
`customProviders: []`, `revision: 0`. Not one save has ever landed.

The chain:

1. The dialog's save calls `upsertEndpoint`, which immediately submits the
   **whole** configuration — including the form's empty `provider` and
   `modelId` (`executor-section.tsx:187`).
2. Before writing anything, the main process runs `validateExecutorSelection`
   (`executor-host.ts:215`), whose first line refuses an empty provider
   (`executor-catalog.ts:122`). The save is rejected outright
   (`executor-host.ts:221`) and the endpoint never reaches the centre.
3. The renderer sets local state before the save and never rolls it back on
   failure (`executor-section.tsx:184`), so the list keeps a ghost row that
   exists nowhere else.
4. The only feedback — "先选一个 provider" — renders at the bottom of the
   *model* card, half a screen above the endpoint list, phrased as though the
   model card were the thing at fault.

A second, independent break: the catalogue is fetched once on mount
(`executor-section.tsx:84`, the only call site of `getExecutorCatalog` in the
repository) and never re-fetched. So even a successfully saved endpoint does
not appear in the Provider dropdown until the settings page is closed and
reopened. That contradicts
`wiki/plans/20260918-executor-settings-central.md:65` ("自定义端点添加后直接
进 provider 下拉") and its acceptance item at line 213, which was evidently
never walked end to end.

### Product conclusions (settled with the user; do not reopen)

The flow, once fixed: settings → Executor → "+ 添加", fill the endpoint →
"保存端点" → the endpoint is stored on the account there and then → it appears
in the Provider dropdown above **immediately** → select it → search its model →
paste the key → "保存" → "测试连接" → `coflux executor run` in a terminal. The
settings page is never closed during any of this.

Specific behaviours:

- **"An endpoint is configured, no model chosen yet" is a legal state.** The
  status section keeps reporting not-ready with the sentence it already has
  (`executor-config.ts:107`). A provider that is *set* but absent from the
  catalogue is still refused.
- **An endpoint edit only edits the endpoint.** It does not carry the
  provider/model/key sitting unsaved in the model card. The model card's
  "保存" button is the only way provider and model reach the account.
- **A failed endpoint save reports in the endpoint area and rolls the list
  back** — no ghost row. Its success reports there too, no longer mixed into
  the model card's feedback line. Deleting an endpoint behaves the same way.
- **Adding a new endpoint while no provider is chosen pre-selects it** in the
  dropdown — a UI selection only, nothing is written to the account; the user
  still picks a model and presses "保存". Editing an existing endpoint never
  moves the current selection.
- Non-goals: no device-level override, no change to the model card's own save
  semantics, and not one line of the write-only credential rules (never echoed,
  blank means unchanged, clearing is its own button).

### True when done

A user whose account has never been configured can add a custom endpoint,
watch it appear in the Provider dropdown without closing the page, finish the
configuration, and run a task through it.

## Decisions & tradeoffs

- **An unset selection is a valid configuration, not a refusal**:
  `validateExecutorSelection` treats provider and modelId **both empty** as
  `ok` with a warning. One empty and the other set stays refused, and a
  provider or model that is set but missing from the catalogue stays refused.
  Rejected: giving the save input an "intent" flag so endpoint saves skip the
  selection check — the state "endpoint configured, model not chosen yet" is
  one the data model already expresses (`executor-config.ts:106-107` names it
  in `deriveReadiness`), and refusing to persist it *was* the bug; a flag would
  make the same stored state legal or illegal depending on which button was
  pressed, and would leave the real hole open for any future caller.
  Based on: `apps/desktop/src/main/executor-catalog.ts:122-123`,
  `apps/desktop/src/main/executor-config.ts:96-107`.

- **The endpoint paths submit the *saved* selection, never the form's**
  *(revised on advisor review)*: endpoint add, edit and delete send the
  account's current `provider` / `modelId` (from the settings snapshot) and do
  **not** send the model card's unsaved `apiKey`. Rejected: keeping the current
  behaviour of submitting the form state — with the selection check relaxed it
  becomes a data-loss path: configured anthropic + sonnet, switch the Provider
  dropdown to openai (which clears the model box via `setModel(null)`), add an
  endpoint without picking a model, and the account's model choice is
  overwritten with empty. **The "清除 key" button stays on the form's
  selection** and is explicitly *not* moved by this decision: the credential it
  clears is keyed off `input.provider` (`executor-host.ts:327`) while the
  button's own visibility is keyed off the *form's* provider
  (`executor-section.tsx:123,281`), so submitting the saved provider instead
  would clear a different provider's key than the one on screen. Its own
  pre-existing limitation is recorded under Maintenance notes rather than
  fixed here.
  Based on: `apps/desktop/src/renderer/components/settings/executor-section.tsx:134-160`
  (the shared `save` reads form state), `:187` and `:196` (endpoint paths call
  it), `:290` (clear-key calls it directly),
  `apps/desktop/src/main/executor-host.ts:325-332`.

- **An endpoint change projects the saved selection onto what will still
  resolve after it, and clears both fields when it no longer does**
  *(decided while planning; revised on advisor review)*: the saved
  `(provider, modelId)` survives an endpoint save only if, given the endpoint
  list this save produces plus the built-in catalogue, the provider still
  exists **and** still offers that model. Otherwise **both** fields are
  cleared, never one of them. Rejected: clearing only `modelId` when a model is
  dropped from an endpoint that is still selected — that produces
  `(provider set, modelId empty)`, which the first decision deliberately keeps
  refusing (`executor-catalog.ts:123`), so the endpoint edit would still fail
  while a unit test asserting "only the model was cleared" went green.
  Without this projection, the first decision turns "delete the endpoint I am
  using" into a permanent refusal — the runtime unregisters providers absent
  from the new settings (`executor-runtime.ts:161`), so the catalogue no longer
  contains it and validation answers "provider 不存在"
  (`executor-catalog.ts:124-127`). Rejected: skipping validation entirely for
  endpoint saves — that would also stop catching a genuinely broken endpoint
  definition.
  Based on: `apps/desktop/src/main/executor-runtime.ts:157-165`,
  `apps/desktop/src/main/executor-catalog.ts:122-127`.

- **That projection is a pure function living outside the component, and it
  takes the catalogue as an input** *(revised on advisor review)*: it needs
  both the endpoint list the save produces (authoritative for custom providers,
  including a model list the save itself rewrites) and the current catalogue
  (the only source for built-in providers and their models). Taking the
  catalogue also covers a built-in provider disappearing across a pi upgrade,
  which would otherwise wedge every endpoint save behind "provider 不存在".
  It lives outside the component because the desktop has no component-level
  test harness — every existing renderer test is a pure-function test
  (`executor-model-search.test.ts`, `settings-nav.test.ts`) — so keeping it
  inline in `upsertEndpoint` / `removeEndpoint` would ship the most error-prone
  half of this change with no automated gate at all. Rejected: introducing a
  component testing stack for this — far out of proportion, and the project
  accepts UI by hand on purpose (`AGENTS.md`, "Test harness").

- **The catalogue is re-fetched on every new settings snapshot**, not only on
  mount: the same line covers both "the endpoint I just saved" and "an endpoint
  another device added", because the main process publishes a settings view on
  every configuration change (`executor-host.ts:142-155`). Rejected: a new IPC
  push channel carrying the catalogue — the existing request suffices and
  saving is rare. Rejected: re-fetching only after a successful local save —
  configuration arriving from another device would still need the page closed
  and reopened.
  Based on: `apps/desktop/src/renderer/components/settings/executor-section.tsx:82-89`,
  `apps/desktop/src/main/executor-host.ts:142-155`.

- **Pre-selecting a new endpoint is a UI selection and must not race the
  settings push** *(revised on advisor review)*: it only sets the dropdown,
  never a save. Three places rewrite form state from an incoming snapshot, not
  one: `adopt` overwrites the provider unconditionally and clears the key
  (`executor-section.tsx:61-68`), and the effect at `:94-100` resets the model
  on every snapshot. That snapshot arrives over IPC while the save's own
  `invoke` is resolving and the two orders are not guaranteed, so the
  implementation must be insensitive to which lands first — for instance by
  having `adopt` overwrite the form's provider only when the snapshot's own
  provider changed. Rejected: ordering the two with a timer.
  Based on: `apps/desktop/src/renderer/components/settings/executor-section.tsx:61-68,94-100`,
  `apps/desktop/src/main/executor-host.ts:142-155`.

- **The model card refuses an empty selection in the renderer, not by relying
  on the main process's error**: with the selection check relaxed, pressing
  "保存" with nothing chosen must not silently store an empty selection. The
  button is disabled (or refuses in place) while provider or model is unset.
  Rejected: leaving it to the backend message — that message is exactly what
  this plan stops producing.

## Direction

Three strictly sequential milestones. M2 and M3 both edit
`executor-section.tsx`, and M2's projection depends on M1's relaxed
validation being in place — **do not fan this plan out into concurrent work
packages.**

Baseline on `f037003d`, measured before any change: `pnpm -C apps/desktop
typecheck` exits 0 and `pnpm -C apps/desktop test` reports 259/259 passing.
(`wiki/plans/README.md` quotes 241 for an earlier plan; that count is stale,
not a regression.)

### Milestone 1: the validator admits an unconfigured selection

`validateExecutorSelection` returns `ok` with a warning when provider and
modelId are both empty, and keeps refusing every other malformed case
(one set without the other, a provider or model absent from the catalogue).
The existing assertion that expects a refusal for the both-empty case is
rewritten to the new semantics, and the neighbouring cases keep their
assertions. Save-success wording stays honest: the sentence reported for a
save that stored no selection must not claim the provider and model were
validated (`executor-host.ts:246-259`).

Validation: `pnpm -C apps/desktop test` -> exit 0.

### Milestone 2: endpoint saves carry the saved selection, projected

A pure function maps (saved settings, the endpoint list this save produces,
the catalogue) to the selection the save should submit, implementing the
projection decision. The endpoint add/edit/delete paths route through it and
stop reading the model card's form state, including its unsaved `apiKey`; the
clear-key path is deliberately left on form state (see Decisions). The
function has unit tests covering at least: deleting the endpoint the account
selects clears both fields; editing an endpoint so it no longer offers the
selected model clears **both** fields; an unrelated endpoint edit leaves the
selection intact; a selected built-in provider that is still in the catalogue
is never touched; a selected provider that is in neither the endpoint list nor
the catalogue clears both fields. No test may assert a `(provider set, modelId
empty)` result — M1 keeps refusing that shape, so such a result would be a
save that still fails.

Validation: `pnpm -C apps/desktop test` and `pnpm -C apps/desktop typecheck`
-> exit 0.

### Milestone 3: the page reflects what was stored

The catalogue re-fetches whenever a settings snapshot arrives, so a saved
endpoint reaches the Provider dropdown without closing the page. The endpoint
section reports its own save outcome and rolls its local list back on failure —
where "failure" means `ok: false`, never a success that merely carries a
warning (see the undelivered-save landmine). A newly added endpoint pre-selects
itself in the dropdown when no provider is chosen, in a way that does not
depend on whether the IPC settings push or the save's return value lands first.
The model card's save button no longer submits an empty selection.

Validation: `pnpm -C apps/desktop typecheck`, `pnpm -C apps/desktop test`, and
`pnpm -C apps/desktop build` -> exit 0.

## Landmines

- `apps/desktop/src/main/executor-catalog.test.ts:67` asserts that a both-empty
  selection produces `/选一个 provider/`. It **will** fail after M1 and must be
  rewritten to the new semantics. Line 68 (`provider: "anthropic", modelId: ""`
  still refused) must keep asserting a refusal — it is what stops the relaxation
  from swallowing a half-filled selection.
- `collectCredentialChanges` (`apps/desktop/src/main/executor-host.ts:325-332`)
  keys the selected provider's credential off `input.provider`. Once endpoint
  saves submit the *saved* provider, verify that a key typed into the model card
  but not submitted cannot ride along with an endpoint save.
- The credential boundary is a security property, not a style: a key must never
  reach `registerProvider` (`executor-catalog.ts:63-71` explains why; pi executes
  a `!`-prefixed config value as a shell command, and this configuration is
  account-shared) and `validateCredentialShape` stays as the second line. Do not
  touch either while moving save paths around.
- `adopt` (`executor-section.tsx:61-68`) unconditionally writes the incoming
  snapshot's provider into form state, and the effect at `:94-100` resets the
  model on every snapshot. Either one silently undoes the pre-selection of a
  new endpoint.
- The success sentence at `executor-host.ts:258` ("已校验：provider、模型与凭据
  形式都正确") is wrong for a save that stored no selection.
- **A successful save whose configuration was not delivered back still
  republishes the *old* snapshot.** When `waitForRevision` times out, `save`
  returns `ok: true` with a warning but has already called `onConfigChanged()`
  (`executor-host.ts:244-245`), which publishes the pre-save view and re-applies
  the pre-save cache to the runtime (`:148-154`). The renderer's `adopt` then
  overwrites the endpoint list with the state from before the save, and a
  catalogue re-fetch will not contain the new endpoint either. M3's rollback
  must key off `ok: false` alone, or this path reads as a failed save. The
  acceptance machine's daemon must be new enough to deliver `executor_settings`,
  otherwise every save looks like this.
- `endpointKeys` (`executor-section.tsx:53`) becomes redundant once endpoint
  saves submit immediately with their own draft key. Left in place, a key from a
  *failed* endpoint save stays in that state and rides along with the next model
  card save (`:146-149`). Prefer removing the state and passing the draft key
  straight into the one submission that needs it.
- No automated gate covers the settings page's rendering. Everything M3 changes
  is accepted by hand; that is why M2 insists on a testable pure function.

## Scope

In scope:
- `apps/desktop/src/main/executor-catalog.ts`
- `apps/desktop/src/main/executor-catalog.test.ts`
- `apps/desktop/src/main/executor-host.ts` (save-result wording only)
- `apps/desktop/src/renderer/components/settings/executor-section.tsx`
- `apps/desktop/src/renderer/components/settings/executor-endpoint-dialog.tsx` (only if the endpoint-area feedback needs it)
- one new pure module under `apps/desktop/src/renderer/components/settings/` plus its test

Out of scope:
- `apps/desktop/src/main/executor-settings-writer.ts`, the centre's schema, the
  protocol, and the daemon cache — the write path itself is not at fault
- credential storage and the write-only credential rules
- device-level overrides — deliberately deferred by plan 20260918
- the model card's own save semantics beyond refusing an empty selection

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Desktop walkthrough (acceptance) | `pnpm dev:desktop:prod` | the flow in Requirement works without closing the settings page |

No black-box suite: this change touches neither the wire protocol, nor release
signing, nor the hot-upgrade path.

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Adding a custom endpoint on an account with no provider/model configured
      stores it on the centre and shows it in the Provider dropdown without the
      settings page being closed.
- [ ] Deleting the endpoint the account currently selects succeeds and leaves
      the account in the "not configured yet" state.
- [ ] An endpoint save never changes the account's provider, model, or key
      because of unsaved model-card input.
- [ ] Editing an endpoint so it no longer offers the account's selected model
      succeeds, and leaves the account in the "not configured yet" state rather
      than with a provider and no model.
- [ ] A failed endpoint save leaves no row in the list that is not on the account,
      and a *successful* save that was not delivered back is not treated as one.
- [ ] The projection function has tests asserting the delete-selected-endpoint
      and drop-selected-model cases, and none of its tests assert a result with
      a provider but no model.
- [ ] Pressing the model card's "保存" with nothing selected is refused by the
      renderer, not by a message from the main process.
- [ ] "清除 key" clears the key of the provider shown in the form, which is the
      provider whose presence made the button appear.
- [ ] The save-success sentence for a save that stored no selection does not
      claim the provider and model were validated.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- Making the flow work appears to require changing the write path, the centre's
  schema, or the protocol — that would mean the diagnosis above is wrong.
- A validation command fails twice after one reasonable fix.
- Relaxing the selection check turns out to let a malformed selection through
  that the catalogue cannot resolve.

## Maintenance notes

The account-level configuration now has a legal partial state: endpoints
configured, no selection. Anything that reads the configuration must treat it as
"not ready" rather than "never configured" — `deriveReadiness` already does, and
it is the place to keep that distinction.

The settings page has two save surfaces with deliberately different semantics:
the model card and its clear-key button submit what the form holds, the
endpoint paths submit what the account holds. A third surface added later has
to pick one on purpose.

Known and deliberately left alone: "清除 key" submits the form's `modelId`, so
when the account's saved model is absent from the catalogue (a model retired by
a pi upgrade, say) the model box is empty and clearing the key is refused with
"先选一个模型". Moving that button onto the saved selection would make it clear
a different provider's key than the one on screen — see the second decision —
so fixing it properly needs a save input that names the credential to clear,
which would mean changing the preload's field-by-field rebuild
(`apps/desktop/src/preload/index.ts:144-161`), the bridge types and the host.
That is a separate change.

Rejected on advisor review: passing the catalogue into the projection function
was adopted (it covers a built-in provider vanishing across a pi upgrade), but
no attempt is made to *repair* such a selection — it is cleared like any other
unresolvable one, and the user re-picks.

Known narrow gap, found in review and deliberately left: while the catalogue is
still loading (`catalog === null`, the first few hundred ms after the page
opens) the projection cannot tell a built-in provider from a custom endpoint the
save is deleting, so it preserves the saved selection. Deleting the endpoint the
account is using inside that window is therefore still refused with "provider
不存在", and the user succeeds on a second attempt. The endpoint controls are
enabled during that window because `editingDisabled` only covers offline and
`catalog.ready === false`, not `catalog === null`. Closing it properly means
giving the projection the *pre-save* endpoint list (`settings.customProviders`),
which distinguishes the two without the catalogue.
