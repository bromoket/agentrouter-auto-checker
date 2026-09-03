# Live Dashboard Updates — Zero-Flicker Data Pulling

Status: approved plan. Owner: bromoket. Scope: the whole observatory dashboard SPA
(`src/web/dashboard.html/js/css`, `antigravity.js/css`) and the refresh pipelines feeding it
(SSE event stream, `live` snapshot polling, per-view fetches, the Antigravity 15 s poller).

## 1. Observed problems

When the server pushes new data (SSE event or poll tick) the page visibly flickers and items
"jump around / get reorganized":

1. **Whole-container innerHTML replacement.** Renderers such as the quota list, identities
   grid, account roster, Antigravity account cards, and event tables rebuild their container
   from scratch on every refresh (`container.innerHTML = …`). Every rebuilt node restarts CSS
   transitions (the `.ag-bar > i` width animation re-runs from its initial state or the
   `transition: width` snaps), charts/rows are destroyed and recreated, and layout reflows as
   old nodes are removed.
2. **SSE-driven full re-render.** `connectObservatoryStream` schedules `refreshObservatoryFamilies`
   after events and several paths call `renderActiveView()` (whole page) on a ~250 ms
   debounce. One event re-renders widgets whose data did not change.
3. **No stable keys.** Lists key by index or not at all; when sort order changes (e.g. newest
   event first) identical DOM nodes are torn down and rebuilt in new positions instead of being
   moved, so scroll position and any in-progress interaction are lost and the eye sees
   "reorganization".
4. **Timing races.** Independent fetchers (observatory families, antigravity) resolve out of
   order; a slower older response can overwrite fresher state, and charts can briefly render
   empty then full (empty→data flash).
5. **Text-driven height changes.** Cards change height when text appears/disappears ("awaiting
   first direct probe", error lines, countdown text width), shifting everything below.

## 2. Principles

- **The DOM is a projection of state; never rebuild what did not change.** Each widget owns a
  pure `render(state)` that reconciles into its container using stable keys.
- **Animate deltas, not rebuilds.** Bulk updates apply with transitions suspended for one frame,
  then the new state is painted; only genuine changes animate.
- **One coherent snapshot per surface.** A view renders from one assembled state object; partial
  server pushes update the state, then the view re-renders once (never N sources racing).
- **Never disturb the user.** Scroll anchoring, open dialogs/dropdowns, expanded groups, and
  hover states survive refreshes.
- Preserve the existing overall look; this is an engineering change, not a redesign (visual
  refresh is handled in the design-review pass).

## 3. Architecture

### 3.1 State store and widget registry (additive, non-invasive)

Introduce a small shared layer in `dashboard.js` (module scope, no framework):

```
const app = {
  state,                          // existing state object (unchanged shape)
  widgets: new Map(),             // id -> { container, selector, render(state, patch) }
  pendingPatch: null,             // coalesced snapshot for next frame
  rafScheduled: false,
  transitionsSuspended: false,
};
```

- `registerWidget(id, { root, render })` — renderers opt in. Existing big renderers
  (`renderQuotas`, `renderAccounts`, antigravity `renderAccounts`, trace archive, events list)
  are refactored into keyed reconciliation functions (below) and registered. Non-opt-in code
  paths keep working unchanged during the transition.
- `publish(snapshot)` — merges `snapshot` into `app.state` with a monotonic guard, coalesces
  into `pendingPatch`, schedules one `requestAnimationFrame` flush.
- Flush: `suspendTransitions()` → for each registered widget whose data slice changed call
  `render` → `resumeTransitions()` after the frame (`getComputedStyle` force reflow between
  suspend/resume so new nodes appear without animating from nothing).

### 3.2 Keyed reconciliation helper

```
function reconcile(root, items, { key(item), build(item, existingNode) })
```

- Existing nodes are indexed by `key`.
- Diff per key: if the node exists, `build` mutates only changed parts (set `textContent`,
  patch `style.width`, toggle classes, replace only leaf values) and returns the node; if
  missing, append the built node.
- Removed keys are detached (kept in a `recycleBin` for 300 ms then discarded so exiting
  elements can fade out without affecting layout — fade via `opacity` + `transform`, never
  layout properties).
- Order changes move nodes via `insertBefore` (no rebuild).
- Every list card gets `data-key` from a stable id: account ids, window
  `provider:bucket` tracker keys, event ids, run ids.
- Height stability: cards that can show/hide helper text get a min-height equal to their
  maximum common layout (two-line footer area) or use `content-visibility: auto` for long
  scrollable feeds — measure with the reviewer pass before committing to min-heights per card.

### 3.3 Transition discipline

- Add one global class on `<html>` during bulk patches: `.reconcile-batch` — CSS:
  `.reconcile-batch * { transition: none !important; animation: none !important; }`.
- After the batch is applied and painted, remove the class. Width/text changes that are real
  deltas (e.g. bar moved 89% → 71%) animate afterwards by re-adding the transition on that
  element only in the next frame (`el.style.transition = "width .6s"` then set width). Simpler
  variant that satisfies "no flicker": bars always set width with transitions **disabled**
  during refresh and never re-run a fill animation from 0. Accept explicit rule: **width is set
  once per data change; no element ever animates from an empty state during a refresh.**
- Chart.js: do not destroy/recreate charts whose config/canvas survived; update via
  `chart.data` + `chart.update('none')` inside the batch, and only on data change. Keep the
  existing destroy-on-view-switch behavior (showView) intact.

### 3.4 Feed coalescing and freshness

- SSE event → update the corresponding slice only (`scheduleObservatoryRefresh` family map
  already exists) → `publish(slice)`. Remove paths that call `renderActiveView()` for an event
  that does not affect the visible view.
- Poll tick (`startLiveTicker`) keeps calling the combined `live` endpoint; responses are
  applied with `observedAt`/`updatedAt` monotonic guard — discard any patch older than the
  current state timestamp per slice.
- Antigravity: replace its own `setInterval` fetch with a subscription to the same ticker +
  SSE family registration (`refreshObservatoryFamilies` gains an `antigravity` family that hits
  `GET /api/antigravity/overview`). One scheduler, one flight guard, one 15 s cadence, same
  reconciliation.
- Serialize fetches per family with an in-flight flag and a `staleWhileRevalidate` model:
  always render the last good snapshot immediately; a refresh failure never blanks widgets
  (show a quiet `stale · updated Ns ago` chip instead of clearing content).

### 3.5 Scroll and interaction preservation

- Before a batch flush on scrollable feeds (events, trace archive, activity table), record
  `container.scrollTop` + `scrollHeight`; after reconcile, restore proportional scroll
  (`scrollTop = prev + (newScrollHeight - prevScrollHeight)` for appended content) — or simply
  do not touch `scrollTop` when the diff appended rows below the viewport (prepend/newest-first
  feeds should reverse: if the user is at the top and new rows arrived, keep anchor element
  pinned via `data-key` scrollIntoView).
- Dialogs/popovers: reconciles never remove a container that holds an open dialog; a widget
  that includes dialog content registers it as an overlay separate from the reconciled root.
- Focus: if the focused element would be replaced, `reconcile` transfers focus to its keyed
  successor.

## 4. Concrete per-surface changes

1. **Provider Quotas / Credentials / Identity lists** — keyed rows by
   `provider:identityId:bucket`; per-row status dots, bar widths, and countdown text update in
   place. Row order changes only when actual sort data changes (move, not rebuild).
2. **Overview metrics + money chart** — chart instance updates in place; metric cards are
   keyed by metric id; numbers get a brief `.pulse` class only on actual value change (CSS
   animation on `--pulse` custom property, no layout props).
3. **Antigravity account cards** — cards keyed by account id (already `data-ag-id`); reconcile
   patch per card: bar `style.width`, `%` text, countdown text, chip states, error line
   presence; never rebuild the grid. Pause/delete/probe buttons stay put and keep working
   (event delegation on the grid root instead of per-card listeners so re-render never drops
   handlers).
4. **Events feed + trace archive** — keyed by event id; newest-first append prepends a node at
   top without touching the rest; auto-refresh respects "paused when scrolled down" if the
   feature exists or add it (scroll-bottom stickiness off by default, on when user at bottom).
5. **System/health page** — keyed rows; unchanged behavior otherwise.

## 5. Data/API support (backend, small)

- `GET /api/antigravity/overview` unchanged; add `?since=` (ms) and return `304`/`{unchanged:
  true}` when the account set + all snapshot `probedAt` values are older than `since` — cheap
  for the 15 s poller.
- Observatory families already return full snapshots; add `updatedAt` top-level if missing so
  the monotonic guard has a stable clock per slice (verify per endpoint; document which field
  each slice uses).
- Ensure `Last-Event-ID`/SSE resume already replays missed events (existing) and that replay
  applies through the same `publish` path (it must not double-render: dedupe by event id set).

## 6. Verification

1. Add a deterministic flicker regression harness (playwright, headless chrome):
   - seed store with 3 accounts/quotas/events, load dashboard, force 10 refresh ticks;
   - assert DOM mutation count is bounded per tick (instrument `MutationObserver` in page),
     assert no container's `innerHTML` is replaced except first render (wrap containers with a
     test hook `data-render-count` incremented by the builder, assert count stays 1 after
     first paint),
   - assert scrollTop preserved after appending events while scrolled,
   - screenshot before/after tick: pixel diff limited to the changed widgets' bounding boxes
     (no whole-viewport repaint evidence: compare screenshots; expect small diffs).
2. Manual: run the dashboard, watch quotas + antigravity for 2 minutes: no flicker, no card
   reordering, chart stable, open a dialog and let ticks pass — dialog stays open.
3. Existing UI smoke (`scripts/ui-smoke.mjs`) + dashboard JS tests stay green; typecheck green.
4. Performance: count mutations per 30 s tick (< ~80 for a 10-account fleet) and report
   long-task durations (< 50 ms) via the harness console timings.

## 7. Acceptance criteria

- A 30-second refresh cycle produces zero visible flicker/reflow outside the widgets whose data
  changed, verified by the regression harness and manual review.
- Scroll, dialogs, focus, and expanded state survive refreshes.
- Server pushes are coalesced to one paint per frame; stale responses can never overwrite
  fresher state.
- Antigravity polling runs through the same scheduler as the rest of the dashboard.
- No chart is destroyed/recreated on a data-only tick.


## 8. Review log + amendments (2026-09-03 · DesignReviewB, verdict FAIL — P0 blockers fixed here)

B1. **Timestamps (P0).** Verified: `/live` has `timestamp` but its slices lack per-slice
    `updatedAt`; `/overview` has only `generatedAt`; `/quotas /identities /hosts /sessions
    /events /policies /api/antigravity/overview` have no top-level timestamp. Backend: add a
    top-level `updatedAt: ISO` to every observatory and antigravity overview/list response
    (api.ts handlers). Client: `getSliceTimestamp(data) = data.updatedAt || data.timestamp ||
    data.generatedAt || max(item.updatedAt|observedAt|occurredAt)` fallback; monotonic guard
    uses the resolved value and treats equal timestamps as no-op.
B2. **Scoped transition suspension (P0).** Never touch `<html>`. The batch class is applied to
    each reconciling widget container only (`.widget-reconciling * { transition: none
    __omp_shell("important; }`), removed after the paint frame. Toasts, LEDs, hero orbits, and terminal")
    fades outside the container are untouched.
B3. **Chart.js contract (P0).** `createChart` must first consult `state.charts.get(id)`: if a
    live instance exists on an attached canvas, cancel the pending `chartTimers` entry, replace
    `labels`/`datasets` in place, re-run the gradient helper on the live context, and call
    `chart.update('none')`. Destroy only on view switches (existing destroyCharts paths).
B4. **Two-level reconciliation (P1).** Quotas/Credentials: outer reconcile keyed by
    `identityId` on the container (cards preserved), inner reconcile keyed by window/bucket id
    inside each card's rows container. Never flatten rows into the outer container.
B5. **Prepend anchoring (P1).** Capture the top-most visible element key + its rect.top before
    the diff; after the diff adjust `scrollTop` by that element's delta; when `scrollTop === 0`
    keep it 0. No `scrollIntoView` on pinned views.
B6. **Delegation on static roots (P1).** All list/card actions bind once to the static outer
    wrapper (`#ag-accounts`, `#quotas-container`) via `closest()`; never attach per-card
    listeners to nodes that reconciliation may replace.
B7. **Simplifications (P2 accepted):** drop the 300 ms recycleBin and `content-visibility:
    auto`. SSE dedupe becomes a bounded ring (500 ids).
B8. **Mechanism decision for the owner.** Hand-rolled keyed leaf mutators + two-level list
    reconcile (no new dependency, fits the vanilla monolith; recommended) vs vendoring
    `morphdom` (~5 KB single file) for complex card bodies. Implementer must not pick without
    owner confirmation.
