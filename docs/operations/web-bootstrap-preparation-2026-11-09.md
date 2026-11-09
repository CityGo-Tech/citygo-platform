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

## Первоначальные локальные проверки

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

## Исправление GitHub rehearsal перед слиянием

На исходном head `dcdeb1f` CI и Container smoke действительно стартовали;
ошибка оплаты не блокировала их запуск. Web switch rehearsal
[42536844733](https://github.com/CityGo-Tech/citygo-platform/actions/runs/42536844733)
прошёл unit/сборку, но получил 403 при чтении старого чанка после retirement.
Артефакт `13639493835` сохранён с проверенным SHA256
`e9e63fb2da8d4bc083deb6d47a3cbc1ce3ab99141f256313a054142019e2c1d7`.
Журнал Nginx прямо указывает `Permission denied` на `/fixture/archive/...`.

Причина — Linux `mkdtemp` создаёт закрытый родительский каталог `0700`, который
был смонтирован как `/fixture`; непривилегированный worker не мог пройти к
public archive. Docker Desktop ранее не выявил эту разницу прав bind mount.
Исправлен только transport fixture: отдельный read-only mount `/archive`,
публичные каталоги `0755`/файлы `0644`, отказ от symlink/hardlink, явный
`user nginx`. Приватный родитель остаётся `0700`, ключи — `0600`.
Добавлены ранний GET с хешем и проверка фактических worker UID; прежние проверки
всех чанков после retirement, SSE/POST и отсутствия HTTP-повторов сохранены.

Новый Linux root-тест: 3/3 PASS без пропусков. Дочерний процесс сбрасывает
groups/UID/GID до 65534, читает public inode, но получает EACCES при обращении
через закрытый родитель и к ключу. Одноразовый контейнер удалён. Исправленный
полный transport `633ad5b6a3d0`: 788/788 запросов, 0 ошибок, 44 архивных файла,
оба worker UID 101, ранний hash probe PASS. Это cached Next-образ source
`42ecf835`, не вымышленная сборка нового head; сам fixture проверен по текущим
байтам. Исторический неуспешный результат не заменён успешным.

Повтор idle-regression `940bcfa303d3` также PASS: ожидаемый сброс только
непринятого reused GET при сравнении с нулевым minimum keep-alive, новый GET 200,
принятые POST/SSE завершены ровно один раз, HTTP retries 0. Сравнение с 5 с
остаётся только тестовым; production Nginx не менялся. Оба transport стенда
очищены по собственным container/network IDs. Финальный Node-набор после
исправления — 115/115; Linux permissions проверены отдельно 3/3 без skip.

Workflow теперь закрепляет PR head и сохраняет checkout/tree/event/run evidence.
V1 и V2 whole-host выполняются независимо от transport и друг от друга после
успешной проверки исходников; transport failure по-прежнему оставляет workflow
красным. `continue-on-error` не добавлен. Отдельный permissions step запускается
Linux root, поэтому отсутствие реальной UID-проверки не маскируется skip.
Backup/controller Python и приложение не менялись; сохранённые 771 Linux-тестов
относятся к их неизменным байтам, а исправленный transport проверяется отдельно.

## Совместимость тестового стенда с Linux runner и новой Node.js

В повторном GitHub run `42538216429` по `bfbed98` полный transport и Linux
permissions уже прошли. Обнаружены ещё две ошибки подготовки fixture, не Billing:

- Node 24.22.2 отбрасывает закрытый idle-сокет до назначения нового запроса.
  Тест безусловно требовал `reusedSocket=true` и старый ECONNRESET, хотя журнал
  доказывает один новый GET 200 на другом порту. Это соответствует
  [исправлению HTTP Agent/TLS в Node](https://github.com/nodejs/node/commit/96c3ccb1fc178bd425d7f4cb03ac67a053f24f57).
- Whole-host V1/V2 получили `protected-path` при проверке скопированного кода.
  Fixture закреплял mode, но не владельца. Production guard корректно отказал;
  его требования не менялись.

Idle-контроль теперь отдельно подтверждает либо legacy reset на том же сокете
без API admission, либо native pending-input переход `false → true`, уничтожение
старого сокета **до отправки** и единственный новый GET 200 с одним matching
admission. HTTP-повторов нет; неизвестные ошибки/дубли отклоняются. Сравнение
min5 требует прежний socket identity/порт, полный корректный ответ, один
admission и полный idle age меньше 5 секунд. Штатное `Connection: close` после
полного ответа допустимо; сохранение сокета после ответа не обещается.
Диагностика сохраняет Node version, socket states и admission до assertions.
Глобальный classifier непрерывных проб и production transport не изменены.

Перед импортом Host fixture проверяет ровно пять своих обычных файлов без
ссылок, выполняет обязательную проверку UID/GID 1001 и mode 0666, затем через
файловые дескрипторы устанавливает root:root/0644. Содержимое и SHA256 неизменны;
wrapper сравнивает весь proof с локальными исходниками. Операция ограничена
изолированным тестовым контейнером. `backup.py`, `web_switch.py` и assets-модуль
production не менялись и сохранили прежние строгие проверки.

Свежие whole-host V1 `a4ad950f661d` и V2 `8366d3e62a8e` PASS: соответственно
15 и 14 TLS-проб без ошибок, SSE/drain/retire/replay и все пять unsafe-to-root
file proofs подтверждены. Все 12 собственных ресурсов удалены с проверкой.
Receipts: `0ec926811b3783ccb2960c217b5bb79d80a7ab32a6526b2e98cb1feef2c90205`
и `299f206e6cdcca4216aa7d4150e2b6a3637837c6d6761112f2580f449e0c40d4`.

Финальный Node-набор — 119/119 без пропусков; Linux permissions отдельно 3/3
на текущих байтах fixture. Для сравнения client runtime локально подготовлена
официальная Node 24.22.2: SHA256 Windows binary
`1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9`
проверен по `nodejs.org`, подпись OpenJS Foundation — Valid. Глобальная Node
и настройки компьютера не менялись. Старые неуспешные артефакты сохранены;
771 Linux-тест относятся к неизменным production Python-модулям, а исправленные
fixture проверяются собственными физическими прогонами.

Финальные idle-прогоны текущего fixture: Node 24.11.1 `750132d9cec1` и
Node 24.22.2 `179b374182d5` PASS. Первый отдельно подтвердил legacy reset с
нулевым admission, второй — pre-send отказ от старого сокета и один GET 200
на новом соединении. В обоих min5 сохранил точный прежний сокет и полный ответ;
POST/SSE завершились один раз, retry 0. Ранние неуспешные повторы и два локальных
таймаута Docker network-create сохранены отдельно, не засчитаны как PASS.
Две поздно созданные пустые сети удалены только после проверки полных ID,
имён, labels и отсутствия endpoints; успешные повторы выполнены последовательно.

GitHub [Container smoke 42538216389](https://github.com/CityGo-Tech/citygo-platform/actions/runs/42538216389)
по `bfbed98` завершился **success**: backup/guards, production images и
loopback registry rehearsal пройдены. Последующие изменения ограничены
fixture/его тестами и этой записью; это не объявление GitHub checks будущего
head зелёными. Полный общий CI по указанию владельца не ожидается и Billing
не используется как объяснение реально выполненных тестовых сбоев.

Обычный transport на финальном fixture и Node 24.22.2 `4328c6feee61`:
`passed-with-idle-connection-closure`, 786 попыток. Зафиксирован один строго
классифицированный idle ECONNRESET непринятого probe GET в окне HUP; это
**не** утверждение «все запросы успешны». Свежих, принятых API и иных ошибок
нет; принятые POST/SSE завершены один раз, retry 0, все 44 чанка доступны.
Оба worker UID 101. Граница classifier не менялась.
Отсутствие 35 собственных container/network ресурсов успешных и промежуточных
неуспешных transport-прогонов дополнительно проверено точным Docker inspect.

## Что пока не выполнено

Установка кода/overlay/ingress, fresh backup и restore, production-план с
новыми IDs/PID/starttime, автоматический installer и аварийный reconciliation,
проверка reboot и нагрузка на VM. Это условия отдельной операции, а не действия
этой подготовки. Первый bootstrap потребует короткого окна обслуживания API.
