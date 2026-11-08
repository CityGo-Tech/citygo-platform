# Подготовка подключения #190 — 9 ноября 2026

Основа — `main a87c5cdd4fa93887676eb30b184fa8c79899f565` после слияния #190.
Запрошена только подготовка. Сервер, ingress, runtime, БД, timers, ключи,
бюджеты, реклама и автодеплой **не изменялись**. Провайдеры, SMS и платежи не
вызывались. [Пакет и порядок будущего подключения](../runbooks/web-switch-bootstrap.md).

## Что подготовлено

- Локальный сборщик восьми файлов с SHA256 и отдельным review manifest, без
  SSH/Docker/network/apply. Результат всегда `readyToApply=false`; production
  controller не принимает этот manifest как план.
- Явный V2: точные restart policies `old=no`, `new=unless-stopped`, retry 0.
  V1 сохранён. В первом canary образы и source SHA двух Web совпадают, container
  IDs/порты/IP различны. Контроллер не создаёт контейнеры и не меняет политики.
- Предложение API overlay, защита от параллельного Certbot/reload, сохранение
  Nginx symlink, возврат к каноническому runtime без переписывания receipts.
- CI отдельно репетирует V1 и V2; приложение и обычный publisher не меняются.

## Локальные проверки

| Проверка                           | Результат                                                          |
| ---------------------------------- | ------------------------------------------------------------------ |
| Контроллер                         | 41/41 PASS, включая прежний V1 и отрицательные RestartPolicy cases |
| Node container/release/preparation | 115/115 PASS, без пропусков                                        |
| Реальный Host V1 `87001c62516f`    | verify/switch/retire/replay PASS, 15 TLS-проб, 0 ошибок            |
| Реальный Host V2 `f5f7a8c3e01f`    | same-image цикл PASS, 12 TLS-проб, 0 ошибок                        |
| Полный Linux backup discovery      | 771/771 PASS, без ошибок и пропусков                               |

Оба whole-host стенда — одноразовый локальный Docker-in-Docker без внешней сети,
host mounts/socket/ports и credentials. Production `Host` не подменён; API
синтетический, PostgreSQL настоящий. SSE завершён, преждевременного SIGTERM нет,
старый Web получил SIGTERM один раз после drain; API/PG/job/new Web неизменны.
Все шесть ресурсов каждого стенда удалены с ownership-проверкой.

V1: максимальный промежуток завершения проб 140,57 мс; V2: 140,16 мс. Опрос 100 мс
проверяет выборочную доступность fixture, а не SLA или вместимость production VM.
V2 доказывает закреплённую restart policy и живой новый Web после retire;
перезагрузка Docker/сервера не выполнялась.

Хеши сохранённых receipts:

- V1: `7fb4d445859225322c2b3f1b23fe70ca9c2a8f4b46dc4ac19dc9dcc921e727ce`.
- V2: `9191aba18aa257e71e6b55018382c80b5a478465663542bc0d0631209c10f1d0`.
- Проверенный controller: `f8a4b865482915ac62356ec0d72b002b0d44d9a8c53d5413b7136243a86a26c2`.

Первый Node-прогон выявил отсутствие локального `pglite` в новой рабочей копии;
это не засчитывается как PASS. После подключения кешированных зависимостей
весь набор повторён с нуля: 115/115. Старые 765 Linux-тестов #190 не выдаются
за проверку изменённого V2.

Полный Linux discovery выполнен на snapshot текущих байтов, а не на чистом
archive старого main. Все 154 файла модулей backup и их support/fixture inputs
остались неизменны; во время прогона изменились только два новых Node-файла
`web-bootstrap-preparation.*`, которые этот Python discovery не исполняет.
Raw aggregate receipt сохранён с отказом на общий drift; отдельный scoped
receipt подтверждает 771/771 для неизменных Linux-зависимостей. Эти два Node-файла
проверены финальным отдельным прогоном 115/115. Расхождение не скрыто и не
выдаётся за полное совпадение всех 156 файлов snapshot.

SHA256 scoped receipt:
`961e0a18f8b8d1c46e8f777f61adffa38578ea11eb0140c8cae4cfc386b628d8`.
SHA256 Linux test log:
`c89bfc17915418caeda2f9046ae37a7783f0b33323a990ebfa4749fc64d8cb40`.
Тесты выполнялись network-none/read-only без host mounts/socket/ключей;
подписанный публичный systemd toolchain установлен только в одноразовом setup
контейнере. После тестов оба контейнера и tools image удалены и проверены по ID.

## Наблюдение сервера только для чтения

Снимок 9 ноября, 02:25 МСК получен через закреплённый SSH host key. Использованы
только ограниченные inspect/метаданные, память, пути и состояния служб. Содержимое
секретов, диалоги, БД и private TLS key не читались; `nginx -t/-T` и reload на
сервере не запускались. Скрипт передан по stdin без установки файла.

| Наблюдение            | Факт и ограничение                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Контейнеры            | 51: здоровые API/Web/PG, 48 остановленных jobs; image metadata ограничены 40 образами, общий статус **partial**              |
| Live source API/Web   | `5f0e58a00787e0d025c585aedbbd97957c204716`, соответствует canonical backup source; это не main a87c5cd                       |
| Restart               | API/Web `no`; PostgreSQL `unless-stopped`                                                                                    |
| Web-сеть              | `.10` Web, `.11` API; `.20` свободен, неизвестных подключённых peers нет                                                     |
| Доверенные прокси API | Только `.10/32`; для bootstrap нужна отдельная дельта `.20/32`                                                               |
| Память                | Всего около 3916 МиБ, доступно около 2849 МиБ, swap отсутствует; pressure memory avg10 = 0                                   |
| Диск                  | Около 8,18 ГиБ доступно; запас над backup floor 8 ГиБ лишь около 190 МиБ                                                     |
| Nginx/TLS             | Nginx 1.24.0, enabled site — symlink, Certbot live paths — symlinks; соответствие диска загруженной конфигурации не доказано |
| Timers                | Certbot и backup timers active; полнота renewal/reload triggers и boot ordering не проверены                                 |
| Автодеплой            | В наблюдённом public control metadata `enabled=false`; настройки не менялись                                                 |

Снимок не заменяет свежую полную инвентаризацию/backup/TLS/capacity перед
установкой. Он не является production-планом и не удостоверяет live-финансовые
операции. Исторические image labels сверх лимита не запрашивались. Ранний снимок
с ошибками Go template сохранён отдельно; nil-safe collector проверен девятью
тестами и повторным чтением, без сокрытия статуса partial.

Collector SHA256: `e284ab1bcbd6a60f0fac84a7ee415241cf32740a9c8c0305a79023cb516aff04`.
SHA256 полученных stdout-байтов:
`1a103ecfcd2d81951a4096bac3f1ccfb6e6236a91e97c0c5bb4cbfe879aa5a04`.

## Что пока не выполнено

Установка кода/overlay/ingress, fresh backup и restore, production-план с
новыми IDs/PID/starttime, автоматический installer и аварийный reconciliation,
проверка reboot и нагрузка на VM. Это условия отдельной операции, а не действия
этой подготовки. Первый bootstrap потребует короткого окна обслуживания API.
