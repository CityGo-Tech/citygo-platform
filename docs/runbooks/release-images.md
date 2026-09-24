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

### Classic Docker и containerd

В classic store `.Id` — config digest, поэтому требуется точное совпадение с
протестированным ID. У containerd `.Id` может быть manifest digest. Простое
игнорирование различия небезопасно: проверяется точный descriptor и SHA-256
локальных manifest/config bytes, связь manifest → config, платформа, RootFS
и source/revision. При наличии descriptor допустим local ID, равный одному из
двух проверенных digest (manifest или config), **только после** проверки обоих
blobs. Совпадение config ID не обходит чтение content. Размеры descriptor/config
также должны совпасть. Читаются
только два фиксированных digest через `ctr content get`, namespace `moby`, socket
`/run/containerd/containerd.sock`; никакие команды из образа не выполняются.

Поддерживаются одиночные OCI/Docker schema-2 manifest. Неизвестный формат, index,
другая архитектура, недоступный `ctr`/blob или несовпадение — закрытый отказ,
**не** fallback на одни labels и **не** повод менять daemon. Если будущий CI
запишет manifest ID вместо config ID, всё равно проверяется вся цепочка bytes.
Classic CI ID на containerd-хосте поддерживается. Обратное сочетание manifest ID
из containerd CI на classic-хосте пока отклоняется; автоматического ослабления нет.

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

Unit tests покрывают оба формата Docker, неправильные ID/platform/source/digest,
повреждённые и отсутствующие blobs, index, привязку ролей и безопасный транспорт.
Linux integration tests проверяют отсутствие downtime при preflight-отказе,
отзыв approval во время чтения образов и запрет backup/квитка при drift.

В disposable CI после push/pull трёх образов в loopback registry проверяются
**настоящие** local Docker inspect и отказы для отсутствующего/неверного образа.
Те же настоящие manifest/config bytes проверяются через **имитацию** формата
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
[реализация containerd ImageInspect](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go).
