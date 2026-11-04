# Acceptance tests

Use isolated profiles, domains and disposable Dropbox accounts. Obtain explicit permission before touching production data. Never use the owner's Documents\AMGRCLONE Windows profile or encrypted vault for testing. Record macOS version, hardware architecture, Xcode version, application version, signing configuration and exact results.

## Finder and storage

- New account/domain: list a nested hierarchy without downloading all contents. Test pagination and a large synthetic tree.
- Open an online-only file from Finder with Preview and another application: only needed contents are fetched, the file becomes cached, and the desired inherited rule remains unchanged.
- Verify cached content across app/system restarts, offline access for downloaded files and truthful failure for unavailable content.
- Test keep-downloaded and free-space behavior with actual native state; do not infer pinning merely from a completed download.
- Check folder mixed/empty states and compact rows both with and without the details panel, in UK and EN.
- Verify system-provided Finder availability/progress presentation where supported. Do not fake overlays in the app as proof of Finder integration.

## Synchronization and safety

- Create, edit, atomic-save, rename, move and delete files/folders, both locally and remotely.
- Verify conditional updates and stable IDs, interrupted uploads/downloads, concurrent local/remote edits, collision handling and preservation of both sides on conflict.
- A canceled or failed listing never deletes unmatched local or remote items. Unknown identities and unsupported names fail safely.
- Personal and Business accounts expose only their authenticated spaces; multiple domains never share state or credentials accidentally.
- During enumeration and transfers, open settings, save startup preferences, dismiss settings, browse and open already available files. Verify cancellation actually stops metadata/content work and safe restart resumes it.
- Test sleep/wake, network loss/reconnect, credential expiration/refresh, extension process restart and GUI lifecycle.

## Reset

- Reset opens an explanation and requires explicit consent. Cancel causes no account/settings/data change.
- With the cloud unavailable, reset still preserves fully downloaded, pinned, locally edited, local-only and zero-byte files without fetching online content.
- Use an online-only item with a very large logical size; prove reset does not fetch its contents.
- Preserve downloaded ranges of an incomplete file with enough metadata for recovery; do not present holes as a complete document.
- Confirm no Dropbox upload/delete/list/download is issued as a side effect of reset. Removing local placeholders must not become remote deletion.
- Test interrupted reset, busy files, unknown items, failed recovery writes and retry after restart. No destructive operation may proceed without verified preservation.
- Remove only this app's domains/resources. Never detach unrelated providers or erase foreign files.

## Packaging and upgrades

- Test the actual packaged application on every claimed architecture; validate signature, extension registration and notarization independently of debug builds.
- Launch without developer tools, external Node/rclone installations or third-party filesystem drivers.
- Replace/move the application as documented; retain sign-in, domain identity, profile, rules, journal and downloaded files. No reset or blanket redownload should be required.
- Verify a second application copy does not create competing sync engines or duplicate domains for the same profile.

Deliver logs without credentials, reproducible automated checks, and a short manual test report. Label untested scenarios explicitly.
