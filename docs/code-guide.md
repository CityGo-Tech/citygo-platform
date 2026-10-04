# Путеводитель по коду CityGo

Для разработчика, который впервые открыл репозиторий. Проверено по `main`
после PR #76, 4 октября 2026. Обзор системы — в [архитектуре](architecture.md),
поведение продукта — в [пользовательском сценарии](how-it-works.md),
нереализованные задачи — в [плане](roadmap.md).

Быстрые переходы: [где менять функцию](#2-где-менять-конкретную-функцию),
[запуск](#3-что-запускается), [API](#4-http-api-действующие-маршруты),
[данные](#6-данные-где-что-хранится), [AI](#7-ai-четыре-разных-уровня),
[тесты](#9-проверки-и-безопасное-изменение).

## 1. Как читать проект

Не нужно начинать с самого большого файла или всей истории коммитов.
Пройдите один запрос от экрана до БД:

1. [Главная страница Web](../apps/web/src/app/page.tsx) подключает
   [Journey](../apps/web/src/components/journey.tsx) — текущий путь пользователя.
2. [Общий клиент](../packages/api-client/src/index.ts) вызывает API;
   [transport](../packages/api-client/src/transport.ts) проверяет ответы,
   [SSE](../packages/api-client/src/sse.ts) — поток сообщений.
3. [Fastify-приложение](../apps/api/src/app.ts) проверяет сессию, входные данные,
   владельца и допуск, затем вызывает репозиторий или модель.
4. [Repository](../packages/db/src/repository.ts) выполняет SQL и транзакции;
   [подключение к БД](../packages/db/src/index.ts) выбирает PostgreSQL/PGlite.
5. [Контракты](../packages/contracts/src) задают проверяемый формат обмена;
   тесты рядом с исходниками показывают успешные и запрещённые случаи.

Имена workspace-пакетов начинаются с `@citygo/`. Импортируйте публичный интерфейс
пакета, а не исходник соседнего приложения по относительному пути.
Границы сборки определены в [workspace](../pnpm-workspace.yaml),
[Turbo](../turbo.json) и `package.json` каждого пакета.

## 2. Где менять конкретную функцию

| Задача                                        | Основные файлы                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Вход, анкета, план, карточки квестов, чат Web | [journey.tsx](../apps/web/src/components/journey.tsx), [questionnaire.tsx](../apps/web/src/components/questionnaire.tsx), [ai-access.tsx](../apps/web/src/components/ai-access.tsx)                                 |
| Страницы и общие стили                        | [app/](../apps/web/src/app), [layout.tsx](../apps/web/src/app/layout.tsx), [journey.css](../apps/web/src/app/journey.css)                                                                                           |
| Admin                                         | [Web-страница `/admin`](../apps/web/src/app/admin/page.tsx), [apps/admin/src](../apps/admin/src) — встраиваемый React-пакет, не отдельный сервер                                                                    |
| Экран телефона и переходы                     | [App.tsx](../apps/mobile/App.tsx), [flow.ts](../apps/mobile/src/flow.ts); запуск — [mobile README](../apps/mobile/README.md)                                                                                        |
| Правила состояния квеста                      | [domain](../packages/domain/src/index.ts); проверки владельца/плана — [quest-plans.ts](../packages/db/src/quest-plans.ts)                                                                                           |
| Чеклисты текущих квестов                      | [content](../packages/content/src/index.ts)                                                                                                                                                                         |
| Формат запросов/ответов                       | [contracts](../packages/contracts/src/index.ts), [responses.ts](../packages/contracts/src/responses.ts), [protocol.ts](../packages/contracts/src/protocol.ts)                                                       |
| API, сессии и пароль                          | [app.ts](../apps/api/src/app.ts), [auth.ts](../apps/api/src/auth.ts), [repository.ts](../packages/db/src/repository.ts)                                                                                             |
| Выбор роли помощника и его инструкции         | [agents/runtime.ts](../packages/agents/src/runtime.ts), [catalog.ts](../packages/agents/src/catalog.ts)                                                                                                             |
| Выбор провайдера и допуск вызова              | [provider.ts](../apps/api/src/provider.ts), [ai-control.ts](../apps/api/src/ai-control.ts), [ai-policy.ts](../apps/api/src/ai-policy.ts), [ai-production.ts](../apps/api/src/ai-production.ts)                      |
| Подключение модели и разбор потока            | [llm](../packages/llm/src), интерфейс [StreamingProvider](../packages/llm/src/provider.ts)                                                                                                                          |
| Денежные ограничения и баланс                 | [ai-budget.ts](../packages/db/src/ai-budget.ts), [ai-credit.ts](../packages/db/src/ai-credit.ts), [ai-credit-charges.ts](../packages/db/src/ai-credit-charges.ts), [API execution](../apps/api/src/ai-execution.ts) |
| Настройки и их безопасная передача            | [config](../packages/config/src/index.ts), [env.mjs](../scripts/env.mjs), [container-runtime.mjs](../scripts/container-runtime.mjs)                                                                                 |
| Завершение работы API при деплое              | [shutdown.ts](../apps/api/src/shutdown.ts), [runtime.ts](../apps/api/src/runtime.ts)                                                                                                                                |
| Фоновое обслуживание БД                       | [worker](../apps/worker/src/index.ts) — однократная maintenance-задача, не очередь писем                                                                                                                            |
| Компоненты, токены, персонажи                 | [ui-web](../packages/ui-web), [ui-native](../packages/ui-native), [design-tokens](../packages/design-tokens), [assets](../packages/assets)                                                                          |
| Сервер и выпуск                               | [deploy/](../deploy), [.github/workflows/](../.github/workflows), [руководство оператора](operations/server-handbook.md)                                                                                            |

Страница [`/design-system`](../apps/web/src/app/design-system/page.tsx) показывает
Web-компоненты. Изменять сгенерированные токены наугад не следует: источник,
mapping и порядок генерации описаны в [статусе дизайна](design/token-status.md).

## 3. Что запускается

### Разработка

`pnpm dev` → [scripts/run.mjs](../scripts/run.mjs):

1. Собирает общие `packages/*`.
2. Применяет миграции через отдельное окружение мигратора.
3. Запускает API и Web как два дочерних процесса с разными разрешёнными env.

API: [dev.ts](../apps/api/src/dev.ts) → [runtime.ts](../apps/api/src/runtime.ts)
→ проверка конфигурации → registry провайдеров → БД → `buildApp` → HTTP listener.
Локальная PGlite позволяет пройти первый запуск без Docker; она не предназначена
для нескольких API-процессов. Подробности — [локальный запуск](runbooks/local-development.md).

### Production

Контейнер входит через [container-runtime.mjs](../scripts/container-runtime.mjs).
API запускает [server.ts](../apps/api/src/server.ts); режим production задаётся
явно. Web — Next standalone. Образ `jobs` используется мигратором и worker.
На ВМ не выполняется `pnpm install` или сборка приложения.

`pnpm start` не заменяет миграцию: у root-launcher сборка общих пакетов и миграция
выполняются в режимах `dev`/`migrate`, а не `start`. В серверном выпуске миграция —
отдельная контролируемая стадия до запуска новой версии.

## 4. HTTP API: действующие маршруты

Источник маршрутов — [app.ts](../apps/api/src/app.ts). Ниже пути **самого API**.
Через Web перед ними добавляется `/api`: например,
`/v1/dashboard` → `/api/v1/dashboard`. Проксирование задаёт
[next.config.mjs](../apps/web/next.config.mjs); внутренний URL фиксируется при сборке.

| Метод и путь                         | Назначение                                        | Доступ                                 |
| ------------------------------------ | ------------------------------------------------- | -------------------------------------- |
| `GET /health`                        | Состояние процесса                                | Без входа                              |
| `GET /ready`                         | Доступ к БД и наличие требуемых миграций          | Без входа                              |
| `POST /v1/auth/register`             | Создать аккаунт и сессию                          | Без входа, rate limit                  |
| `POST /v1/auth/login`                | Проверить пароль, создать сессию                  | Без входа, rate limit                  |
| `POST /v1/auth/logout`               | Завершить переданную сессию                       | По cookie/bearer                       |
| `GET /v1/dashboard`                  | Профиль, план, квесты, XP, история и состояние AI | Своя сессия                            |
| `POST /v1/questionnaire`             | Сохранить первую анкету и создать план            | Своя сессия                            |
| `POST /v1/quests/:id/start`          | Начать доступный квест указанного плана           | Свой квест и актуальный план           |
| `POST /v1/quests/:id/complete`       | Завершить квест и начислить XP                    | Свой квест, план и критерии завершения |
| `POST /v1/threads/:id/messages`      | Отправить сообщение, получить SSE                 | Свой поток, AI-допуск и лимиты         |
| `POST /v1/ai/consent`                | Дать/отозвать согласие для политики               | Своя сессия                            |
| `GET /v1/ai/credit`                  | Прочитать личный AI-баланс                        | Своя сессия                            |
| `GET /v1/admin/overview`             | Сводка пользователей/XP и запросов к человеку     | Admin allowlist                        |
| `GET /v1/admin/ai`                   | Провайдеры, бюджет, аудит и попытки               | Admin allowlist                        |
| `POST /v1/admin/ai`                  | Изменить выбор провайдера с проверкой ревизии     | Admin allowlist                        |
| `POST /v1/admin/ai/budget`           | Изменить денежные ограничения                     | Admin allowlist                        |
| `POST /v1/admin/ai/credit/welcome`   | Однократно выдать пользователю бонус              | Admin allowlist                        |
| `POST /v1/admin/ai/credit/reconcile` | Сверить незавершённое списание RouterAI           | Admin allowlist                        |

Это карта, а не отдельная копия спецификации JSON: поля берите из импортируемых
Zod-схем в `contracts`, примеры — из [API-тестов](../apps/api/src/app.test.ts).
Наличие ID в теле не даёт права на чужую запись. Регистрация не делает пользователя
администратором и не выдаёт 500 ₽ автоматически.

Web использует HttpOnly cookie; native-клиент запрашивает сессию с
`x-citygo-client: native` и хранит bearer в SecureStore. Сессиями управляет
[клиентский session-модуль](../packages/api-client/src/session.ts),
проверкой — сервер. Токены и пароли нельзя включать в URL, логи или примеры PR.

Протокол сейчас версии `1`: `X-CityGo-Contract-Version`, `X-Request-Id`.
Ошибка содержит `error` и может включать `code`, `requestId`, `retryable`,
`currentVersion`. Клиенты без заголовка v1 поддерживаются для совместимого
обновления; другая major-версия не выбирается молча.
См. [совместимость и SSE](architecture/api-compatibility.md).

`/ready = ok` не проверяет доступность нейросети, качество ответа, баланс,
доставку писем или возможность восстановления резервной копии.

## 5. Как проходит основной сценарий

| Действие          | Что делает сервер                                                                                                      | Что не следует предполагать                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Сохранение анкеты | Записывает профиль/ответы, создаёт план и два user quest                                                               | Пока это старая полная анкета, не постепенный ввод R1                      |
| Старт квеста      | Проверяет владельца, план/версию и состояние; открывает чат                                                            | Чужой ID или старый план не разрешает команду                              |
| Сообщение         | Проверяет политику/согласие, резервирует lease и лимиты, маршрутизирует роль                                           | Названия tools в каталоге не означают настоящего поиска квартир            |
| Ответ модели      | Передаёт SSE, сохраняет завершение/историю, учитывает попытку и стоимость                                              | Обрыв соединения или EOF не равен полному ответу                           |
| Завершение        | Проверяет полный ответ Housing Navigator после старта; в транзакции завершает квест, начисляет XP, открывает следующий | Текущая проверка ещё не оценивает содержательную готовность брифа/чеклиста |

Нельзя автоматически повторять изменяющую команду после сетевой ошибки: сервер
мог успеть её выполнить. Для завершённого квеста повтор не даёт вторую награду.
Будущая защита награды независимо от пересоздания плана описана в CG-010.

Внешний модельный запрос не удерживает SQL-транзакцию всё время генерации.
История и chat lease — в БД; отмена, timeout, повтор модельной попытки и
сверка денег покрываются отдельными тестами API/LLM/DB.

## 6. Данные: где что хранится

Имена ниже — таблицы, не отдельные микросервисы. Поля, ключи и ограничения
смотрите в [миграциях](../packages/db/migrations). При чтении данных всегда
сохраняйте проверку владельца и используйте параметризованные запросы.

| Группа                         | Таблицы                                                                      | Для чего                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Аккаунт                        | `users`, `user_credentials`, `sessions`                                      | Пользователь, хеш пароля, серверные сессии                                      |
| Профиль                        | `relocation_profiles`, `questionnaire_answers`, `consent_events`             | Ответы и согласие обработки профиля                                             |
| План и награды                 | `relocation_plans`, `quests`, `user_quests`, `xp_events`                     | План, каталог/экземпляр квеста, журнал XP                                       |
| Диалог                         | `agent_threads`, `messages`, `chat_requests`, `agent_handoffs`               | Потоки, сообщения, запросы и передачи                                           |
| Допуск AI                      | `ai_consents`, `ai_routing`, `ai_usage_daily`, `ai_user_usage_daily`         | Политики, выбранный провайдер и квоты                                           |
| Модельные попытки              | `ai_model_attempts`, `ai_model_attempt_daily`, `ai_user_model_attempt_daily` | Каждая разрешённая попытка, в том числе повтор                                  |
| Общий денежный контроль        | `ai_budget`, `ai_budget_daily`                                               | Консервативное резервирование бюджета                                           |
| Личный баланс                  | `ai_credit_accounts`, `ai_credit_entries`, `ai_credit_charges`               | Бонус/операции, holds и подтверждённые списания                                 |
| Наблюдаемость                  | `analytics_events`, `audit_log`                                              | События приложения и аудит операций                                             |
| Основа для будущих результатов | `generated_artifacts`, `knowledge_sources`                                   | Исходные таблицы; не доказательство реализованного RAG или новых CG-010 ревизий |

Эволюция схемы: `0001` — основа; `0002` — работающий сценарий/сессии;
`0003–0005` — согласия, маршрутизация и попытки; `0006–0009` — бюджет и баланс;
`0010–0011` — принадлежность квеста плану и валидация связей. Уже применённые
миграции не переписываются: checksum проверяется при запуске мигратора.

API и мигратор используют разные роли PostgreSQL. Разрешения новой таблицы
проверяются также в [grants.sql](../deploy/postgres/grants.sql), а не только
в TypeScript. Изменение файла пароля не меняет пароль существующей DB-роли.

## 7. AI: четыре разных уровня

1. **Роль** — Housing Navigator и четыре других помощника. Сейчас маршрутизация
   детерминированная, по правилам в `agents/runtime.ts`, а не автономная команда
   агентов. [Подробности](agents/README.md).
2. **Провайдер/модель** — RouterAI, OpenAI или GigaChat. Адаптер реализует
   `StreamingProvider`; OpenAI — [stream.ts](../packages/llm/src/stream.ts),
   RouterAI — [routerai.ts](../packages/llm/src/routerai.ts),
   GigaChat — [gigachat.ts](../packages/llm/src/gigachat.ts).
3. **Право вызова** — конфигурация, политика получателя данных, согласие,
   production-допуск, квоты и денежные ограничения.
4. **Расчёт** — резервирование и подтверждённая стоимость не одно и то же.
   Личный баланс RouterAI списывается по проверенной стоимости провайдера.

Автоматического перехода между провайдерами нет. `LLM_PROVIDER=disabled`
отключает AI независимо от сохранённого выбора. В новой БД env задаёт начальный
выбор, затем маршрутизация хранится в БД. Значения модели и ключи не меняются
простым выбором роли помощника.

GigaChat production пока заблокирован; режим `routerai_at_cost` не поддерживает
списание прямых OpenAI/GigaChat. Не обходить блокировки dev-режимом или отключением
TLS. См. [провайдеры](runbooks/ai-providers.md),
[production-допуск](runbooks/routerai-production.md),
[баланс](runbooks/ai-credit-charging.md).

## 8. Как отличить подготовленный контракт от готовой функции

[housing.ts](../packages/contracts/src/housing.ts) описывает будущие жилищные
результаты R1: неизвестные/пропущенные данные, происхождение фактов, ревизии,
подтверждение и критерии. Его unit-тесты не означают наличие новых API/экранов/БД.
Хранение и команды — CG-012, интерфейс — CG-013, завершение/награда — CG-014.

Аналогично `allowedToolGroups` в каталоге агентов — декларация, не реализация
реального поиска жилья. `agent_handoffs` — сохранённое обращение, не готовый
операторский чат. Экспорт Expo — JS-бандл, не подписанный APK.
Полная граница готовности — [статус проекта](project-status.md).

## 9. Проверки и безопасное изменение

| Что проверяем                                  | Где искать тесты                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Контракты и правила                            | `packages/contracts/src/*.test.ts`, `packages/domain/src/index.test.ts`                                                                   |
| SQL, транзакции, миграции                      | `packages/db/src/*.test.ts`; CI дополнительно использует PostgreSQL                                                                       |
| Сессии, tenant-изоляция, бюджет, SSE, shutdown | `apps/api/src/*.test.ts`                                                                                                                  |
| Протокол клиента и native-сессия               | `packages/api-client/src/*.test.ts`, `apps/mobile/src/flow.test.mts`                                                                      |
| Провайдеры без живых ключей                    | `packages/llm/src/*.test.ts`, `packages/agents/src/*.test.ts`                                                                             |
| Браузерный сценарий                            | [e2e/](../e2e): relocation, session-isolation, api-resilience, admin-controls, journey-states, design-system                              |
| Изоляция env и запуск                          | [env.test.mjs](../scripts/env.test.mjs), [startup.test.mjs](../scripts/startup.test.mjs)                                                  |
| Контейнеры и выпуск                            | [scripts/](../scripts), [deploy/backup/test_*.py](../deploy/backup), workflow [Container smoke](../.github/workflows/container-smoke.yml) |

Обычный порядок изменения: контракт → сервер/БД → общий клиент → Web/Expo →
тесты → документация. Для схемы: новая миграция, grants, upgrade-тест и проверка
совместимости выпуска. Для env: схема config, allowlist launcher, примеры и тест
отсутствия секретов в клиентском bundle. Для инфраструктуры: отдельно проверить,
требуется ли обновление установленного root-контроллера оператором.

Команды проверки и правила PR — в [CONTRIBUTING](../CONTRIBUTING.md).
Не запускать тесты на production-БД, не подставлять реальные AI-ключи в CI и
не считать зелёный тест на TestProvider проверкой качества живой модели.
