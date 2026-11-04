# Mac development, signing and packaging

## Developer prerequisites

A Mac or macOS build runner with Xcode and the macOS SDK, command-line tools, a compatible Node.js installation and npm. Node 24.x is the baseline development runtime used for the source's node:sqlite tests; Electron and other versions are recorded in package-lock.json. Development tools are not employee installation requirements.

Install dependencies natively on the Mac; do not copy Windows node_modules:

    cd source
    npm ci
    npm run build

These commands validate/install the existing frontend; they do not create a working native File Provider. Investigate platform dependency failures and update the lockfile deliberately if necessary. Existing npm start also expects a usable rclone setup and does not enable native online-only on Mac.

## Existing build gaps to fix

- package.json currently has Windows-specific extraResources for rclone.exe and amg-cloud.exe.
- electronDist, launcher paths, release staging, native compilation and several scripts assume a Windows distribution.
- npm run build:native uses PowerShell/MSVC. Do not run it as a Mac build step.
- npm run release:stage / release:publish implement Windows x64 layout and archive handling. Do not use them to overwrite Windows publish or archived versions from a Mac job.
- scripts/preview.cjs provides a frontend-only preview; it is not evidence that native sync works.
- Existing Windows native tests depend on NTFS, CldApi, subst, PowerShell and the Windows rclone binary. They are references for behavior, not a Mac test suite.
- Some npm test cases launch rclone from .runtime/tools/rclone.exe or create Windows junctions. Separate portable contract tests from platform tests; do not call all tests passed by silently skipping required Mac functionality.
- No Swift target, extension Info.plist, entitlements, App Group, native bridge, Apple signing identity or macOS test fixture is supplied.

## Native build requirements

Create reproducible Xcode targets and command-line scripts for the host/extension, respecting the chosen deployment target. Add the required extension declaration, domain handling, sandbox permissions, App Group and Keychain sharing configuration. Verify whether the distribution method needs provisioning profiles or additional capabilities. Build every native dependency and bundled rclone for each supported architecture. Use a pinned official rclone distribution with checksum verification; do not use the Windows executable.

Keep Apple Team ID, bundle identifiers, group identifiers and signing configuration centralized and documented. Obtain genuine identifiers/certificates from the owner; do not invent working credentials. Private keys, API tokens and notarization secrets must not be committed or pasted into Claude conversations. Prefer configured Keychain/CI secret access.

Sign nested components in the appropriate order, apply Hardened Runtime/entitlements compatible with Electron and the extension, then sign/notarize the final distribution and staple as required. Verify with the current Apple-supported tooling. Do not use ad-hoc signing or testing-mode entitlements as evidence of a production-ready distribution. Keep debug and employee-distribution configurations separate.

Provide commands/scripts for build, unit tests, native integration tests, packaging, signature validation and notarization. The expected goal is an installable .app plus ZIP and/or DMG containing all necessary runtime components. A successful .app build alone is not proof the extension is registered, enabled or functional.

## Without a local Mac

A macOS CI runner can build and perform appropriate automated checks, with signing secrets supplied securely. Real Finder/application-open, user approval and system lifecycle scenarios still need a Mac test session. Report compiled, signed, notarized and functionally verified as separate outcomes. If credentials/hardware block the final step, complete the code and build automation and list the exact remaining requirements honestly.

## Output layout

Keep Mac products separate. In a shared Windows/Mac workspace use macos/publish/ and versions/macos/<version>/; in an isolated Mac-only checkout its own publish/ and versions/ may be used. Do not add Mac products inside the existing Windows publish root. Never replace existing Windows publish or immutable Windows archives. Choose the next unused version from the actual repository state; 0.15.6 is only this handoff's baseline. Include SHA-256 checksums, source provenance and English build/update notes. Normal updates must retain the Mac profile, domains and cached contents.
