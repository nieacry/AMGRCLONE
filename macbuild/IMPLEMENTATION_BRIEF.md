# Implementation brief

## Objective

Deliver a self-contained macOS desktop Dropbox client with genuine online-only files in Finder, based on the existing Electron/React application. This requires a native File Provider implementation, not just an Electron rebuild.

## Required product behavior

- Ukrainian is the default UI language; English is selectable and persisted. Keep the compact dark interface, logo, account isolation, and separate Name / State / Rule / Size columns. Empty folders must remain normal compact rows (36 px reference height).
- Browser-based Dropbox OAuth; multiple isolated accounts. Business sign-ins expose the authenticated business namespace; personal sign-ins expose their personal namespace. Do not merge different accounts or add a manual personal/business namespace switch.
- The application shows the complete remote hierarchy with checkboxes and per-folder/per-file storage rules. Selection and availability are inherited from ancestors with explicit child overrides.
- File Provider presents selected content in Finder as real dataless items. Opening a file in Preview, Maya, a media viewer or another application downloads the requested content through the provider.
- Distinguish actual availability from the desired rule: Online only, Downloaded to cache, Pinned locally. Cached does not mean permanently pinned. Folder state may be mixed. Report unknown, pending, errors and conflicts honestly.
- Use supported native APIs for download, keep-downloaded behavior and eviction on the chosen deployment target. Confirm their exact semantics; a download request alone must not be presented as guaranteed pinning.
- Two-way updates: create, modify, rename, move and delete with revision-aware conflict protection. Do not silently choose a conflict winner or overwrite unsent content.
- Large-project enumeration and synchronization run in the background. Settings remain editable and dismissible. Already available Finder files remain usable while other items are being prepared. Show real progress, support cancellation, and resume safely after restart or network failure.
- Provide startup-at-login, start minimized/hidden, menu-bar access, and clear synchronization status including the last successful synchronization time, adapted to macOS conventions.
- Keep per-file activity history with operation, path, time, direction and result. Do not log tokens.

## Local root and macOS integration

Respect File Provider-managed locations and supported domain APIs. Do not promise arbitrary Windows-style local root placement if the selected macOS API does not support it. Display the actual location and provide Open in Finder. Explain any product-visible difference in English documentation and UK/EN UI.

Do not implement drive letters, subst substitutes, artificial disk mounting, or Maya path-remapping features. The owner explicitly excluded those additions for macOS.

## Reset and updates

Reset requires a dedicated confirmation dialog and explicit consent. Cancel must leave the account and settings intact. Reset must not download the project. Keep fully downloaded files and unsent local edits. Remove undownloaded local placeholders without deleting Dropbox content. Preserve partial local data and pending snapshots for recovery. Audit File Provider domain-removal semantics before implementing this; do not assume removal preserves materialized data or permits a Windows-style algorithm. If preservation cannot be guaranteed, stop before destructive changes and report what remains.

Ordinary application updates must preserve settings, sign-ins, domains, stable item IDs, rules, history and local data; they must not require reset. Keep profile data separate from the application bundle. The Windows profile is Documents\AMGRCLONE. Design the Mac profile/App Group arrangement explicitly, keeping a user-visible settings/recovery location where appropriate without breaking sandbox access. Use Keychain for credentials.

## Distribution

Employees should receive an application distribution they can install and run without Node.js, Xcode, rclone, macFUSE or other separately installed developer components. Embed all required architecture-compatible components and the signed File Provider extension. Obtain any system approval through normal macOS mechanisms. Never instruct users to disable SIP or Gatekeeper.

Build and document arm64 and x86_64 support, or deliver a verified universal application. State the minimum supported macOS version based on actual API availability. Do not claim hardware or OS combinations that were not tested.
