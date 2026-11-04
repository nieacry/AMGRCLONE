# 0.16.2 — Explorer deletions and Windows provider resilience

## Explorer operations

Explorer deletion/recycle/rename callbacks no longer wait behind an entire recursive listing or placeholder population. A priority operation aborts the current background pass and invalidates queued background work, then uses the same serialized mutation lane. It does not abort independent on-open fetches. Queued user operations remain ordered and cannot cancel one another. This avoids Cloud Files callback cancellation/timeouts during large-project work.

The latest validated metadata snapshot supplies the deletion baseline while placeholder population is incomplete. An acknowledged deletion can therefore include cloud children whose placeholders have not yet been created. The baseline is stored with the pending intent and is never expanded after the user deletes the folder.

If a later cloud check detects a new/changed/moved child, replacement folder identity, or a new local object at the old path, deletion is canceled. An atomic database transaction records the cancellation and removes only that intent. Existing catalog records remain for reconciliation. Missing local placeholders can be restored from Dropbox and unrelated synchronization continues; the canceled operation cannot block every subsequent pass forever. Network failures retain retryable deletion intents. No forced deletion or automatic acceptance of a changed cloud baseline was added. Existing intents created by older versions use their original item snapshots conservatively.

## Native I/O

Reproduced a real long-path failure on the previous helper. Native I/O uses extended Windows paths while ownership and callback comparisons retain ordinary absolute paths. Attribute lookup distinguishes truly missing files from access/other errors instead of treating every failure as absence. Creation retries accept an existing object only after verifying its exact placeholder identity; foreign objects remain protected. Native stages distinguish creation, inspection and ownership failures.

Placeholder updates use the real Win32 handle while retaining the protected exclusive oplock reference. A bounded invalid-handle retry reopens the file and rechecks ownership/sync state. Already-applied updates are accepted only with the expected identity, size and timestamp. Directory updates omit the file-only dehydration flag. This addresses reported update-handle failures but is not a claim of reproduction on the employee's Windows 10 build: local native tests run on the development Windows build.

Foreign root ownership remains protected. Initialization errors now identify the ownership check and the configured path and suggest choosing a separate empty folder. No existing provider is automatically unregistered or adopted.

## Verification

Unit coverage checks interrupted enumeration, independent hydration, simultaneous user operations, unchanged/new/modified cloud descendants, persistent baselines and cancellation of obsolete deletion intents. `recycle-smoke.mjs` uses the real Windows Recycle Bin and tests normal folder/file deletion, additions during a pending deletion, safe placeholder restoration and a new explicit deletion, deletion during stalled enumeration, permanent delete, orphan recovery and retry after restart.

`native-resilience-smoke.mjs` tests real NTFS placeholder paths longer than 350 characters, repeat creation/update, no hydration, rejection of foreign file identities and rejection of a different root owner without changing its registration. Packaged tests use isolated workspace fixtures. Production Dropbox contents and the supplied employee report are read only.

Profile format/SQLite schema are unchanged. Upgrade by quitting the old tray app and replacing its whole application folder; no settings reset is needed. Pending operations remain subject to validation in the new version.

API references: [Windows long paths](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation), [CfOpenFileWithOplock](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfopenfilewithoplock), [CfUpdatePlaceholder](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfupdateplaceholder).
