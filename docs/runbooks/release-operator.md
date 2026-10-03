# Ручной закрытый выпуск и восстановление фиксации

Для отдельно включённого владельцем автоматического режима см.
[обновление из main](automatic-main-deployment.md). Ниже описан ручной режим;
его утверждения об отсутствии автоматической установки относятся к нему.

Статус: операторский интерфейс проверяется на disposable Linux/Docker. Этот PR
**не разрешает выпуск на Cloud.ru**, не публикует образы и не открывает пилот.
Слияние в main само по себе не устанавливает новую версию.

`deploy/backup/control.py` связывает уже существующие selection → preparation →
migration → start/health → finish в одном процессе. Отдельные approval-файлы
остаются обязательными: CLI не создаёт их за оператора и не считает проверки CI
разрешением мигрировать живую БД. Выпуск всегда закрытый: ingress 503, Worker
paused, restart=no. По умолчанию AI disabled; отдельно согласованный
[RouterAI-профиль](routerai-deployment-profile.md) требует startup approval v2
и не включает денежный бюджет, бонусы или публичный доступ.
Никаких hooks, произвольных команд, URL
скачивания или подменяемых transport-классов в JSON-запросе нет.

## Предварительные условия

- Linux, Python 3.11+ (сервер Ubuntu 24.04/Python 3.12), Docker/Compose, age,
  прежние backup/S3/TLS prerequisites. Не запускать из Windows.
- Один оператор, канонический защищённый config вне state, неизменяемая отдельно
  проверенная установленная версия контроллера. Не импортировать Python из
  присланного bundle. Bundle содержит данные для проверки, не команды исполнения.
- Локально уже загружены и проверены точные current/target образы, PG17 неизменен.
  CLI ничего не скачивает, не публикует в GHCR и не меняет DNS/сертификаты.
- Отдельные разрешения preparation, migration, startup, finish; проверенная
  совместимость миграций и план реагирования. Recovery ниже **не является откатом
  БД** и не доказывает совместимость произвольной версии.
- Нет конфликтующего обслуживания. Расписания не включать этим шагом.
- При повторном выпуске отдельно сверить сохранённые jobs прежних версий и при
  необходимости использовать preparation approval v2 с точными `retained_jobs`;
  схема и ограничения — [release-target.md](release-target.md). Не удалять старые
  контейнеры и не подменять current images, чтобы обойти отказ inventory.

## Защищённый запрос

JSON ниже — шаблон путей, не готовое разрешение. Заменить placeholders на
проверенные абсолютные пути и полный SHA; хранить файл вне обоих bundles,
в private каталоге оператора, mode 0600. Секретные **значения** в нём запрещены:
только пути. Все пути различны, без `..`, `$`, переводов строк и symlink.

```json
{
  "version": 1,
  "config_path": "/etc/citygo/backup.json",
  "target_sha": "<40 hex characters>",
  "origin": "https://<approved-hostname>",
  "ingress_directory": "/etc/citygo/ingress",
  "current_bundle": "/opt/citygo/releases/<current-release>",
  "target_bundle": "/opt/citygo/releases/<target-release>",
  "preparation_approval": "/etc/citygo/approvals/preparation.json",
  "migration_approval": "/etc/citygo/approvals/migration.json",
  "startup_approval": "/etc/citygo/approvals/startup.json",
  "finish_approval": "/etc/citygo/approvals/finish.json",
  "migration_secret": "/etc/citygo/secrets/migrate.json",
  "api_secret": "/etc/citygo/secrets/api.json",
  "worker_secret": "/etc/citygo/secrets/worker.json",
  "backup_secret": "/etc/citygo/secrets/db_backup_password"
}
```

Не менять файлы во время исполнения. Отзывать разрешение нужно удалением
конкретного approval, а не изменением JSON-запроса. Сам request — перечень входов,
не право на выполнение; каждый изменяющий этап повторно проверяет approvals.

## План → проверка → явное выполнение

Примеры предполагают отдельно проверенную установку в `/opt/citygo/controller`.
На рабочем сервере выполняются только после согласования конкретной версии.

1. Получить bindings для независимого finish approval:

   ```sh
   python3 -E -s /opt/citygo/controller/control.py plan --request /etc/citygo/release-request.json
   ```

   `planned-not-approved` выдаёт hashes канонического config, generation и startup
   approval, но **не проверяет live runtime** (`runtime_checked:false`) и не
   разрешает downtime. Первые три approvals уже должны быть действующими.
   Finish approval ещё может отсутствовать; его точная схема —
   [release-finish.md](release-finish.md).

2. После независимой проверки/создания finish approval:

   ```sh
   python3 -E -s /opt/citygo/controller/control.py verify --request /etc/citygo/release-request.json
   ```

   `verified-not-deployed` означает только проверку локальных входов/образов и
   срока разрешений. Plan/verify берут maintenance lock (могут создать lock-файл),
   но не останавливают контейнеры, не меняют config, pending, Worker или ingress.
   Полные runtime/drain/backup/health gates выполняются в apply.

3. Только по разрешению пользователя на конкретный закрытый выпуск:

   ```sh
   python3 -E -s /opt/citygo/controller/control.py apply \
     --request /etc/citygo/release-request.json \
     --allow-stop --allow-upload --allow-migration --allow-start --allow-finish
   ```

   Требуются **все пять** flags и все четыре независимых approval. Есть downtime,
   предрелизная зашифрованная копия с S3 upload, однократные DDL и замена API/Web.
   Только после health и durable config/active удаляется pending. Результат
   `closed-release-committed` не разрешает traffic/Worker/restart.

При любой ошибке не повторять apply автоматически и не удалять pending вручную.
CLI печатает только безопасный код ошибки, не аргументы, секреты или traceback.
Сигнал завершения оставляет fail-closed состояние; SIGKILL/power loss требуют
осмотра. Нельзя считать отсутствие вывода доказательством отсутствия COMMIT.

## Узкое восстановление: только завершить уже выполненную фиксацию

Поддерживается **только** прерывание после записи новых config + generation +
active-release, но до удаления pending. Все исходные approvals, bundles,
контейнеры, секреты и исторические файлы должны сохраниться.

1. С тем же request выполнить `inspect-recovery`:

   ```sh
   python3 -E -s /opt/citygo/controller/control.py inspect-recovery --request /etc/citygo/release-request.json
   ```

   Под обоими locks проверяются точный pending/op, цепочка hashes approvals,
   manifests/images, история миграций/result, generation и config; неизменные
   процессы PG, завершённых jobs, мигратора, новых API/Web; сети, TLS maintenance
   и readiness/контракт. Лишний/пропавший контейнер, restart, изменённый секрет,
   недостающий receipt или открытый Worker/ingress приводят к отказу. Проверка
   ничего сама не закрывает и не исправляет.

2. Независимо проверить отчёт `closed-commit-eligible-not-approved`. Создать
   **новый** отдельный private approval вне state/bundles/request paths:

   ```json
   {
     "version": 1,
     "purpose": "citygo-recovery-closed-commit",
     "config_path": "/etc/citygo/backup.json",
     "operation_id": "<32 hex from inspection>",
     "observation_sha256": "<64 hex from inspection>",
     "approved_at": "<integer Unix seconds, not a string>",
     "expires_at": "<integer, within one hour>",
     "allow_settle": true,
     "allow_migration": false,
     "allow_start": false,
     "allow_traffic": false,
     "allow_worker": false
   }
   ```

   Шаблон намеренно невалиден до проверки и заполнения. Старые разрешения
   могут истечь: здесь они только неизменяемая история. Они **не дают** права
   восстановления; свежий approval действует не более часа.

3. Выполнить только разрешённое завершение фиксации:

   ```sh
   python3 -E -s /opt/citygo/controller/control.py recover-commit \
     --request /etc/citygo/release-request.json \
     --recovery-approval /etc/citygo/approvals/recovery.json --allow-settle
   ```

   Повторяются live проверки и сверяется observation hash. Записываются однократная
   reservation и recovery evidence; перед снятием pending всё повторно проверяется,
   включая отзыв и срок нового разрешения **после** engine/HTTP/file reads.
   Результат `closed-commit-recovered`: без миграций, остановки/старта контейнеров,
   смены config, DB restore, upload и открытия доступа.

## Когда остановиться

До cutover, при отсутствии active, после restart, при неизвестном результате DDL,
изменении generation/config/evidence recovery откажет. После сбоя самого recovery
с уже записанной reservation/receipt также **нет автоматического retry**: требуется
отдельный разбор, не удаление его записей. Если pending уже отсутствует (в том числе
после неоднозначного fsync), recover-commit не применяется.

Следующие задачи остаются отдельными: допуск restart, совместимость/rollback drill
конкретного кандидата, живой выпуск с проверкой восстановления, новые резервные
копии под новым fingerprint, согласованное открытие трафика/Worker/расписаний и
production-допуск AI. Root/ручные Docker-команды и правки вне протокола не
изолируются этими locks; это не защита от администратора узла.

## Доказательства в CI

Linux unit-тесты покрывают CLI flags/schema, stale inputs, частичный cutover,
restart/extra peers, старые и свежие approvals, отзыв/истечение при последнем
health, оба locks. Container smoke намеренно прерывает **реальный disposable**
finish перед unlink, выполняет inspect + freshly approved recovery, затем новый
`pg_dump → age` и Worker с повторной паузой. Synthetic approvals/S3 и вымышленная
БД; реальные облачные аккаунты, ключи и модели не вызываются.

Дополнительный disposable drill выполняет **второй** закрытый выпуск в том же
Compose project и на той же БД. Между циклами остаются мигратор и Worker; добавлен
успешно завершённый синтетический Worker с другим локальным image ID. Без v2
retention approval такой inventory отклоняется; с точным новым разрешением
второй цикл проходит, PG и все прежние jobs сохраняют IDs/process timestamps,
API/Web получают новые IDs, создаётся новая копия, traffic/Worker остаются закрыты.

Этот drill повторяет те же проверенные app binaries и SQL journal с синтетическими
идентичностями двух releases. Он проверяет протокол повторного выпуска, **не**
совместимость произвольных миграций, перезапуск хоста или rollback. Отдельный
локальный historical image в CI создаётся из завершённого тестового latch Worker
и удаляется после проверки; производственный контроллер не содержит image commit,
удаления исторических jobs, генератора approval или внешней публикации.

После второго выпуска тот же CI выполняет [закрытый graceful stop/start](closed-restart-rehearsal.md)
API/Web/PostgreSQL: проверяет чистый выход до старта, новые процессы при тех же
ID/образах/volume, неизменные jobs, закрытый TLS/Worker, сохранённую сессию/данные/XP
и новую резервную копию. Это не host reboot, не production restart approval и не
ослабление same-process проверок commit recovery.
