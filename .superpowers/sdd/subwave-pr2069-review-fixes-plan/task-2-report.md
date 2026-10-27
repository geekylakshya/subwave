# Task 2 report

## Status

Implemented the two requested maintainer fixes on `feat/unified-request-pipeline` at `78c7f7d25`. No classification/routing, schema migration, energy, partial-outcome, or web-search-cache-scope changes were made.

## RED evidence

- Added `an evidence agent cannot report a real stand-in id as a matched request` to `controller/scripts/direct-request-route.test.ts`. Before the fix it queued the real but unverified stand-in and returned `resolved` instead of the expected honest `no-match`.
- Added `a null identification is not retried with the same evidence input` to `controller/scripts/request-identify-alias.test.ts`. Before the fix it observed two identity-model calls for the same `(reference, evidence)` input instead of one.

Existing null-ID coverage was retained and exercised by the direct-request suite: an evidence agent returning `id: null` remains an evidence miss and does not enter the fallback matcher.

## GREEN evidence

- `direct-request-route.test.ts`: 147 passed, 0 failed.
- `request-identify-alias.test.ts`: 13 passed, 0 failed.
- `request-breaker-identification-miss.test.ts`: 1 passed, 0 failed.
- `npm run typecheck`: passed.
- Full `npm test`: 5,133 passed, 1 failed. The sole failure was unrelated: `observatory-scale.test.ts` hit `SQLITE_FULL` during the 200,000-row `setMapCoordsBulk` transaction.

## Files changed

- `controller/src/broadcast/dj-agent.ts`: when `identifyRequestedTrack` was used, only IDs in its verified candidate results can proceed; another real ID becomes `RequestIdentificationMiss`, preserving the breaker exemption and route-level honest no-match.
- `controller/src/llm/internal/tools/picker/tools/identify-requested-track.ts`: memoized identity results by exact reference/evidence input; focused retries still use a distinct evidence key.
- `controller/scripts/direct-request-route.test.ts`: stand-in regression and verified evidence fixture update.
- `controller/scripts/request-identify-alias.test.ts`: duplicate identity-call regression.

## Self-review

- Exact evidence candidates still queue normally.
- Null IDs and unverified stand-ins do not queue or record as matched.
- `RequestIdentificationMiss` remains the expected breaker-exempt error path.
- Focused evidence changes remain eligible for one intentional retry.
- `git diff --check` passed; no unrelated files are modified.

## Concerns

- The full-suite `SQLITE_FULL` failure is environmental/storage-related and outside this task; it should be rerun with sufficient temporary disk space before treating the whole suite as clean.
- Explicit substitution was not broadened: evidence-agent mismatches intentionally remain honest no-match unless a separate, verified substitution path exists.

## Fix round 1: corrective-repick evidence authority

### Finding addressed

The initial evidence-authority check could be bypassed when claim or artist-spacing guards repicked from the broader `extras.seen` pool. Corrective repick pools are now restricted to IDs verified by `identifyRequestedTrack` whenever an evidence call participated in the request.

### RED

Added `an evidence-authorized request cannot be replaced by an unverified corrective candidate` to `controller/scripts/request-claim.test.ts`. The test supplies verified `Billie Jean` plus unverified `Holiday`, triggers a later claim corrective repick, and initially failed because `Holiday` was queued.

RED command:

```text
npx tsx scripts/run-tests.ts request-claim.test.ts
```

Relevant failure before the fix:

```text
✖ an evidence-authorized request cannot be replaced by an unverified corrective candidate
AssertionError: Missing expected rejection.
```

The test was then corrected to assert the intended preserved behavior: the corrective call still runs, but the verified `Billie Jean` remains the queued/reported track rather than the unverified `Holiday`.

### GREEN commands/output

```text
npx tsx scripts/run-tests.ts request-claim.test.ts
67 passed, 0 failed

npx tsx scripts/run-tests.ts direct-request-route.test.ts
147 passed, 0 failed

npx tsx scripts/run-tests.ts request-identify-alias.test.ts
13 passed, 0 failed

npx tsx scripts/run-tests.ts request-breaker-identification-miss.test.ts
1 passed, 0 failed

npm run typecheck
passed
```

### Fix-round files and self-review

- `controller/src/broadcast/dj-agent.ts`: added an evidence-aware `verifiedPool`; unknown-id salvage, claim repicks, and artist-spacing repicks now receive only evidence-verified candidates. Non-evidence request pools remain unchanged.
- `controller/scripts/request-claim.test.ts`: end-to-end corrective-repick regression proving the unverified candidate is neither queued nor reported.

Exact verified requests continue to pass, existing explicit-substitution and claim-guard behavior remains green, and the request breaker path is unchanged.

Fix-round commit: `01d1cec5a`.
