# Sending a diagnostic report

1. Update to 0.16.1 or later using the normal whole-folder update procedure. Quit the previous app through its tray menu first. Keep your profile and local Dropbox folder; do not reset settings.
2. Open the affected account and click **Refresh files on demand**. Wait for the error to appear again. Earlier generic errors cannot retrospectively reveal a path that was never recorded.
3. Open **Settings → Save diagnostics**, click the button and choose where to save the JSON report.
4. Send that report to your administrator/developer. The app does not send it automatically.

The report includes the app and OS versions, account names, provider status and up to 100 recent failed events and 100 recently skipped paths per account. New name-mapping errors include the exact Dropbox-relative path and reason; name collisions include both paths. Report explanations are in English regardless of the interface language. It excludes sign-in credentials, OAuth tokens, cookies, file contents and the full Dropbox catalog.

Saving the report works while background sync is active. It does not download the project or rename, delete or upload Dropbox files. Names and paths are preserved as text in JSON, including trailing spaces. There is no need to send vault.bin, your entire profile folder or project files.

Starting with 0.16.5, names Windows cannot represent are skipped while supported files continue synchronizing. The amber notice links to the Skipped history filter. Files and folders are never renamed automatically; the Dropbox originals remain. Rename the affected cloud item to a valid name to include it on the next complete refresh. A folder with skipped descendants cannot be deleted through synchronization, to protect unseen cloud files. Network errors, identity conflicts and case/normalization collisions are not ignored.
