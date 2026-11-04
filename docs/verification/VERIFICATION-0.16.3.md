# 0.16.3 — bounded history and isolated failed-account recovery

## Journal policy

History maintenance runs in a separate Node worker, initially after 10 seconds and then every minute. Transactions remove at most 500 rows per batch, with yields between batches and a short lock timeout. Busy batches retry. File events are limited to the newest 100,000 entries per account and 30 days. Finished classic run logs retain at most 100 entries per account and 30 days. Running/interrupted runs, jobs, native catalog entries, deletion intents, credentials, rules and project contents are not pruned. Limits converge during background maintenance rather than imposing synchronous cleanup on each incoming event.

The worker opens a bare SQLite connection, never SyncStore: opening SyncStore would run startup recovery on active jobs. Maintenance stops before reset/quit. SQLite WAL high-water retention is limited when checkpoints can reset the WAL; temporary large transactions can still need more space. Freed database pages are reused. Fresh profiles enable incremental vacuum for gradual reclamation; existing databases are not subjected to a full blocking VACUUM on upgrade. A previously large SQLite file need not immediately shrink, and sync catalog data/profile backup snapshots remain separate from this journal policy. JSON diagnostic reports remain manual snapshots, not append-only logs.

The Journal page displays its history policy. Existing profile format/database schema version remain compatible; new indexes accelerate retention queries.

## MIX / failed initialization

A never-successfully-initialized native account with no catalog or pending deletion records can disconnect without downloading or scanning the project. It uses the existing native releaseEmpty ownership guard unchanged: foreign roots remain untouched; only an empty root actually owned by this connection can be released. The private application cache is archived for recovery before removing the account sign-in/rules. The confirmation explains this specific case. Registered accounts or accounts with known native items/pending operations cannot take this shortcut.

Selecting MIX → All files → Choose folder can retry failed initialization with a different empty folder, without signing out. Selecting MIX → Settings → Disconnect account · MIX removes only that account. Global Reset remains an all-account operation.

No native ownership/unregistration rule was weakened. Foreign registration and folder contents remain unchanged; another active account continues its current synchronization. A failed connection can leave pre-existing Shell metadata unchanged when ownership cannot be established; it is not automatically taken over or unregistered.

## Coverage

Unit tests use more than 100,000 events, boundary timestamps, multiple accounts, finished and unfinished classic runs, active jobs/deletion intents, bounded batches, and concurrent foreground writes during a real worker pass. Account recovery tests cover failed initialization and preservation of the other account.

`account-isolation-smoke.mjs --packaged` checks both switching MIX to a new folder and disconnecting MIX while a healthy Animagrad enumeration is held in progress. It verifies unchanged foreign registration/data, continued healthy sync and on-open hydration, and real packaged worker pruning. Fixtures use isolated workspace profiles and an owned disposable test registration, never a production account or another installed provider.
