# Перевірка 0.14.2 · 01.11.2026

## Зміни

Windows: перший вибір локального порожнього NTFS-кореня автоматично реєструє native provider. Перше ввімкнення вибирає весь поточний Dropbox scope online-only через кореневе успадковане правило. Старі звичайні акаунти не перемикаються без користувацької дії.

Коли native provider працює, його старі bisync jobs незворотно позначаються retired перед очисткою службових access markers. Видаляються лише точні власні імена з БД зі збігом вмісту/розміру; віддалене видалення умовне за Dropbox revision. Змінені або чужі файли пропускаються. Квитанції та помилки — локальна SQLite schema 4. Старі версії, що підтримують лише schema 3, відмовляться читати нову базу замість її пошкодження.

UI: прибрано позначені на наданій картинці мовний glyph, eyebrow/головний заголовок файлів та повторні версії внизу sidebar; номер біля логотипа збережено. Шрифти збільшено. Налаштування зберігаються оптимістично без зміни висоти модального вікна, постійне місце під статус і захист від застарілої polling-відповіді.

Native helper: StorageProviderSyncRootManager, per-user/owner ID, pin state папок і повідомлення SHChangeNotify; системні shell properties підтвердили online=1, pinned=3, pending=4. Візуально перевірено Проводник: хмаринка біля online-only файла й папки, зелена галочка локального файла та сині стрілки pending upload у режимі великих іконок. Положення значка визначає Windows, власний legacy icon-overlay extension не встановлюється.

Reset: підтвердження, припинення фонового upload, повне завантаження всіх відомих власних placeholders перед будь-яким revert, перетворення у звичайні файли та unregister тільки власних roots. Звичайні/dirty локальні файли зберігаються. Чужі reparse points і невідомі placeholders блокують відключення. Потім від’єднуються власні subst, вимикається login startup, очищаються cookies/storage/cache, credentials/settings та службові таблиці. Помилка гідратації зупиняє процес до очистки входів; повторний reset підтримується.

## Перевірки

- 42 unit/integration tests, включаючи реальний rclone alias bisync та 5 нових сценаріїв cleanup/reset metadata.
- native smoke з перевіркою shellRegistered, hydration, pin/unpin, dirty guard і provider CRUD/conflicts.
- UI smoke обома мовами й компактне компонування.
- onboarding-smoke: автоматичний native root, усі папки online-only без скачування вмісту, точна очистка власного маркера зі збереженням чужого, незмінні bounds діалогу під час checkbox save, відмова reset без підтвердження, відмова при недоступній ревізії без втрати входів, успішний повторний reset зі збереженням cloud bytes і unsent local file, unregister roots, власні drives, cookies/localStorage і preferences.
- packaged smoke та onboarding --packaged перевіряють ті самі сценарії на самодостатній збірці.

Межі: багатоклієнтна одночасна робота ще не пройшла наскрізних випробувань. Нативний Dropbox транспорт потребує подальших випробувань робочих редакторів/мережі; macOS File Provider відсутній. Кнопка reset не очищає cookies стороннього браузера. Чужі markers не прибираються глобальним пошуком.

Джерела для Windows API: [Cloud Files Shell integration](https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine), [CfRevertPlaceholder](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfrevertplaceholder), [CfUnregisterSyncRoot](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfunregistersyncroot). Остання функція може видаляти неповні placeholders, тому reset попередньо завантажує та явно перетворює їх у звичайні файли.
