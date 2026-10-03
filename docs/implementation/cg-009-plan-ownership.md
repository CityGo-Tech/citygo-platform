# CG-009 — принадлежность квеста плану

Дата: 3 октября 2026. База: `b5473212b41969dd82e76eee0696e1710b8681bf`
(main после PR73). Ветка: `codex/cg-009-plan-ownership`.

Статус: локальная реализация и проверка завершены; пользователь разрешил
commit/push и публикацию Draft PR для проверки штатным GitHub CI.
Merge/deploy не разрешены, release gates не закрыты. Production-операции
и live AI не выполнялись.
Cursor независимо работает в другой worktree над CG-025; его файлы не изменены.

## Изменение модели данных

- `users → relocation_plans(user_id, version) → user_quests(plan_id, plan_version)`.
  Составной FK `(plan_id, user_id, plan_version)` ссылается на уникальную тройку
  `(id, user_id, version)`: существования чужого plan ID недостаточно.
- Уникальность квеста теперь `(plan_id, quest_id)`, а не `(user_id, quest_id)`.
  Новая версия плана получает новые user-quest IDs. Старые строки не перемещаются.
  Триггер запрещает изменение owner/definition/plan/version уже созданного ID.
- Один active-план на пользователя. Чтение берёт максимальную версию среди
  `active/completed`; draft/archived не показываются как действующие.
  Это правило текущего чтения, **не правило backfill**.
- Индекс `(plan_id, quest_id)` обслуживает plan-scoped reads/unlock и FK-проверки
  по plan ID. Для owner/version остаётся `(user_id, version)`; добавлена уникальная
  тройка-цель FK. Новые индексы создаются транзакционно на остановленном пилоте,
  не обещают zero-downtime на большой базе.
- `xp_events.user_quest_id`, `event_key`, существующие unique-ограничения XP и
  все старые migration-файлы остаются неизменными. XP суммируется по пользователю
  за всю историю, не только за текущий план.

### Версии и статусы

| Понятие                        | Семантика CG-009                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Wire/schema version            | Остаётся v1; не номер плана                                                       |
| `relocation_plans.version`     | Уже существовавшая версия плана пользователя; не увеличивается при start/complete |
| `Quest.plan = { id, version }` | Ссылка на сохранённую строку/версию плана, не R1 `{ id, revision }`               |
| Resource revision              | Кандидат CG-008; CG-009 не выдумывает revision из timestamps или plan.version     |
| Definition version             | Пока legacy-каталог `quests`; версионированные критерии/награды — CG-010/012      |

Legacy-статусы сохраняются без переименования:

| БД        | Поведение                                             | Кандидатный R1-контракт                                               |
| --------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| draft     | Не текущий, команды отклоняются                       | Нужен явный draft при будущем rollout; не превращать в active         |
| active    | Команды разрешены только для текущего плана           | Соответствует active по смыслу, но нет R1 endpoint/resource revision  |
| completed | Прогресс виден, replay completion = 0; start запрещён | Нужен completed в будущей схеме; не маскировать как active/superseded |
| archived  | История сохранена, команды отклоняются                | Не всякий archived означает superseded; понадобится явная причина     |

`r1PlanSchema` из CG-008 намеренно не подключён к старым строкам. Его enum
`active/superseded` недостаточен для всех legacy-состояний. CG-010/012 должны
уточнить кандидатную схему до её активации, не расширяя enum старого endpoint.

## Миграции и неоднозначные данные

1. `0010_quest_plan_expand.sql`: nullable-пара, FK, индексы и diagnostic view.
   Старая уникальность сохраняется; старый writer может вставлять без plan_id.
   Исторические бизнес-поля не меняются.
2. `0011_quest_plan_validate.sql`: блокирует записи в затрагиваемые таблицы,
   проверяет preflight, заполняет только plan_id/plan_version, включает NOT NULL,
   заменяет уникальность и устанавливает неизменяемость идентичности.

Автоматическая привязка разрешена только при **единственном** плане пользователя,
статусе active/completed, наличии slug в массиве plan.stages и согласованных
датах/состояниях/владельце XP. Даже «один active плюс один archived» неоднозначен.
Миграция не выбирает latest, не создаёт отсутствующий план и не реконструирует
evidence. Completed без XP сохраняется без доплаты; XP у незавершённого квеста
останавливает перенос для ручного разбора.

Диагностика на изолированной копии после expand, от migration-роли:

```sql
select issue, count(*) from citygo_quest_plan_preflight
where issue is not null group by issue order by issue;
select user_quest_id, user_id, issue from citygo_quest_plan_preflight
where issue is not null order by user_quest_id;
select user_id, count(*) from relocation_plans
where status = 'active' group by user_id having count(*) > 1;
```

Причины: missing_user, missing_quest, missing_plan, ambiguous_plan,
owner_or_version_mismatch, unsupported_legacy_status, quest_not_in_plan,
completed_plan_has_open_quest, plan_created_after_quest, xp_owner_mismatch,
xp_state_mismatch. View не предоставляется API/worker; их существующих grants
достаточно для обычных команд. Функция триггера SECURITY INVOKER, без доступа
через PUBLIC EXECUTE и без расширения runtime-прав.

Неоднозначные строки — отдельное согласованное решение на копии с точной картой
ID и повтором проверок. Нельзя убрать preflight, удалить XP или принудительно
подставить самый новый план ради зелёного deployment.

## API, транзакции и совместимость

Анкета создаёт план и связанные квесты атомарно. Dashboard возвращает только
квесты текущего плана и добавочное `quest.plan`. Новый клиент умеет читать старый
ответ без этого поля. Старые start `{}` / complete `{confirmed:true}` поддержаны:
неизменяемый user-quest ID уже определяет точный план, сервер проверяет актуальность.
Клиент может передать `plan: {id, version}` для дополнительной проверки.

Чужой quest/несовпадающий plan ID → 404 NOT_FOUND без раскрытия чужих данных;
неверная версия, archived/draft или superseded ID → 409 PLAN_STALE. Невалидная
форма ссылки → 400 VALIDATION_ERROR. Ни XP, ни thread, ни analytics не записываются.
`currentVersion` при PLAN_STALE — версия текущего плана; это не обещание R1 CAS.

Порядок блокировок: user → plan → user quest. Dashboard удерживает shared user
lock для согласованности progress/XP. Будущий replacement обязан брать user lock
до изменения планов и создания новых квестов. В транзакции нет AI/network I/O.
Completion, XP, unlock и завершение конкретного плана атомарны. Unlock не затрагивает
другие планы; план завершается только когда у него не осталось открытых квестов.
Повтор для завершённого квеста текущего active/completed плана возвращает 0;
повтор старого archived плана отклоняется, но прежний XP остаётся.

`/ready` требует обе новые миграции. Readiness не заменяет остановку старых writers.
Существующая проверка наличия ответа Housing сохранена: это **не artifact/evidence**,
не подтверждение ревизии брифа и не защита от позднего ответа старого диалога.
Эти ограничения закрываются CG-010/012/014. Нового plan-replacement endpoint нет.

## Release и возврат

Два файла — логические фазы, не обещание двух отдельных deploy. Текущие migrators
применяют все pending-файлы в одной транзакции. При отказе 0011 также откатывается
0010, если она применялась в этом запуске. Поэтому диагностический view после
неудачного полного перехода может отсутствовать; исследовать expanded копию.

До merge обязательны:

1. CI с PostgreSQL 17, container smoke с ролями, положительными и отрицательными
   migration/ACL/lock/drift fixtures, build и Web/Expo compatibility.
2. Копия текущей БД: preflight/mapping и сравнение непустых progress/XP/consent/credit
   до/после; проверка restore. Это отдельный доступ, не выполнено над production.
3. Согласованный backup/maintenance/drain; остановить ВСЕ старые writers.
   Mixed rollout небезопасен даже при nullable plan_id: старый complete/unlock
   не знает о планах. API/worker не запускаются до grants и проверки результата.
4. После 0011 только новый совместимый сервер. Проверить readiness, контрольный
   сценарий и денежные/consent-инварианты до разрешения трафика.

При откате транзакции до commit допустим возврат старого кода на старую схему.
После commit 0011 **не запускать старый образ**: его insert без plan_id нарушает
NOT NULL, а reads/unlock/complete не ограничены планом. Сохранить maintenance,
drain и применять forward-fix. Автоматический обратный SQL не предусмотрен.
Restore backup — отдельная согласованная recovery-операция с оценкой потерь.

Container smoke обновлён с отдельного разрешения пользователя: теперь 11 миграций,
upgrade fixture 9 → 11 с непустым XP/consent/credit, сохранением исходных строк,
ошибками SQL/ACL, блокировками и отказом повторной устаревшей release-команды.
Его rewind/cleanup относятся только к создаваемой им синтетической БД, никогда
не являются инструкцией rollback рабочей базы. CI/deploy-политики не менялись.

## Проверка

Команды локально через `node .local/handoff/pnpm-safe.mjs`: окружение без .env,
provider keys и TEST_DATABASE_URL. Проверки выполняются в этой worktree.

- Контракты: старые payloads/ответы, optional plan и невалидные ссылки.
- DB: старые active/completed данные; все причины preflight; сохранение timestamps,
  ID, XP, consent/credit; nullable expand/строгая validation; составной FK,
  immutable identity; две версии плана; rollback начисления; существующие API grants.
- API: headerless/current клиенты, ownership/stale, отсутствие побочных записей,
  readiness, прежние сценарии трёх provider doubles; полный regression без live AI.
- PostgreSQL-only тест ждёт фактической блокировки второго соединения через
  pg_blocking_pids и проверяет отказ completion после replacement. В первом
  in-memory прогоне — **SKIP**; затем выполнен успешно на disposable PostgreSQL
  17.11. PGlite сериализует транзакции и не доказывает PG concurrency.
- Сборка API с зависимостями, lint/typecheck, форматирование и diff --check.

Итоговые локальные прогоны 03.10.2026:

| Проверка                                                                                   | Результат                                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `--filter @citygo/contracts test`                                                          | 23 PASS                                                                           |
| `--filter @citygo/db test`                                                                 | 38 PASS, включая SQL-fixture перехода 9 → 11 и проверку release grammar           |
| `--filter @citygo/api exec node --import tsx --test --test-concurrency=1 src/**/*.test.ts` | 119 PASS, 1 PostgreSQL-only SKIP                                                  |
| API-набор с явно переданным disposable PostgreSQL URL после очистки окружения              | 120 PASS, 0 SKIP, включая replacement/completion race                             |
| `packages/db/src/quest-plans.test.ts` на disposable PostgreSQL 17.11                       | 22 PASS: backfill/отказы, ownership, XP, API grants, upgrade fixture              |
| `--filter @citygo/api-client --filter @citygo/domain test`                                 | 33 + 2 PASS; Web/native transport и domain без изменений                          |
| `--filter @citygo/contracts --filter @citygo/db --filter @citygo/api typecheck`            | PASS                                                                              |
| Те же три пакета `lint`, ESLint двух smoke-скриптов, `node --check`                        | PASS                                                                              |
| `--filter @citygo/api... build`                                                            | PASS; без Web/Expo-сборки                                                         |
| Полный `container-smoke.mjs --disposable` в Linux-runner с локальными Desktop overrides    | PASS / exit 0; API/Web/jobs build, migration/roles/drain, backup/restore, TLS/SSE |
| Linux `deploy/backup/test_*.py`                                                            | 349 PASS, 1 SKIP в контейнере; пропущенный systemd-тест отдельно PASS в Ubuntu    |
| Linux release/deploy/stop/ingress unit-проверки                                            | 50 PASS, 0 SKIP                                                                   |

Первый in-memory набор: 215 PASS и 1 явно пропущенный PostgreSQL-тест.
Последующие PostgreSQL-прогоны выше дополняют его, а не подменяют: 22 теста
миграций — повтор тех же случаев на другом движке, не 22 новых сценария.
Ранний negative-тест проверял FK через уже занятый unique key — fixture исправлена,
чтобы проверять именно FK. Отдельный LOCK в SQL не проходил существующий guarded
release parser — блокировка включена в preflight DO, parser не ослаблен.
Первичный esbuild/tsx в Windows sandbox столкнулся с ограничениями доступа/учётной
записи; те же проверки прошли вне sandbox с очищенным launcher-окружением.

Полный локальный container smoke с guarded migration job и backup/restore
выполнен в Linux-runner с описанными ниже Desktop overrides. Docker-сборка также
проверила Web build; браузерный E2E и Expo export в этом запуске не выполнялись.
Остаются стандартный GitHub CI/Container smoke без локальных overrides, режим
`--release-candidate`/registry rehearsal и production preflight/restore на копии.
Локальный успех не закрывает эти release gates и не разрешает рабочую миграцию.

### Проверка доступности disposable-контура 03.10.2026

Пользователь разрешил отдельный одноразовый Docker/PostgreSQL-контур.
Первоначально Linux Engine был недоступен. После подтверждения пользователя
Docker Desktop 4.91.0 / Engine 29.8.0 ответил через context `desktop-linux`.
Созданы и удалены два контейнера только для этих проверок, без host mounts
или рабочих volumes, с tmpfs-данными и случайными портами на 127.0.0.1.
Образ: `postgres:17-alpine`, фактически PostgreSQL 17.11,
digest `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`.
Образ оставлен в локальном Docker cache; тестовые данные удалены.

Локальный helper `.local/handoff/test-pg-disposable.mjs` запускается через
`node .local/handoff/pnpm-safe.mjs exec node .local/handoff/test-pg-disposable.mjs`
(API), с `--db-only` — 22 CG-009 DB-теста. Helper не входит в Git/production,
не использует унаследованный TEST_DATABASE_URL: создаёт synthetic credentials
и передаёт адрес своего контейнера после очистки окружения. Cleanup проверяет
точный container ID и уникальную label. DB-fixture создаёт отдельную случайную
базу на каждый case и удаляет только её; без URL сохраняется PGlite-режим.

Полный smoke дополнительно требует Linux: backup/migration harness использует
Unix Docker socket, `fcntl`/`preexec_fn`, проверку `sys.platform`, `python3` и age.
Подмена имени Python в Windows не решает эти зависимости. После отдельного
разрешения пользователя подготовлена Ubuntu-22.04/WSL: установлен пакет age
1.0.0-1ubuntu0.1 без обновления остальных пакетов и отдельный Node 24.11.1 в
`/opt/citygo-smoke-toolchain/node-v24.11.1-linux-x64`. Архив Node проверен по
официальному SHASUMS256.txt. Python 3.10.12, curl/git/OpenSSL уже были в системе.
Пользователь включил WSL integration: из Ubuntu доступны Docker Engine 29.8.0
и Compose 5.5.1. Ранее наблюдалось предупреждение systemd user session.

Для smoke экспортированы 398 файлов текущего checkout в отдельную Linux-папку
`/tmp/citygo-cg009-smoke.tNUNLg`, без .env, .local, ключей, node_modules и рабочих
данных. Git baseline перенесён локальным bundle; новых коммитов нет, текущий diff
включён. Digest исходников этого снимка:
`98e108b2a9219d0e482b004042f3195fc5810bdc210bde42f577918921b4d008`.
Позднейшие правки этого отчёта в снимок не включены; кодовая база не менялась.

Остаётся инфраструктурный preflight: smoke использует Nginx с `--network host`.
Пользователь включил **Enable host networking** и интеграцию с **Ubuntu-22.04**;
на скриншотах настройки применены (Apply неактивна), Engine работает. Общая
галочка интеграции с default WSL distro не требуется при включённой Ubuntu.
Дополнительное переключение этих настроек не является оставшимся действием.

Повторная диагностика использовала постоянный TCP echo server (`busybox nc -lk`),
а не только первоначальный HTTP/netcat-пробник. Подтверждены running state,
LISTEN на 0.0.0.0 и правильный ответ внутри каждого пробного контейнера:

| Режим                           | Внутри контейнера | Windows 127.0.0.1 | Ubuntu 127.0.0.1 |
| ------------------------------- | ----------------- | ----------------- | ---------------- |
| `--network host`, порт 48973    | PASS              | ECONNREFUSED      | ECONNREFUSED     |
| bridge, `127.0.0.1:48974:48974` | PASS              | PASS              | PASS             |

Windows-проверки повторены спустя 10 секунд с тем же результатом. CLI использовал
context desktop-linux, Docker Desktop Engine 29.8.0. Это локализует препятствие
в доступности host-network listener через localhost в текущем Desktop-контуре,
а не в неработающем TCP-пробнике, выключенной WSL integration или общей
недоступности Docker. Точная внутренняя причина Desktop не установлена.
Работающий bridge-проброс не доказывает пригодность режима host, необходимого
неизменённому smoke. Сети/firewall/production не менялись; все пробные контейнеры
и их временные anonymous volumes удалены после проверки ID и уникальной label.

На этом этапе полный smoke ещё не запускался. Последующий успешный локальный
Linux-прогон и точные отличия его окружения описаны ниже; стандартный CI остаётся
отдельной обязательной проверкой.
Нельзя останавливать существующие сервисы для освобождения фиксированных портов
и сетей smoke; отдельный PostgreSQL-тест должен использовать случайный loopback
порт и только свежую синтетическую БД. Унаследованный TEST_DATABASE_URL
launcher удаляет: адрес disposable-БД нужно передавать после очистки окружения.

### Полный локальный Linux smoke: PASS, 03.10.2026

После продолжения по команде пользователя подготовлен отдельный непривилегированный
Linux-runner (UID 1000, без capabilities, read-only rootfs) с Node 24.11.1,
Python 3.11.2, age 1.1.1, Docker CLI 29.8.0 и Compose 5.5.1. Он использовал
Docker socket и host network только для управления одноразовым стендом; это не
песочница безопасности для недоверенного кода. Ключи, пользовательские .env,
рабочие БД и исходная worktree в контейнер не монтировались.

Снимок 398 исходных файлов и отдельные Git-метаданные перенесены в новый volume;
дочерние контейнеры видели тот же каталог. База HEAD осталась `b5473212b41969dd82e76eee0696e1710b8681bf`,
некоммиченные CG-009 изменения включены. Новый WSL-снимок:
`/tmp/citygo-cg009-smoke.nXsiCt`; digest до последнего обновления этого отчёта:
`11719934ecf04588b00b9c7f365ed0ee01e7455437f7743e4d2da6bc97963d3b`.
Runtime-образы собраны из проектного `node:24-bookworm-slim` (Node 24.21.0),
с закреплённым pnpm 10.15.0 и frozen lockfile; не опубликованы.

Две ранние попытки выявили особенности локального стенда, а не дали PASS:

1. Динамически опубликованный порт недоступен из host-network runner, хотя
   фиксированный loopback-порт доступен. Локальный override заменил только Web
   port на `127.0.0.1:48977:3000`; API/БД/worker/migrator портов не публикуют.
2. Две сборки одного target `jobs` получили разные `com.docker.compose.service`
   labels от Compose 5.5.1. Слои и остальные настройки совпали, но строгая проверка
   одинакового image ID закономерно остановила тест. Отключение provenance этого
   не решило. В финальном прогоне provenance не отключалась: локальный override
   собирал jobs один раз с двумя тегами, Worker использовал образ Migrator.
   До этого launcher проверил полное равенство исходных build definitions.

Все assertions основного smoke сохранились, включая проверку точного image ID
Worker/Migrator. Overrides и launcher находятся только в игнорируемой
`.local/handoff`; tracked CI/deploy-файлы не менялись. Это локальная адаптация,
не доказательство прохождения исходного стенда на GitHub runner.

Финальный `node scripts/container-smoke.mjs --disposable`: **exit 0**. Проверены:

- API/Web/jobs production build, health, assets, auth, CSRF, persistence и AI gates;
- 11 миграций, непустой upgrade 9 → 11, restricted migration role, drift/SQL/ACL/
  lock failures, transactional rollback и сохранность progress/XP/consent/credit;
- graceful drain API/Worker, повторные сигналы, отказ принять SIGKILL/ошибку
  процесса за успех, сохранение уже принятой транзакции;
- настоящий pg_dump → age → pg_restore на синтетической БД; S3 только MemoryStore,
  ни одного cloud upload, реального запроса к модели или расхода пользовательского баланса;
- TLS/headers/SSE, закрытый ingress, две закрытые release-fixture последовательности,
  восстановление после прерванного commit, сохранение historical jobs;
- закрытый graceful restart с теми же контейнерами/volume, сохранение исходной
  сессии, анкеты, квеста, истории, +60 XP и следующего квеста; повторная награда 0.

Отдельный Linux-набор backup/operator: 350 tests, из них 349 PASS и один SKIP
(`systemd-analyze` отсутствует в runner). Этот единственный тест синтаксиса unit-
шаблонов дополнительно выполнен в Ubuntu-22.04: PASS, без установки/старта служб.
Release-candidate/deploy-main/container-stop/ingress unit-набор: 50 PASS, 0 SKIP.

Машинный результат и журнал: `.local/handoff/linux-smoke-result.json` и
`.local/handoff/linux-smoke-output.log`. Журнал содержит также две ранние неудачные
попытки; итог относится к последнему запуску. Smoke удалил свои сервисы, сети и
тестовые БД; служебный runner, anchor и отдельный source volume удалены после
проверки точных ID/labels. WSL-снимок и build cache оставлены для воспроизводимости.
Это не production restart, не host reboot и не разрешение на merge/deploy.

Навык PostgreSQL повлиял на составной FK, индексы, порядок коротких транзакций
и отдельную validation-фазу. Использован собственный существующий мигратор проекта,
не Supabase CLI или подключённая Supabase-БД. Основания:
[ограничения PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html),
[ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html).
