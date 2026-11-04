# 0.16.0 — large Dropbox catalogs

## Change

Removed the native Dropbox transport's fixed 100,000-entry listing limit. Both recursive provider listings and shallow account browser listings now continue through all Dropbox cursor pages. No replacement file-count ceiling was introduced.

The native provider consumes normalized entries page by page directly into its selected snapshot, avoiding a second full-tree transport array. Page processing yields to the event loop and checks cancellation, reports cumulative listing progress, and resolves shared ancestor chains once. File contents are not downloaded by enumeration.

The complete selected metadata snapshot remains in memory for path/case collision validation, ordering, remote identity matching and safe removal decisions. This is not an unbounded-size guarantee: available RAM, local filesystem resources and Dropbox API availability still apply. A network error, cancellation or collision while collecting a snapshot prevents reconciliation from applying that incomplete snapshot. Already-created placeholder intents remain in the existing persistent catalog and are reused after restart/refresh; an interrupted metadata enumeration starts a new listing instead of reusing an expired or potentially stale cursor.

Profile format and SQLite schema are unchanged. Updates retain Documents/AMGRCLONE, accounts, rules, cached files and app-owned drive mappings. The existing portable replacement-directory update procedure applies; resetting settings is unnecessary. The macbuild handoff remains a separate, explicitly versioned 0.15.6 source snapshot.

## Regression coverage

`tests/large-catalog.test.mjs` uses a deterministic paginated Dropbox API fixture with 150,123 files. It covers:

- Unlimited cursor pagination, cumulative progress and event-loop service between pages.
- Shallow listings above 100,000 entries.
- Complete reconciliation of 150,123 online-only files plus their parent, with persisted creation intents and no hydration requests (mock native host).
- Network failure after the former limit, preserving the previous catalog without placeholder changes.
- Cancellation after 102,000 entries and retry using the same transport.
- A Windows case collision on the last page, rejected before local changes.

These are synthetic metadata/native-host tests, not a claim that 150,123 real NTFS placeholders were created or that a production account was benchmarked. Packaged background tests exercise the real Windows provider, on-open hydration, responsive Settings, cancellation, restart and reset in an isolated test profile.
