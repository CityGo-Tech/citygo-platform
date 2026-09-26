# Запуск API/Web и проверка до открытия доступа

Продолжение CG-037 / §10.5. `deploy/backup/start.py` — внутренняя библиотека,
**не production CLI и ещё не завершённый rollout**. Пока отсутствуют finish,
переключение active release/configuration и recovery drill, на рабочей ВМ не запускать.
Публичные `prepare()` и `migrate()` сохранили прежние ограниченные полномочия.

## Отдельное разрешение запуска

Разрешение миграции по-прежнему содержит `allow_start: false`. Для запуска требуется
ещё один проверенный оператором файл вне обоих bundle, отличный от preparation
и migration approvals. Он защищён теми же правилами путей/владельца/прав, не создаётся
кодом выпуска и не берётся из кандидата. Это ручной корень доверия, не attestation.

Точные поля:

- `version: 1`, `purpose: citygo-release-start`.
- `profile: citygo-api-web-disabled-v1` — фиксированный доверенный runtime.
- `migration_approval_sha256` — hash точных байтов одобрения миграции; через него
  связаны preparation approval, оба manifest, SHA, проект, origin, DB network/config.
- `api_secret_sha256` — hash существующего защищённого API JSON; допускаются только
  URL роли citygo_api в postgres:5432/citygo_pilot и необязательные ADMIN_USER_IDS.
  Ключи провайдеров и дополнительные параметры не допускаются.
- `web_network_id` — точный ID существующей сети web_api.
- `approved_at`, `expires_at` — целые Unix seconds, максимум 24 часа.
- `allow_start: true`, `allow_traffic: false`.

Отзыв/изменение/expiry проверяются повторно, в том числе во время подготовки и
миграции. ID существующей web_api сети сверяется read-only **до pause/downtime**
и повторно на границах; устаревший ID не разрешает начать миграцию.
Состав web-сети также сверяется с проверенным исходным inventory до downtime:
разрешены только API/Web, все работающие приложения должны иметь endpoint.
Посторонний либо отсутствующий endpoint блокирует начало операции; состав сети
повторно проверяется на границах миграции и после замены приложений.
После чтения Docker разрешения проверяются ещё раз, чтобы не пережить expiry.
Прочитанный объект после обнаруженного отказа нельзя восстановить
возвратом прежнего файла. Startup approval резервируется эксклюзивно до замены
контейнеров: `start-approval-<hash>.used.json` содержит operation, старые ID,
hash точной runtime-конфигурации и ID миграции. Секреты туда не записываются.

## Что запускается

Одна maintenance lock охватывает подготовку, копию, миграцию, запуск и проверки.
Контроллер генерирует фиксированный Compose JSON только для API/Web. Compose
из bundle, hooks, env_file, shell и произвольные override не исполняются.
Поддерживается только AI-disabled профиль; изменения runtime кандидата требуют
отдельного пересмотра профиля, а не автоматического исполнения его Compose.

Используются проверенные immutable local image ID, non-root/read-only/init,
no-new-privileges, drop ALL, память 768 MiB без swap на сервис, 128 процессов.
API получает только один существующий read-only secret, Web не получает секретов.
Web публикует только 127.0.0.1:3000. Сети external, создание/изменение БД/volume/сетей
не входит в команду. PostgreSQL и завершённые jobs не перезапускаются/не удаляются.
Оба новых приложения пока имеют restart=no: автозапуск после reboot должен быть
отдельно связан с окончательным допуском и постоянной конфигурацией.

`compose up` ограничен api/web, без deps/build/pull и remove-orphans, с bounded wait.
**Он заменяет и удаляет старые контейнеры API/Web**, поэтому до него записываются
их ID и попытка. Старые образы и DB volume сохраняются. Автоматического rollback
или повторного up после ошибки нет. Поведение recreate и external networks описано
в [Docker Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)
и [документации сетей](https://docs.docker.com/reference/compose-file/networks/).

## Приёмка закрытой новой версии

- PostgreSQL и retained jobs имеют прежние ID/image/StartedAt/restart/exit evidence;
  PostgreSQL остаётся healthy, лишние контейнеры/участники сетей запрещены.
- API/Web действительно заменены: новые ID, ожидаемые образы, команды, пользователь,
  изоляция/лимиты, сети/IP/loopback-port, environment и единственный API mount.
- Оба healthy, без restart/OOM/ошибок. До и после HTTP-проверок совпадают процессы.
- Только loopback GET: `/api/ready` = 200 и точный status=ok; `/api/v1/dashboard`
  с явной версией 1 и без заголовка = 401 с корректным error/metadata/request ID.
  Проверяется headerless v1 совместимость, **не весь старый мобильный сценарий**.
  Нет регистрации, бизнес-записей или вызовов ИИ.
- TLS ingress по-прежнему отдаёт maintenance, Worker admission и pending закрыты.

`start-<operation>.success.json` содержит только безопасное подтверждение startup
и проверок. Оно записывается только после успешного выхода из внешнего
migration/preparation window и повторной проверки разрешений: ошибка финализации
или отзыв разрешения при выходе не оставляет startup success. Pending всё ещё
блокирует новый выпуск. После cleanup короткая maintenance lock защищает только
read-only сверку прежнего operation/configuration, закрытого ingress/Worker,
контейнеров/сетей/runtime и повторных HTTP probes с теми же новыми процессами,
а затем запись receipt. Остановка, перезапуск либо сбой health при финализации
не оставляют success. Это не возобновление release window и не разрешение ещё
раз менять сервисы или БД. Receipt — историческое свидетельство, не замена свежим
проверкам и независимому разрешению будущего finish.
Это не финал выпуска, не разрешение открыть ingress/Worker и не смена
active release. При сбое часть новых контейнеров может уже работать за закрытым
ingress. Timeout/потерянный ответ означают ручную сверку; скрипт не останавливает
новые контейнеры, не откатывает БД и не снимает pending автоматически.

## Проверки и оставшиеся работы

Unit tests: отдельные scopes, неверные секреты/runtime/ports/images, readonly health,
отзыв разрешения, повтор, частичная замена, сбой health, смена процесса/PostgreSQL/сети.
Disposable CI: настоящая цепочка TLS/drain/pg_dump/age/миграция → замена API/Web →
health/headered/headerless checks с тем же lock; PostgreSQL и retained jobs неизменны.
Approvals/registry bindings синтетические, S3 — MemoryStore; реальные сервер/ИИ не используются.

Далее: финальный compatibility/synthetic-user drill, независимый допуск traffic,
атомарная фиксация active release и backup/Worker configuration, проверка восстановления.
Этот этап не включает DNS/TLS рабочей ВМ, расписания, production AI или тестировщиков.
