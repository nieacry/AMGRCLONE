# Architecture and source map

## Baseline facts

The source baseline is 0.15.6. Electron main process coordinates React, the encrypted profile, SQLite, rclone OAuth, desktop integration and the Windows provider. Native file contents use direct Dropbox HTTP APIs for stable-ID/revision-aware reads and conditional writes. rclone remains useful for OAuth and classic synchronization. The current native helper is C++ Windows Cloud Files API; there is no native macOS implementation.

Important files:

| File or directory | Responsibility |
| --- | --- |
| source/src/App.tsx, style.css | UI, settings, confirmation, tree, storage state, activity history |
| source/src/types.ts, demo.ts | UI bridge contracts and preview data |
| source/core/i18n.mjs | Ukrainian and English product strings |
| source/electron/main.mjs | IPC validation, profile, auth, account namespace, synchronization orchestration |
| source/electron/preload.cjs | Restricted renderer bridge |
| source/electron/desktop.mjs | Startup, tray/menu and last-sync presentation |
| source/core/dropbox-transport.mjs | Dropbox REST contract, pagination, ranges, revision checks; LocalTransport for isolated tests |
| source/core/account-root.mjs | Authenticated personal/business namespace selection |
| source/core/native-provider.mjs | Windows native orchestration, cancellation, local catalog and background scheduling |
| source/core/native-host.mjs | Private JSON-lines Windows helper connection |
| source/core/native-availability.mjs | Actual storage state and folder aggregation |
| source/core/native-deletions.mjs | Durable Windows delete/recycle lifecycle |
| source/core/account-recovery.mjs | Recovery metadata and retained cached bytes |
| source/core/profile.mjs, store.mjs | Profile migration/backups, schema checks, SQLite persistence |
| source/core/sync-engine.mjs, policy.mjs | Classic bisync safeguards and inherited selection rules |
| source/core/drives.mjs, subst-drives.mjs | Windows-owned subst mappings; exclude from Mac features |
| source/native/windows/ | Windows provider and outer launcher; reference implementation only |
| source/scripts/ | Existing build, packaging and isolated verification scripts |
| source/tests/ | Unit/integration fixtures and contract tests |

## Proposed Mac boundaries

Add a native Swift host/management target and a replicated File Provider extension, preferably under native/macos with a reproducible Xcode project and shared build configuration. Embed the extension inside the signed application bundle. Register one stable NSFileProviderDomain per account.

Implement stable item identifiers, enumeration pages, working-set/change enumeration, sync anchors, fetchContents, and create/modify/delete operations. Preserve Dropbox ID, namespace and revision separately from the displayed path. Keep durable intent and conflict state. A failed or canceled listing must never become a mass-delete snapshot.

Define a platform provider interface at the Electron boundary rather than making React depend on Windows helper commands. Reuse policy, account semantics and UI contracts where possible. Do not run bisync or the Windows-style filesystem scanner over File Provider domains at the same time as the extension.

Choose a secure extension transport architecture deliberately. Direct Dropbox networking from the extension is acceptable. If a helper or IPC broker is needed, document launch, availability and authentication when the GUI is hidden, quit, restarted or upgraded. Do not depend accidentally on an open Electron window. Use Keychain access groups and App Groups where appropriate; never pass secrets through renderer IPC or logs. Define a safe token-refresh owner and coordinated access to shared metadata. Do not blindly share a writable SQLite file across processes without a concurrency design.

The extension's sandbox and File Provider-managed storage are distinct from the user-visible Documents settings folder. Make that separation explicit; do not pretend the extension has unrestricted access to arbitrary paths.

## Existing safety invariants

- Stable per-account identity and namespace; no cross-account merging.
- No automatic destructive resync or silent overwrite winner.
- Clean/revision checks before freeing downloaded contents.
- Partial/canceled enumeration cannot authorize remote deletions.
- Explicit reset consent; no project hydration during reset; retain local-only edits and recoverable partial bytes.
- Cancellation aborts metadata pagination and content transfers and invalidates already queued work safely.
- Profile backups and migration guards protect existing users during updates.
- Windows subst deletion is restricted to app-owned mappings and exact targets; do not weaken this while refactoring.

## Baseline verification and known limits

73 unit/integration checks passed on Windows for the baseline. Windows packaged tests covered real NTFS placeholders, on-open hydration, cached/pinned states, compact empty-folder rows, background responsiveness, confirmation and offline reset, partial-data recovery, missing-root recovery and portable ZIP startup after an application-folder move. A 100 GiB placeholder was used to verify zero-download reset; this was not a real 100 GiB account benchmark. No macOS File Provider/Finder tests have been performed.

The Dropbox recursive-list transport currently has a protective 100,000-entry limit per selected root. Do not silently remove the guard or confuse a limit/network error with an empty account. Large-tree scalability, incremental Dropbox cursors and true Mac lifecycle testing need explicit treatment.

## Authoritative API starting points

- https://developer.apple.com/documentation/fileprovider
- https://developer.apple.com/documentation/fileprovider/replicated-file-provider-extension
- https://developer.apple.com/documentation/fileprovider/nsfileproviderreplicatedextension
- https://developer.apple.com/documentation/fileprovider/synchronizing-the-file-provider-extension
- https://developer.apple.com/documentation/xcode/accessing-app-group-containers
- https://www.dropbox.com/developers/documentation/http/documentation
- https://www.dropbox.com/developers/reference/content-hash

Verify current SDK documentation and availability before choosing APIs or entitlements. These links are starting points, not a substitute for checking the target SDK.
