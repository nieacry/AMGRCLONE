# Перевірка 0.14.0 · 01.11.2026

Windows build 26100, Node 24.11.0, rclone 1.75.2, Electron 45.2.1; MSVC 2022 і Windows SDK 10.0.26100.0.

## Підтверджені автоматичні перевірки

- `npm run build`: TypeScript і production Vite build.
- `npm test`: 37/37. Політики/успадкування, UK/EN parity, SQLite, одноразові плани, реальний rclone alias bisync (initial merge, backups, incremental changes, deletes, conflicts, stale plan і recovery), заборона OS cloud root, стани трея, нумерація й перевірка власності subst.
- `npm run test:native`: справжня реєстрація Windows sync root, placeholder з 0 resident bytes, читання зовнішнім процесом, CfExecute, pin/unpin, заборона dirty dehydration, upload/new files/new folders, revision update, rename/delete, reconnect і збереження обох сторін при конфлікті. Власні порожні тестові roots unregister після завершення.
- `npm run test:subst`: справжній subst.exe з українським шляхом; незмінність абсолютного кореня та правил; відмова довільному/system ID; чужа підміна букви зберігається; restore не перехоплює букву; subst /D знімає власну прив’язку без видалення файлів.

## Перевірка UI і готової збірки

**Пройдено:** `npm run test:ui` та `npm run test:packaged`. Вони створюють ізольовані профілі, перевіряють дерево, українську за замовчуванням/англійську, збереження налаштувань, компактний layout і перенесення alias через rclone.

Packaged сценарій перевіряє наявність rclone/helper, створення subst із дерева звичайної локальної копії без зміни правил, захист account ownership, справжні placeholders і читання файла, pin/unpin, native-підпапку як диск, заборону стороннього ID, хрестик → трей, налаштування автозапуску без реальної зміни Windows login settings у тестовому профілі, збереження subst після виходу, прихований restart, відновлення й видалення тільки власного диска.

Скриншоти зберігаються в `test-results/`. Під час release:stage створюється source.zip без .runtime, node_modules і користувацьких секретів та SHA-256 manifest усіх файлів. Перед publish хеші перевіряються повторно.

## Практичні межі

Нативні сценарії використовують реальний Windows Cloud Files API з локальним тестовим транспортом; Dropbox HTTP-контракти перевірені mocked fetch. Користувацький Dropbox не змінювався. Наскрізна перевірка нового native transport на справжньому Dropbox, Office/Adobe atomic-save, повноцінне offline/reconnect і macOS ще не виконані. macOS File Provider не реалізовано.

Попередні VERIFICATION.md і VERIFICATION-0.2.md — історичні записи; поточні можливості та обмеження описані в README й ARCHITECTURE.md.
