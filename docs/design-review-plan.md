# Design Review — Execution Plan (gemini-3.7-flash:high subagents)

Status: approved plan. Owner: bromoket. This doc defines how the design passes run after the
specs land: which subagents (all gemini-3.7-flash on `high`, per the cost-aware routing rules),
with which inputs, against which questions, producing which deliverables, and how the owner
reviews their work before anything is implemented.

## 1. Why this pass exists

The implementation specs in this folder are intentionally copy-exact because weaker models
"half-ass" ambiguous work. The design subagents exist to stress-test the specs and surface
alternatives the author missed — not to write implementation code. Their output is input to a
**triage step that the owner reviews before code is written.**

## 2. Review waves

Three independent reviews, run in parallel (one `task` per review; do not stack additional
reviewers on top). Each reviewer gets: the relevant spec file path, the repo surface it touches,
a fixed prompt (below), and a strict deliverable schema. All three are `gemini-3.7-flash:high`.

| Wave | Agent role (agent type) | Inputs | Focus |
| --- | --- | --- | --- |
| A | `reviewer` (design/UX angle via `designer`) | `docs/telegram-redesign-spec.md`, current `src/telegram.ts` builders, `src/observatory/delivery.ts`, screenshots folder `docs/review-assets/telegram-*.png` (owner-provided captures) | Telegram message layout quality: hierarchy, phone-vs-desktop behavior, emoji/copy choices, alignment feasibility within Telegram HTML constraints |
| B | `reviewer` (frontend via `designer`) | `docs/dashboard-live-update-spec.md`, `src/web/dashboard.js/html/css`, `src/web/antigravity.js/css` | Reconciliation architecture, transition discipline, chart-update approach, scroll/focus preservation, feasibility inside the existing 133 KB dashboard.js without a rewrite |
| C | `reviewer` | `docs/account-merge-spec.md`, `src/observatory/omp-usage.ts`, `src/antigravity/*`, `src/observatory/store.ts` types | Merge-key correctness: identity matching, event/alert dedupe semantics, canonical-count invariants, migration safety, future `openai-codex` generalization |

Agent availability note: if a `designer`-typed specialist is not configured for the selected
model role, use the plain `reviewer` agent with the design prompt. Provider-neutral routing
applies: the model for all three is gemini-3.7-flash on `high`.

## 3. Fixed review prompt (same skeleton for all waves)

```
You are reviewing a spec before implementation. Do NOT write code.

Read {SPEC_PATH} fully. Also read the referenced current code files (read-only) so your
feedback is grounded in what exists: {CODE_PATHS}.

Answer, in order, with evidence:
1. Correctness holes: 3-8 concrete cases where the spec as written would produce a wrong,
   flickering, duplicated, or unreadable outcome. For each: the spec section, the scenario,
   the failure mode, and a one-paragraph fix (either a spec amendment or a rejection).
2. Feasibility risks inside the current codebase: name exact functions/structures that make the
   spec hard to implement as written (e.g. full-render call sites that the reconciliation must
   bypass) and how to bridge them with minimal blast radius.
3. Alternatives with materially different tradeoffs that the owner should weigh (max 3), each
   with a recommendation and a reason. Do not invent requirements; only compare real options.
4. Anything in the spec that is over-engineered or under-specified for its stated goal.
5. A prioritized action list: P0 (must change before implementation), P1 (should change),
   P2 (optional), each item one line: "spec file:section → action".

Output format: markdown, max 120 lines. Lead with the 5-item priority list; keep each finding
to ≤ 4 lines. Cite spec sections and file:line anchors, never vague references. Flag anything
you could not verify as UNKNOWN instead of guessing.
```

## 4. Deliverables and storage

- Each reviewer writes its answer to `local://design-review-{a|b|c}.md` and its final chat
  output is the same markdown (do not duplicate).
- The owner-facing summary from the coordinator (this project's lead) aggregates the three:
  a short table (wave, P0 count, top 3 items) plus a verdict per wave: ACCEPT / AMEND / REJECT.

## 5. Triage gate (owner reviews before implementation)

1. Coordinator applies the P0/P1 items to the specs (edits to the doc files only; no code).
2. Where reviewers disagree or propose a real tradeoff (e.g. Telegram alignment approach,
   suppress-broker-mirror-alerts default, chart update strategy), the coordinator summarizes
   the options and the owner picks; nothing contentious is decided unilaterally.
3. Amended specs get a `## Review log` section appended: date, wave, verdict, and the exact
   amendments applied (diff-style notes). This preserves the reasoning trail for the compacted
   sessions.
4. Only after the triage gate passes do implementation sessions start against the amended
   specs (each implementation wave = one spec, one work session, full suite + UI smoke +
   live verification as each spec's acceptance criteria require).

## 6. Owner review ritual

- For each wave deliverable the owner reads the priority list + verdict table in chat (not the
  full 120-line markdown unless asked).
- The owner can bounce a wave back with `re-review <letter> <focus>`; the same prompt is rerun
  with the added focus line, no extra reviewers stacked.
- Review cost stays on the gemini-3.7-flash:high lane; no deep/security reviewers are spawned
  for these three passes (no auth/secret/kernel boundaries are touched by the specs; the merge
  spec touches identity data but contains no credential handling changes — if the implementer
  later touches token/refresh handling, a `security-reviewer` pass is required by policy then).

## 7. Ordering

Run A, B, C in parallel in one wave after the owner confirms the three specs. Amended specs then
unblock implementation in this order: live-update (B) first (its reconcile helpers are the
foundation the Antigravity UI and merged views depend on), merge (C) second, Telegram (A) third.
