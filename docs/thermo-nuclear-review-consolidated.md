# Thermo-Nuclear Code Quality Review — Consolidated Report (single file)

This is the **single** consolidated report for the `@dsh-external/dsh-session-resume` plugin's
thermo-nuclear code-quality review. Every per-round report (the early `thermo-nuclear-review*.md`,
`code-quality-assessment.md`, `thermo-nuclear-review-round-11.md`, and the Round-12
`thermo-nuclear-code-quality-review.md`) has been folded in here and removed, so this one file is
the only record of the full review standard, all rounds, all findings, and every applied change.

Review object: `@dsh-external/dsh-session-resume` (`D:/AI/dsh-plugins/session-resume-plugin`),
the full current working tree (`src/**`, `tests/**`, build config, docs). No git repo is in-tree,
so each round's "current branch" equals the whole tree.

Parts: §1 verdict · §2 round timeline · §3 举一反三 (governing principles, organized across every
doc) · §4 master findings (deduplicated) · §5 intentional/documented notes · §6 forward-looking ·
§7 how to close / verify.

---

## 1. Overall verdict

Across every round (1 → 12) the tree has been **deliberately healthy — no structural regression
was ever found**, and no round pushed a file toward the 1000-line quality boundary.

- Largest current source file: `src/host/routes.ts` at **~425 lines** (all well under 500; the
  1000-line blocker applies to nobody). The pre-decomposition `api.ts` (454 lines) was split in
  Round 11.
- Functions are short (4–20 lines), early-return, strongly typed, fail-closed.
- The `shared` / `host` / `client` split is honest: pure text in `shared/`, host I/O in `host/`,
  browser wiring in `client/`.
- Canonical helpers are single-sourced: `safePathSegment`, `readService` + accessors,
  `readRequiredToken`/`readOptionalToken`, `retryWithBackoff`, `isResumePlan`,
  `buildResumePrompt`, `resolveResumeInstruction`, `collectImageRefs`/`eventContentRoots`,
  `createResumeExecutorScope`.
- Idempotency, WAL recovery, bounded retries, audit, and fail-closed media handling are all
  present and test-backed.

### Verification baseline (current)

```
npm run typecheck      → PASS
npm test               → 118 tests, 0 failures (with pretest build)
npm run build:client   → PASS   (suite history: 114 → 116 → 118)
```

---

## 2. Review rounds — timeline (all folded here)

| Round | Source doc (now archived) | Highlights (all resolved) |
| --- | --- | --- |
| Thermo review | `thermo-nuclear-review.md` | Source-log failure preserved (no more flattened 404); client retry no longer duplicates target sessions; collision-safe path segments; full effective config; stored sequence-numbered snapshots (clock-free); workspace-create compensation; serialized WAL + trim keeps in-flight; dead wrapper/stale-doc removal |
| Findings round | `thermo-nuclear-review-findings.md` | `/complete` accepted-report is required + bounded same-attemptId (no false "done"); order-insensitive batch key; all-or-nothing rewrite; single source-ref scanner; snapshotIds via `isSafeOrderId`; single attachment guard; workspace-state gating on packaged manifest; collapsed prompt builders |
| Struct round | `thermo-nuclear-review-current.md` | Snapshot descendant counting under `subagents/`; unreadable snapshots fail closed; concurrency-safe config write; visible WAL failures + startup gating; batch in-flight key dedup; pre-step over-limit keeps whole message; invalid `snapshotIds` → 400; WAL row validation; test autodiscovery; layout reuse |
| Next round | `thermo-nuclear-review-next.md` | Batch cap matches official `MAX_REFERENCES`; workspace scan skip symlinks/junctions; shared source-ref model; strict API body validation; snapshot readability checks the real root artifact; single/batch host+client dedup |
| Round 09 | `thermo-nuclear-review-round-2026-09-03.md` | Removed duplicate distinct-count helpers; collapsed identity prompt wrappers; hoisted `JSONL_DIRECTORY_KIND`; dropped a dead export |
| Round 10 | `thermo-nuclear-review-round-10.md` | Removed dead `findLogPathMatch`/`findLogUrlMatch`; dropped `snapshotRootPath` dead null branch; media type fail-closed (no `.undefined`); typed `ResumeOrderUiState`; dropped dead `ResumeStage` re-exports |
| Strict re-assessment | `code-quality-assessment.md` | F1 layering honesty, F2 contract dedup, F3 code consolidation (canonical-helper reuse), F4 spaghetti convergence (all implemented) |
| Round 11 | `thermo-nuclear-review-round-11.md` | One repeated-conditional residue: the safe-token rule was still hand-rolled at `/complete` and `readSnapshotIds`; consolidated through one validator. Watch item resolved: `api.ts` 454 lines → decomposed into `routes.ts` (393) + `api.ts` (72) dispatch/transport shell under F5. `npm test` 116 green. |
| Round 12 | `thermo-nuclear-code-quality-review.md` | Fresh review + "一并处理". Closed the Round-11 `/complete` residual with a field-scoped `readRequiredToken`; unified the getter-facade convention (`readCacheRootSafe` into `service.ts`); a single instruction-resolution seam (`resolveResumeInstruction`); scoped the client executor (`createResumeExecutorScope`); removed the `ResumeOrderPlan` alias; fixed the route-count doc drift. **118/118 green.** |
| Round 13 (current) | `CODE-QUALITY-REVIEW.md` / `CODE-QUALITY-REVIEW-CURRENT.md` (review workspace) | Fresh current-state pass (verdict PASS) plus driven cleanups: collapsed the dead `ResumeSessionConnection` carrier to return just the session id; derived the mention token from `SESSION_REFERENCE_SCHEME` (no duplicate scheme literal); fanned out independent `resolveSession` calls with `Promise.all`; scoped the config write queue per cache root; hardened the WAL-recovery-gating and concurrent-config-write tests to make their claims observable. **118/118 green.** |

> Round count note: Round 11 reported "116 tests"; Round 12 added 2 regression tests → **118**.
> The `api.ts` size figure drifted between rounds (446 vs 454): the authoritative number is that
> `api.ts` held every handler inline at 454 and became a 72-line dispatch shell after Round 11.

---

## 3. 举一反三 — governing principles drawn across every round

Each round produced a local fix; the durable value is the *generalized* rule that prevented the
class of the fix. These are the cross-document conclusions to grep for before writing any future
code in this tree.

**P1 — A rule is single-sourced, and the reader is used in the correct mode.**
The safe-token rule is the canonical example: a round "centralizing" `readOptionalToken`
(R10) still left two hand-rolled re-derivations (R11 `/complete`, `readSnapshotIds`), and R11
"fixed" `/complete` with optional+required check, which R12 then saw as the wrong *mode* and
upgraded to `readRequiredToken`. Lesson: don't just delete the duplicate — also make sure each
caller selects the right variant (optional vs required, `string` vs `string | undefined`) so the
type and the branch both disappear, not just the copy of the rule.

**P2 — Delete a whole concept, don't rearrange it.**
Every round that added indirection/getting-worse was reversed by *deleting* the concept, not
polishing: identity `ResumeOrderPlan = ResumePlan` alias (R12), identity prompt wrappers (R9),
dead `findLogPathMatch`/`findLogUrlMatch` (R10), duplicate distinct-count helpers (R9). Test for
every abstraction: "does it prevent a concrete failure?" — if no, delete.

**P3 — Every concern has a canonical home, and boundary split separates orchestration from
business logic.**
`shared/plan.ts` owns the one wire contract; `api.ts` owns dispatch/transport (loopback, rate
limit, request id, 404/500, WAL wiring) and `routes.ts` owns per-endpoint business logic and
request-shape validation (R11). Every service/facade read converges on `service.ts` (R12). New
code goes to the owning layer, not to a near-by module.

**P4 — Fail closed, and preserve the real status/error across a boundary.**
Unknown media type is skipped + logged (no `.undefined`), unreadable snapshots are `readable:
false`, source-log failures travel as `404/501/500` — never flattened to a generic 404.
A degraded read degrades to "cannot resolve", never to a fabricated success.

**P5 — Idempotency and ordering never trust the wall clock.**
Snapshots are stored integer-sequence-numbered (not `Date.now()`); the attempt-id fallback is a
per-scope monotonic counter; WAL is append-only with latest-wins; `/complete` is idempotent and
bounded. (Rate-limiting *may* use the clock — the "no clock" rule targets idempotency keys and
ordering.)

**P6 — Module-level mutable state is behind an explicit scope, though the caller interface
doesn't change.**
R12 replaced bare `attemptSeq`/`resumeOrdersInFlight` with `createResumeExecutorScope()`, giving
tests a deterministic per-scope id generator and per-scope in-flight dedup while keeping every
UI call signature intact. Reuse the default scope for single-instance behavior.

**P7 — Doc honesty is a code-quality signal; stale figures are trust debt.**
R12 fixed a "eight vs nine handler bodies" doc drift and a dead identity alias — cheap, but
exactly the kind of stale comment that makes a future reader trust the wrong thing.

**P0 — Verify each applied change with a regression test and a green suite.**
Every round's "一并处理" landed with `npm run typecheck` + `npm test` green (`114→116→118`),
regression tests added for each change, and `npm run build:client` PASS.

---

## 4. Master findings list (deduplicated across all rounds)

Only the **current status** matters; earlier round-prose that duplicates a later fix is folded
here. Status: ✅ resolved (verified by regression test) · 🔒 documented (kept as intended
behavior).

### 4.1 Structure / boundaries (F1–F4, all ✅)

| Finding | Status | Evidence |
| --- | --- | --- |
| F1 `shared/` layering was dishonest (host-only & client-only modules mixed in) | ✅ | Host `config`/`cache-root` moved to `host/`; client browser wiring → `client/resume-client.ts`; pure text in `shared/resume-text.ts` |
| F2 `ResumePlan` shape guard written twice (WAL + fetch) | ✅ | Single `isResumePlan` in `shared/plan.ts` |
| 3 near-identical prompt builders + duplicated retry loop + tripled UI finish-mapping | ✅ | One `buildResumePrompt`; shared `retryWithBackoff`; `runResumeOrderWithUi` |
| F4 highest spaghetti: runtime image-shape probing (`collectEventImageRefs`) | ✅ | Data-driven `eventContentRoots` + single recursive walker |

### 4.2 Reliability & correctness (P0/P1) — all ✅

| Finding | Resolution |
| --- | --- |
| `/complete` failure swallowed → UI success + retry could mint a 2nd target session | ✅ report required, bounded, same attemptId; no false `done` |
| Client retry minted new attemptId → duplicate target session | ✅ resolve + connect once; only prompt retried on same id |
| Batch dropped the workspace-state pointer single honors | ✅ shared suffix appended when any source packaged state |
| Host source-log failure flattened to 404 | ✅ `SessionLogPathResult` preserves 404/501 |
| Batch cap (5) overran official `maxReferences` (=3/MAX_REFERENCE) | ✅ `MAX_SOURCE_SESSIONS = MAX_REFERENCES = 3` |
| Runtime event carrier parsed without shape guards | ✅ `Array.isArray` + shape guards, fail-closed |
| `/complete` hand-rolled required-token (R11 residual) | ✅ field-scoped `readRequiredToken` (R12); required/optional readers each used correctly |

### 4.3 Boundaries & safety — all ✅

- Workspace scan never follows symlink/junction targets ✅
- snapshot ids/prune not sorted by wall-clock ✅ (stored integer sequence)
- `hasWorkspaceState` gates only on packaged `manifest.json` ✅
- two-source `safePathSegment` collision (child vs child_) ✅ `~<sanitized>_<sha256>`
- `/resume-batch` body strictly validated → 400 ✅
- pre-step rewrite all-or-nothing ✅
- single attachment guard (no dual timing) ✅
- unknown media skipped + logged, `layout.media` honest ✅

### 4.4 Dead surface removed — all ✅
| Remove | Round |
|---|---|
| Test-only `countDistinctLogSessions`/`countDistinctLogPaths` | 09 |
| Test-only `findLogPathMatch`/`findLogUrlMatch`; `snapshotRootPath` dead null branch | 10 |
| Identity prompt wrappers; `defaultCacheRoot` private | 09 |
| Dead `sessionReferenceResolver` inject; `created` audit status | Findings |
| `ResumeStage` re-exports in `order.ts`/`batch.ts` | 10 |
| `ResumeOrderPlan = ResumePlan` identity alias | 12 |
| Duplicate `readCacheRootSafe` (snapshot-store) — unified into `service.ts` | 12 |

### 4.5 Type & boundary tightening
- `readTitleSnapshots` 6-way optional union — 🔄 intentionally kept (real runtime shape; readable).
- Client order state typed `ResumeOrderUiState` union instead of bare `string` ✅
- `isResumePlan` shared contract for WAL + fetch ✅
- Required-vs-optional token reader field-scoped (R12) ✅

---

## 5. Intentional / documented notes (deliberately kept — not churn)

- **Attachment double guard** — materialization requires an attachment store even for text-only
  logs; reachable only after that guard. Intended fail-closed default.
- **`titleFromObservation` / readTitleSnapshots variance** — unavoidable across two official
  session-query API versions; thin and contained.
- **Batch vs single in-flight keys ignore `snapshotIds`** — inert today (no UI passes explicit
  snapshot ids); revisit when an input path starts.
- **Snapshots + WAL are single-process atomic** — redocumented deployment boundary, not changed.
- **`resolveSession`/`resolveFromText` flatten a query failure to `null`** (→ `/copy` 404) —
  deliberate tolerant contract (R10/R11 choice); the clean 404/501 split lives on
  `resolveSessionLogPath` (the plan path).
- **`rate-limit.ts` wall-clock** — correct; the "no clock" rule targets idempotency/ordering.
- **Shallow plan copies in `resume-order.ts`** — safe because `plan` is replaced, never mutated
  in place; guarded top-level fields.

---

## 6. Forward-looking notes

- **F5 resolved** — add new endpoints to `routes.ts`; keep `api.ts` as loopback/limiter/dispatch
  shell. This is the standing structure, not a future note.
- **P6 extension** — keep building executor/other per-context state behind explicit scopes.
- Any new ad-hoc conditional/duplication should follow the "collapse into the canonical
  abstraction in the owning layer" convention (P1–P3).

---

## 7. How to close / verify

```
npm run typecheck
npm test          # 118
npm run build:client
```

All pass on the current tree. This consolidated file is the single thermo-nuclear review report;
per-round thermo-nuclear docs have been folded in and removed, pointing here.

---

*Final note: rounds 1–12 maintained a single high bar — no structural regression, no file-size
explosion at the 500/1000-line boundaries, and no spaghetti-branch growth; every applied fix was
regression-tested and the suite kept green. The governing principles (见 §3 举一反三) are the
durable result this single report exists to preserve.*