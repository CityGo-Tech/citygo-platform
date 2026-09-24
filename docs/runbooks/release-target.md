# Одобренная цель подготовки релиза

Часть CG-037. `deploy/backup/target.py` выполняет **только локальное чтение**.
Он не скачивает/распаковывает архивы, не импортирует код кандидата, не обращается
к Docker/GitHub/БД и не разрешает миграции. Нет CLI и генератора реального approval.
На сервере ничего не активируется; пробный режим и расписания не включаются.

## Корень доверия — отдельное одобрение

`release.json`, SHA, labels и check IDs внутри кандидата — данные, не подпись.
Оператор отдельно проверяет успешный ручной workflow доверенного репозитория
`CityGo-Tech/citygo-platform` (repo ID `1351070410`, org ID `248379281`), его полный
SHA, run ID/attempt, CI, приватные Packages и точный artifact ID. Загрузка —
из выбранного [Actions run](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts),
не по URL из неизвестного manifest. Доставка/распаковка — отдельный проверенный шаг.

SHA-256 **точных байтов** целевого `release.json` берут из независимо проверенного
artifact, а не просто считают у неизвестной папки. Текущий hash сверяют с ранее
доставленным релизом. Оба фиксируют в защищённом approval вне обоих bundle.
Это ручной корень доверия: модуль не проверяет attestation и живой статус GitHub.
JSON из PR, архива или чата не становится одобрением автоматически.

## Входы доверенного контроллера

`Selection(current_directory, target_directory, approval_file)` принимает абсолютные
пути. Папки раздельные, не вложенные друг в друга; approval вне обеих. Файлы/папки
принадлежат оператору, без writable group/other, symlink и hardlink; approval — 0600. Родители проверяются прежним protected paths. Проверяющий модуль уже доверен
и установлен отдельно: код из проверяемого bundle не выполняется.

В approval требуется ровно следующий набор, без команд и произвольных URL:

| Поля                                                | Смысл                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `version`, `purpose`                                | `1`, `citygo-release-preparation`                                               |
| `repository_id`, `organization_id`                  | Закреплённые выше числовые ID                                                   |
| `artifact_id`                                       | ID отдельно проверенного artifact, строка цифр                                  |
| `current_manifest_sha256`, `target_manifest_sha256` | Независимо проверенные hashes точных байтов manifest                            |
| `target_sha`, `target_release_id`                   | Полный SHA и `<SHA>-<run ID>-<attempt>`                                         |
| `project`, `origin`                                 | Текущий Compose project и точный проверенный HTTPS origin                       |
| `configuration_sha256`                              | Fingerprint текущего backup config + Compose/env                                |
| `current_images`                                    | Проверенные текущие Docker image ID для api/web/postgres/worker/migrator/backup |
| `approved_at`, `expires_at`                         | Целые Unix seconds UTC, не из будущего, не просрочено, максимум 24 часа         |
| `allow_preparation`, `allow_migration`              | Ровно `true`, `false`: только подготовка                                        |

Оператор подтверждает fingerprint/current images после сверки работающего runtime.
Инвентаризация сравнивает контейнеры с этими image ID. Сам Selection не обращается
к Docker; вызывающая подготовка теперь отдельно проверяет [локальные образы](release-images.md)
обоих выпусков и связь текущих service ID с manifest, с учётом classic/containerd.
Скачивания/запуска образов нет. `current` в результате Selection содержит только
source SHA, image references/IDs и прежний PostgreSQL digest для этой сверки.

Не создавать реальное approval до согласования окна обслуживания. Часы хоста
должны быть корректными. Пока нет пути завершения контроллера, успешная подготовка
намеренно оставляет приложение закрытым — библиотеку не запускать в production.

## Проверки

- Строгая схема и ограниченный размер JSON: неизвестные/повторные поля, NaN/Infinity,
  неоднозначные типы, дубликаты и чрезмерный размер отклоняются.
- Точные repository/platform/SHA/release/run identity, два разных CI check IDs,
  закрытая policy: AI disabled, deploymentApproved=false, automaticRollback=false.
  Check IDs проверяются структурно, а не через API.
- Только api/web/jobs в заданном GHCR namespace, immutable digest и фиксированные
  Node/PostgreSQL base repositories. PostgreSQL digest должен остаться прежним;
  даже minor image update требует отдельного проверенного пути обновления БД.
- Хеши всех runtime-файлов и точное дерево: нет лишних файлов/пустых папок, `.env`,
  ссылок, FIFO или неполного набора. Кандидат содержит ровно allowlist publisher;
  текущий старый bundle — начальный доставленный набор и только известные добавления.
  Тест сверяет allowlists; синтетические test writers в bundle не поставляются.
- Список миграций кандидата начинается с точного прежнего списка name/hash;
  новые номера уникальны и идут после старых. Нельзя менять/переставлять/удалять
  выпущенные миграции. Это не проверка применённых миграций БД или совместимости SQL.

## Связь с подготовкой и отказами

`prepare(..., selection=selection, allow_stop=True, allow_upload=True)` требует
`Selection`. Первый проход — **до pause/ingress/остановки**: неверная цель не меняет
допуск Worker и не создаёт pending. Всё перечитывается после drain перед копией,
затем после копии и очистки временных файлов. Expiry/revocation/drift прекращают
подготовку. Approval повторно проверяется после чтения bundle, чтобы долгий проход
не пережил истечение срока.

Первый успех закрепляет байты approval в объекте. Любой отказ необратимо
инвалидирует объект, даже если вернуть прежний файл. Новое одобрение требует
нового объекта и решения оператора; существующий pending всё равно запрещает
повтор подготовки. Автоматического снятия запрета нет.

`release-prepared.json` содержит `target`: hashes, artifact/release/run identity,
image references, новые миграции и срок. В обоих уровнях `migration_authorized=false`.
Это не разрешение для другого процесса. Отказ после закрытия ingress оставляет
его закрытым. Протокол кооперативный: runtime/approval и внешние bind/secret файлы
должны оставаться неизменными, root не должен подменять их между чтениями.

Unit tests покрывают подмены/права/ссылки, самоодобрение, expiry, отказ повторного
использования и историю миграций. Интеграционные тесты проверяют отсутствие downtime
при неверной цели и отказ при изменении цели во время drain/backup. Disposable smoke
использует **синтетический** approval вместе с реальными TLS/контейнерами/копией:
это не проверка происхождения реального GitHub artifact и не одобрение сервера.

Следующие этапы: одобренная доставка/миграция, health/mobile
compatibility и безопасное завершение в одном окне. Этот модуль не снимает оставшиеся
условия публичного пилота. Строгий декодер учитывает
[ограничения Python JSON](https://docs.python.org/3/library/json.html).
