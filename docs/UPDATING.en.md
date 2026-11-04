# Updating AMG rclone UI for Windows

1. Wait for the current file transfer to finish.
2. Choose **Quit** from the app's icon near the Windows clock. The window close button only hides it. You can also use **Settings → Quit for update**.
3. Extract the new release ZIP to a separate folder. Keep the EXE and its `app` and `release` subfolders together.
4. Rename the previous application folder, for example to `AMG rclone UI.previous`. Put the new folder at its original path with its original name. Replace the whole folder; do not merge old and new DLLs.
5. Start the outer `AMG rclone UI.exe`. Check the version below the logo, the accounts and synchronization status.

Your profile lives in **Documents\AMGRCLONE** under your Windows user. Dropbox sign-ins, rules, local roots, history and owned drive mappings survive replacement of the application folder. Keep the profile and your local Dropbox folders. Do not use Reset app for a normal update.

The first 0.15.0 launch migrates the active profile from `%APPDATA%\cloudlane` if Documents does not already contain a profile. The old folder remains a backup. An existing destination profile is never overwritten. Old and new builds cannot synchronize concurrently.

Before first using a different version, the app creates a verified working-profile snapshot in `Documents\AMGRCLONE\profile-backups`. It includes encrypted sign-ins, a consistent SQLite backup including WAL data, and pending-operation state. Project files are not copied. This is private data for the same Windows user; do not include it in a shared release ZIP.

A profile snapshot is not a backup of the entire Dropbox account. Do not restore an old profile over active synchronization or run an arbitrary older build after a data-format change. For normal bug fixes, install the next corrected release using these steps. If a new build refuses to open the profile, preserve the files and error message; resetting is not recovery.

Keep a stable application-folder path so shortcuts continue working. On launch, the app refreshes its owned autostart entry to the current EXE. Copying a profile to another Windows user or computer is not a supported sign-in migration: Windows protects its credentials.
