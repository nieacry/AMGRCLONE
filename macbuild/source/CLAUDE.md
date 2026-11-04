# Project instructions: AMG rclone UI macOS port

Read the English handoff documents in the parent directory before editing. The active source baseline is 0.15.6. The Mac File Provider implementation is missing; the existing Windows C++ code is a behavior/reference implementation, not portable native code.

Preserve Windows compatibility and existing UK/EN localization. Product UI remains Ukrainian by default with an English switch; developer-facing handoff/build documentation is English. Do not rename original localized product assets simply to make source filenames English.

Use true NSFileProviderReplicatedExtension domains and actual native availability. No fake empty-file placeholders, no macFUSE substitute, no drive-letter or Maya features. Do not let a classic filesystem engine and File Provider manage the same domain concurrently.

Preserve credentials securely, namespace/account isolation, pending edits, partial cached data and durable recovery. Reset requires explicit confirmation and must not download the project or delete Dropbox files. Never interpret a canceled/failed remote listing as deletion authority.

Keep user data outside the application bundle and preserve it through upgrades. Do not import Windows encrypted profiles. Use isolated test profiles/domains and synthetic or explicitly authorized disposable cloud accounts. Do not commit secrets or run destructive tests against production data.

Check current Apple SDK documentation before selecting platform APIs/entitlements. If no Mac/signing access is available, complete independent implementation/automation and report the exact blocker. Do not fake a successful native integration or production signing result.

Existing scripts/package.json contain Windows-only assumptions. Add proper platform routing and Mac scripts; keep Windows archives immutable. Use a clearly separated Mac output location. Read ../MAC_BUILD_AND_SIGNING.md for the known build gaps.

Implement and validate the requested outcome; do not stop after describing an architecture. See ../CLAUDE_CODE_PROMPT.md for the complete task and ../ACCEPTANCE_TESTS.md for required evidence.
