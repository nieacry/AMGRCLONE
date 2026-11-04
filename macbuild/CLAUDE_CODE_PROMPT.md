Implement the macOS port of AMG rclone UI with genuine native online-only files in Finder. Work in the supplied source directory. The baseline is Windows 0.15.6; this is not yet a working Mac File Provider app.

Read ../README.md, ../IMPLEMENTATION_BRIEF.md, ../ARCHITECTURE.md, ../MAC_BUILD_AND_SIGNING.md, ../ACCEPTANCE_TESTS.md and ../DELIVERY_CHECKLIST.md, then inspect the real code. Follow source/CLAUDE.md. Preserve the existing Windows implementation.

Do not stop at a plan or an Electron-only rebuild. Implement a Swift NSFileProviderReplicatedExtension, account-isolated stable domains, enumeration and change anchors, on-demand contents, two-way revision-safe mutations, actual availability reporting and a secure host/extension bridge. Keep the current compact React UI, Ukrainian default and English switch, authenticated Business/Personal namespace semantics, multiple accounts, per-item rules, history, startup and menu-bar behavior.

Use current Apple SDK documentation to choose supported APIs, deployment target, entitlements, App Groups/Keychain sharing and registration behavior. Honor File Provider-managed locations. Do not implement disk letters, subst replacements, macFUSE mounts or Maya integration. Do not run bisync over File Provider-managed domains or simulate placeholders using ordinary empty files.

Make enumeration and transfers background operations. Settings remain usable/dismissible and already prepared Finder files remain openable. Handle cancellation, offline operation, credential refresh, restart, sleep/wake and the extension's independent lifecycle. Protect pending edits and do not treat incomplete listings as deletion snapshots.

Reset must require explicit confirmation and must not download the project. Preserve downloaded files, local edits and recoverable partial data. Removing local placeholders or a domain must never delete Dropbox content. Verify native domain-removal semantics before using them. Updates retain profiles, domain identity and local content without reset.

Produce a self-contained Mac distribution for the supported architectures, including an appropriate rclone binary and the extension, without requiring employees to install developer tools or filesystem drivers. Add reproducible native builds, tests, packaging and signing/notarization configuration. Use genuine owner-provided signing configuration securely; never invent certificates or put credentials into source or conversation logs.

Work autonomously on authorized implementation and tests. Ask only for missing decisions or external credentials/hardware that truly block a dependent step, while completing independent work. Build on macOS/Xcode locally or with a macOS runner. Do not label Windows/Linux-only checks or an unsigned compilation as a functional Mac release.

Verify the actual packaged app with real Finder open/download, cached/pinned/eviction states, edits, conflicts, rename/delete, multiple domains, offline/restart, responsive settings, safe no-download reset and app replacement. Return the updated source, artifacts/checksums, exact build commands, real results, limitations and remaining owner actions. Never overwrite Windows release archives or the Windows publish folder.
