# 0.16.5 — skip unsupported Windows names

The Windows native provider skips selected Dropbox paths with prohibited Windows characters, reserved device names, trailing dots/spaces or a path component longer than 255 UTF-16 code units. An unsupported parent makes its descendants unsupported too. Other representable files continue syncing and creating genuine online-only Cloud Files placeholders. Cloud objects are never renamed or deleted to work around their names.

Each skipped path has its exact name and reason in file history, with a separate **Skipped / Пропущено** filter. Repeated complete scans do not repeat unchanged skip events in the same provider session. After restarting, a fresh scan can record the paths again; normal 30-day / 100,000-events-per-account history retention still applies. The current skip count is rebuilt from a complete successful snapshot. A corrected cloud name is eligible on the next complete refresh.

An amber notice links to the skipped history. The tray and history summary say **Synchronized with skipped items**, rather than claiming complete synchronization. The last successful-check time refers to supported selected files. Reports include the current skip count and at most 100 recent skipped paths per account, in addition to the existing bounded error list; credentials and file contents remain excluded.

Safety constraints:

- An incomplete or failed listing cannot replace exclusions or authorize local removals.
- Tracked local counterparts of a cloud item renamed to an unsupported name, including descendants and parent directories, remain preserved. Their old names are not uploaded or removed by later scans while excluded.
- A folder containing skipped cloud paths cannot be deleted through the synchronized Explorer deletion flow; the user receives a specific preservation message.
- Case/normalization collisions, unsafe remote paths, transport failures, access failures and generic Cloud Files errors remain errors. They are not treated as unsupported-file skips.
- This behavior applies to Windows native synchronization. It does not change classic rclone bisync or implement macOS File Provider.

Validation covers supported siblings alongside unsupported names and descendants, Windows component lengths/control characters, cloud rename protection, exclusion recovery after failed pagination, correction of cloud names, repeat-scan journal deduplication, skipped history/diagnostic limits, and tray warning priority. Existing large-catalog and deletion/conflict tests continue protecting complete snapshots and cloud data.

The diagnostics integration scenario uses an isolated profile, mock Dropbox HTTP responses and the real bundled Windows provider. It verifies actual placeholder creation and successful on-open hydration of a supported file while unsupported names are skipped, preservation of name-collision errors, persisted history after restart, and Ukrainian/English report export while a later listing is stalled. Portable release hashes and the bundled source snapshot are verified before publication.

No profile schema change is required (database schema 5). Update through Quit in the tray menu and replacement of the whole application folder; do not reset settings.
