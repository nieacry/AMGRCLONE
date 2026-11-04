# AMG rclone UI for Windows

1. Extract the entire ZIP to a permanent folder on your computer.
2. Run the outer **AMG rclone UI.exe**. Keep the **app** and **release** subfolders beside it.
3. Choose **Connect Dropbox** and sign in to the intended account in your browser. A Business sign-in shows that account's business folders; a personal sign-in shows that account's personal folders.
4. Choose a separate empty local NTFS folder. Files appear in Explorer as online-only and download when opened.
5. Choose **On this device** to keep a file or folder locally. Closing the window hides the app in the tray; choose **Quit** to exit.

The ZIP includes the application, Electron, rclone and the native provider. No separate Node.js, rclone, Visual C++ Runtime or Dropbox Desktop installation is needed. Internet access is required for Dropbox sign-in and file transfers.

Use a supported 64-bit Windows version with Cloud Files API and an NTFS local sync folder. Your profile lives in **Documents\AMGRCLONE**, separately from the EXE folder. For normal upgrades, see **UPDATING.en.md**; your profile and local files are preserved.

The initial file listing and placeholder preparation run in the background. Settings remain available; files already prepared can be opened in Explorer. The footer shows the current phase and item count. Cancel stops preparation; use Refresh files on demand to resume. On this device and Online only rules are also applied in the background.

Online-only files still show their full cloud size in Explorer and deletion dialogs. Check Size on disk for local usage. Deleting synchronized files can delete them from Dropbox; choose Online only to free local space instead.

Reset application requires confirmation and does not download the project. Downloaded files and local edits stay on disk; undownloaded placeholders are removed locally, without deleting Dropbox files. Partial downloads and unfinished local snapshots are preserved under Documents\AMGRCLONE\recovery. Normal updates do not require a reset.
