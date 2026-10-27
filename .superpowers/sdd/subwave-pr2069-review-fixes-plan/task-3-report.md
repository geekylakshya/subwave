# Task 3 report

## Result

Implemented deadline-safe corrective request re-picks and schema migration 30 for language query columns.

## RED evidence

- `npm test -- request-claim` failed on the new late-retry regression: the exhausted request still made 2 LLM calls instead of 0.
- `npm test -- task-3-review-fixes` failed both fresh and upgrade cases with `SQLITE_ERROR` because `tracks.language_primary` and `tracks.languages` did not exist.

## GREEN evidence

- `npm test -- task-3-review-fixes`: 2 passed, 0 failed.
- `npm test -- request-claim`: 68 passed, 0 failed, including the late corrective re-pick regression.
- `npm test -- id-adoption-columns`: 6 passed, 0 failed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

The repository-wide run was stopped after several minutes at the user's direction. Before stopping, it exposed an unrelated existing v26 backfill failure; the language-column classification failure from the initial run was fixed and the focused classification test now passes.

## Files

- `controller/src/broadcast/dj-agent.ts`: bounds all three corrective request re-pick paths by the remaining request deadline and propagates cancellation to the model call.
- `controller/scripts/request-claim.test.ts`: adds the late-retry regression proving no model call occurs and the found track remains queued.
- `controller/src/music/library-db/schema.ts`: adds versioned migration 30 with nullable language columns on fresh and upgraded databases.
- `controller/scripts/task-3-review-fixes.test.ts`: covers fresh schema/query behavior and version-29 upgrade preservation.
- `controller/src/music/library-db/id-adoption.ts`: carries language metadata during track ID adoption, preserving language tagging behavior.

## Self-review

The change is limited to request corrective re-picks and the language storage/query path. When no deadline callback is supplied, existing re-pick behavior remains unchanged; when the callback is exhausted, the re-pick is skipped and existing fallback semantics retain the found track or honest fallback. The migration is additive, nullable, idempotent for already-present columns, and reaches schema version 30.

## Concerns

The full repository suite was not allowed to complete because it stalled in a long-running scale test. Its earlier output included an unrelated v26 migration test failure; no task-3 focused test or typecheck failure remains.
