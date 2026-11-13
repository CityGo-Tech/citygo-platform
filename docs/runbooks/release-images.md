# Локальные образы одобренного выпуска

Часть CG-037 / §10.4 плана Cloud.ru. `deploy/backup/image_gate.py` — read-only
проверка перед подготовкой релиза, не загрузчик и не команда развёртывания.
Ничего не устанавливается на сервер, не запускается и не скачивается. Нет CLI,
login, pull, tag, удаления, переключения Docker backend или автоматического retry.

## Что связывает проверка

Вход — свежий результат [Selection.verify](release-target.md), полученный из двух
проверенных bundle и отдельного одобрения оператора. JSON/labels из неизвестной
папки не являются разрешением. Транспорт читает только локальный Docker socket
и при необходимости локальное content-хранилище containerd; не наследует ключи,
прокси, Docker contexts и пользовательский registry config.

Для **обоих** выпусков проверяются API/Web/jobs:

- Точное закреплённое GHCR-имя роли и digest, присутствующий в `RepoDigests`.
  Проверка по тегу, другому registry или одному совпавшему OCI label не допускается.
- Платформа linux/amd64, source CityGo-Tech/citygo-platform и полный SHA выпуска.
- Связь локального содержимого с `imageIds`, протестированными при публикации.
- Текущие local ID привязаны к независимо одобренным service ID: API/Web и общий
  jobs для Worker/migrator. Последующая инвентаризация проверяет именно эти ID.
- PostgreSQL и backup используют один одобренный local ID и прежний digest
  `postgres:17-alpine`. Новая версия PostgreSQL этим путём не допускается.

Ручной workflow `Release candidate (manual)` передаёт режим `manual` и
`vars.CITYGO_POSTGRES_IMAGE` в подготовку базовых образов. Значение должно быть
полным `postgres:17-alpine@sha256:…` и совпадать с текущим проверенным bundle
сервера. При отсутствующем или неверном pin подготовка отклоняется до первого
Docker-вызова; перехода на плавающий тег нет. Автоматический и operator-local
режимы сохраняют такую же привязку. Обычная disposable-проверка без режима
выпуска по-прежнему может разрешать публичный тег для своего тестового стенда.

### Classic Docker и containerd

В classic store `.Id` — config digest. При совпадении с протестированным config ID
сохраняется прежний путь. У containerd `.Id` может быть manifest или index digest. Простое
игнорирование различия небезопасно: проверяется точный descriptor и SHA-256
локальных index/manifest/config bytes, связь index → manifest → config, платформа,
RootFS и source/revision. Допустимы только ID из полностью проверенной цепочки.
Совпадение config ID при наличии descriptor не обходит чтение content. Размеры
также должны совпасть. Читаются только два или три фиксированных JSON digest
через `ctr content get`, namespace `moby`, socket
`/run/containerd/containerd.sock`; никакие команды из образа не выполняются.

Поддерживаются одиночные OCI/Docker schema-2 manifest и одноуровневый OCI/Docker
index с **ровно одним** linux/amd64 manifest. Дополнительные дескрипторы допустимы
только как BuildKit attestations `unknown/unknown`, явно связанные с выбранным
manifest. Они не выбираются для запуска и не считаются одобрением. Индекс и
attestations не удаляются и digest не подменяется digest дочернего manifest.
Дубликаты, несколько runnable-кандидатов, другие платформы/варианты, вложенные
индексы, URL/embedded data, неверные hash/size или связь attestation — закрытый отказ.

Для разных Docker backends разрешено заранее отдельно разместить metadata в
`<state_dir>/image-content/<sha256 hex>.json`. Это **не разрешение**, а локальный
content-addressed cache. Контроллер не создаёт его и не обращается к registry.
Файлы должны принадлежать оператору, иметь private-права, nlink=1, без symlink и
небезопасных предков; максимум 256 KiB каждый. При наличии небезопасного cache
файла нет fallback. При отсутствии файла сохраняется прежнее чтение локального ctr.
Каждый прочитанный blob всё равно проверяется по ожидаемому digest.

Таким образом classic-хост может проверить index/manifest ID, испытанный на
containerd: проверяются все bytes цепочки и точное совпадение config digest с
реальным local ID classic Docker. Неполные metadata, недоступные blobs или
несовпадение запрещают подготовку до остановки сервисов; labels сами по себе
никогда не являются заменой.

Доверие к локальному root/Docker/content store обязательно. Эта проверка не
проверяет подпись/attestation, не перечитывает каждый слой с диска, не доказывает
совместимость миграций и не заменяет проверку происхождения GitHub artifact.
Docker сам отвечает за content-addressed storage. Полный Config/Env/health logs
не печатаются и не сохраняются в квитке; ошибки транспорта имеют фиксированный код.

## Место в подготовке

1. Проверить Selection и локальные образы **до** закрытия Worker admission,
   ingress, создания pending или остановки API. Отсутствующий образ не должен
   приводить к простою; скачать его можно только отдельно после согласования.
2. Ещё раз проверить одобрение после чтения образов: оно не должно истечь или
   быть отозвано во время проверки.
3. Внутри прежнего release lock повторить сверку перед backup, после backup и
   после очистки временных файлов. Drift блокирует дальнейшую подготовку.
4. Записать минимальную секцию `local_images` в `release-prepared.json`:
   reference/local/tested/config ID, source SHA, способ проверки. Всегда
   `migration_authorized: false`. Сохранённый квиток не даёт права запуска.

Отказ до pause оставляет текущий допуск неизменным. Отказ после pause/остановки
сохраняет закрытый вход и pending. Нет автоматического возобновления, отката или
повторной копии. Параллельные изменения root/Docker между чтениями невозможно
исключить этим кооперативным протоколом; runtime остаётся неизменным на время
операции по правилу эксплуатации.

## Проверки без рабочего сервера

Unit tests покрывают оба Docker backend, прямой manifest и index, неправильные
ID/platform/source/digest, неоднозначные/вложенные индексы, подмену attestation,
повреждённые и отсутствующие blobs, cache-права, привязку ролей и безопасный транспорт.
Linux integration tests проверяют отсутствие downtime при preflight-отказе,
отзыв approval во время чтения образов и запрет backup/квитка при drift.

В disposable CI после push/pull трёх образов в loopback registry проверяются
**настоящие** local Docker inspect и отказы для отсутствующего/неверного образа.
Те же настоящие index/manifest/config bytes проверяются через **имитацию** формата
containerd и blob-транспорта; повреждённые bytes обязаны отклоняться. Это не запуск
настоящего containerd daemon и не проверка рабочей ВМ. Synthetic approval в прежнем
prepare smoke использует имитацию image store; реальная проверка образов идёт
отдельно в registry smoke. Тестовые writers/transports не входят в runtime bundle.

Следующие этапы: отдельно согласованная доставка, проверка ресурсов/схемы,
миграция и запуск, health/mobile compatibility, безопасное завершение и упражнение
отката. DNS/TLS, production AI, мониторинг и допуск тестировщиков этим PR не закрыты.

Источники: [Docker image inspect](https://docs.docker.com/reference/cli/docker/image/inspect/),
[фиксированный digest](https://docs.docker.com/reference/cli/docker/image/pull/),
[containerd image store](https://docs.docker.com/engine/storage/containerd/),
[OCI index](https://github.com/opencontainers/image-spec/blob/v1.1.1/image-index.md),
[формат BuildKit attestations](https://docs.docker.com/build/metadata/attestations/attestation-storage/),
[реализация containerd ImageInspect](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go).
