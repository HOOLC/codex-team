# codexm Refresh Resilience Plan

## Goal

Ship refresh-resilience fixes for dashboard and CLI quota reads, with tests and docs aligned.

## Steps

1. Add failing tests for dashboard last-good snapshot retention and CLI quota failure handling.
2. Implement merged snapshot behavior for dashboard refreshes.
3. Keep CLI quota reads explicit about runtime/API/cached/unavailable precedence.
4. Update README, Chinese README, skill docs, and any related internal notes.
5. Run automated tests plus real self-tests against temporary runtime clones.
6. Commit, push, and update the existing PR.
