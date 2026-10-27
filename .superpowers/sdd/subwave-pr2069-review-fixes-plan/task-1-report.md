# Task 1 report

## Scope

Implemented only Task 1 on `feat/unified-request-pipeline`:

- moved lyric/film evidence classification into the shared request normalization module;
- centralized the greeting predicate used by the route’s title guards;
- fixed deterministic parsing of repeated generic frames such as `some music` and trailing language clauses;
- preserved named-request, film-evidence, stored-language hard-filtering, and unified web/Alexa pipeline behavior.

No energy, partial-outcome, or web-search-cache work was implemented. No GitHub push was performed.

## Root cause

`modelFreeRequest` removed only one generic frame token. For `play some rock music in Punjabi`, that left `rock music in Punjabi` and prevented the language-plus-genre attribute plan from forming. For `play some music in Punjabi`, the lyric heuristic also treated the `music in Punjabi` wording as a film/evidence relation because its film regex accepted both `from` and `in`.

The route also repeated greeting/title regex ownership while the evidence predicate lived in `request-match.ts`, separate from the shared normalization helpers.

## TDD evidence

### RED

Added focused tests before production changes:

- `direct-request-selection.test.ts`: language-only classification and language-plus-genre constraints;
- `direct-request-route.test.ts`: language-plus-genre request resolves deterministically with zero evidence-agent calls.

Command:

```text
./node_modules/.bin/tsx scripts/run-tests.ts direct-request-selection.test.ts direct-request-route.test.ts
```

The first run failed as expected: 128 passed, 2 failed. The failures were:

- `play some music in Punjabi` classified as `lyrics-or-description` instead of `attributes`;
- `play some rock music in Punjabi` produced no `genre` constraint.

### GREEN

Implemented the minimal normalization and ownership changes, then verified:

- `direct-request-selection.test.ts`: 130 passed, 0 failed;
- `direct-request-route.test.ts`: 146 passed, 0 failed;
- `request-matrix-40.test.ts`: 41 passed, 0 failed;
- `npm run typecheck`: exit 0;
- `git diff --check`: clean.

The route regression explicitly confirmed the request matched `Punjabi Rock Fixture` with `agentCalls === 0`; film and lyric route tests continued to pass through the evidence agent.

## Self-review

The final diff is limited to the two focused test files and the shared matcher/normalizer plus route integration. No unrelated Task 2/3 work is present. Existing named-request behavior and evidence-agent tests remain green. The only expected noisy output in the route suite is its pre-existing synthetic timeout/error logging; the suite completed with 146/146 passing.

## Commit

Local commit: `c6d18e97f` (`fix(request): centralize language evidence classification`)

## Fix round 1

### Review findings addressed

1. Restored the `song|track|music in ...` film-evidence form while excluding recognized trailing language clauses via `hasRequestLanguage()`. Thus `play song in Dune` remains evidence-routed, while `play some music in Punjabi` remains deterministic.
2. Normalized `GREETING_CUE` to `whats up`, matching the existing `requestName()` apostrophe fold. Added coverage for `isGreetingLikeRequest("what's up")`.

### Changed files

- `controller/src/music/request-normalize.ts`
- `controller/scripts/direct-request-selection.test.ts`

### Fix-round TDD RED

Command:

```text
cd /tmp/subwave-latest-release/controller
./node_modules/.bin/tsx scripts/run-tests.ts direct-request-selection.test.ts
```

After adding the two focused regressions, the test run reported `132 tests`, `130 passed`, `2 failed`. The failures were:

- `film evidence keeps the in form without capturing language requests`: expected `true`, received `false` for `play song in Dune`;
- `greeting matching handles normalized apostrophes`: expected `true`, received `false` for `what's up`.

### Fix-round GREEN and relevant verification

```text
./node_modules/.bin/tsx scripts/run-tests.ts direct-request-selection.test.ts
ℹ tests 132
ℹ pass 132
ℹ fail 0

./node_modules/.bin/tsx scripts/run-tests.ts request-matrix-40.test.ts
ℹ tests 41
ℹ pass 41
ℹ fail 0

./node_modules/.bin/tsx scripts/run-tests.ts direct-request-route.test.ts
ℹ tests 146
ℹ pass 146
ℹ fail 0

npm run typecheck
> tsc --noEmit
exit 0

git diff --check
clean
```

Self-review found only the two requested production changes and their focused regression coverage; no unrelated files or behavior were changed.
