# Delivery checklist

Return the complete updated source, not only a .app or binary patch.

- Swift host and replicated File Provider extension source, Xcode project/configuration, required manifests and entitlements.
- Electron/platform adapter and UK/EN UI changes with preserved Windows behavior.
- Safe shared-state/credential design, schema migrations and recovery/update behavior.
- Reproducible build, test and packaging scripts, with macOS CI configuration if used.
- Architecture-specific or universal self-contained employee artifacts, checksums and source/version manifest.
- Signing, provisioning, notarization and installation/update instructions in English; no private credentials in the delivery.
- Automated test results and real Finder test report against ACCEPTANCE_TESTS.md.
- Exact minimum macOS version, supported architectures, limitations and any remaining owner action.
- Windows regression results for shared-code changes, or a clear list of checks requiring a Windows machine.

Do not claim completion merely because Electron opens or an unsigned extension compiles. Distinguish implemented, compiled, signed, notarized, activated and functionally tested states.
