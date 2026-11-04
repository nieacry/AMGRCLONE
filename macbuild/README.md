# AMG rclone UI: macOS development handoff

Baseline: Windows release **0.15.6**, prepared 2026-11-02. This is a source and implementation handoff, **not a working macOS release**. No Swift File Provider target exists yet.

## Start here

1. Copy this entire folder to a Mac. The Windows D: path is historical context, not a path to reproduce on macOS.
2. Read `IMPLEMENTATION_BRIEF.md`, `ARCHITECTURE.md`, and `MAC_BUILD_AND_SIGNING.md`.
3. Open a terminal in `source`, install development dependencies as described in `MAC_BUILD_AND_SIGNING.md`, and run Claude Code there. Its project instructions are in `source/CLAUDE.md`.
4. Paste `CLAUDE_CODE_PROMPT.md` into Claude Code to start implementation.
5. Use `ACCEPTANCE_TESTS.md` for real Finder verification and `DELIVERY_CHECKLIST.md` before handing a build back.

## Contents

- `source/`: application code, React assets, package lock, existing Windows native implementation, scripts and tests.
- `CLAUDE_CODE_PROMPT.md`: ready-to-use task for Claude Code.
- `IMPLEMENTATION_BRIEF.md`: agreed product behavior and boundaries.
- `ARCHITECTURE.md`: current architecture and proposed macOS integration boundaries.
- `MAC_BUILD_AND_SIGNING.md`: developer setup, build gaps, signing and packaging requirements.
- `ACCEPTANCE_TESTS.md`: required tests and data-safety checks.
- `DELIVERY_CHECKLIST.md`: expected programmer deliverables.
- `BASELINE.json`, `SHA256SUMS.txt`: provenance and integrity information.

All developer handoff instructions are English. Ukrainian strings in the source and `source/docs/*.uk.md` are intentional product localization, required by the existing application and Windows packaging. The two original Windows launcher filenames are retained because existing release tooling references them. They are not Mac entry points. Historical Ukrainian/Russian planning documents and the old root README were replaced with this current English handoff; no application code was translated or rewritten.

## Privacy and scope

This handoff contains no user profile, Dropbox credentials, Windows encrypted vault, SQLite user database, native cache, test runtime directories, installed node_modules or compiled Windows release. Test sources contain synthetic fixtures only. Real sign-ins must be created separately on the Mac. Never transfer a Windows vault.bin to macOS; its Windows-protected credentials are not a portable login format.

The included company logo is an existing product asset. Keep its intended use in this application.
