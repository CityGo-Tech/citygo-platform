# CityGo Platform

Приватный monorepo платформы переезда. Рабочий Web-сценарий:
аккаунт → анкета → план → жилищный квест → AI-чат → завершение → +60 XP → следующий квест.

## Запуск с чистого клона

Нужны Node.js 24 LTS и pnpm 10.15.0. Docker для первого запуска не требуется.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Web: http://localhost:3000, API: http://localhost:4000.
Команда сама собирает общие пакеты и применяет миграции. Локальная база PGlite
(PostgreSQL в одном процессе) сохраняется в игнорируемой папке .local/database.

Для реальных ответов скопируйте .env.example в .env и задайте серверные
OPENAI_API_KEY и OPENAI_MODEL. Без ключа интерфейс сообщает, что AI не подключён;
выдуманных ответов в рабочем сервере нет. Никогда не коммитьте ключи.

Для PostgreSQL-сервера и настройки окружения см. [инструкцию запуска](docs/runbooks/local-development.md).

## Проверки

```sh
pnpm check
pnpm browser:install
pnpm test:e2e
pnpm mobile:export
```

check проверяет код, типы, тесты и Web/API-сборку. E2E использует отдельный
тестовый сервер и проверяет маршрут на desktop/mobile Web. Остановите dev перед
E2E: тесты используют те же порты. GitHub CI дополнительно запускает интеграционные
тесты на PostgreSQL 17. mobile:export создаёт Android/iOS JS-бандлы, не подписанные
приложения для магазинов.

## Состав

| Область                                   | Реализовано                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- |
| apps/web                                  | Next.js: вход, анкета, план, квесты, streaming-чат, XP, /admin   |
| apps/api                                  | Fastify: сессии, права доступа, сценарии, SSE, readiness         |
| apps/mobile                               | Expo: общие контракты/API, SecureStore, анкета, план, чат и XP   |
| apps/admin                                | React-пакет: закрытая сводка и очередь запросов помощи человека  |
| apps/worker                               | Идемпотентное обслуживание истёкших сессий и chat leases         |
| packages/contracts, domain                | Схемы обмена и правила переходов квеста                          |
| packages/db                               | PostgreSQL/PGlite, миграции, транзакции, пользовательский доступ |
| packages/agents, llm                      | OpenAI Responses API, пять специализаций, маршрутизация          |
| packages/design-tokens, ui-web, ui-native | Общие токены и компоненты                                        |
| packages/assets                           | Оптимизированные WebP и проверяемый манифест источников          |
| packages/api-client, content              | Общий API-клиент и контент квестов                               |
| packages/config, observability, testkit   | Настройки, безопасное логирование, тестовые фикстуры             |

Для мобильной разработки: [apps/mobile/README.md](apps/mobile/README.md).
Для служебной задачи: pnpm worker:once после сборки, только с серверным PostgreSQL.

## Что ещё требует подключения или проверки

- **Figma не синхронизирована:** интеграция исчерпала лимит Starter. Использован
  локальный CITYGO_THEME_PACK.md, источник отмечен в [статусе токенов](docs/design/token-status.md).
- **Live AI:** код готов к OpenAI; реальные ответы требуют серверного ключа,
  выбранной модели и оценки на реальных кейсах.
- **Живой риелтор:** запросы записываются, но не отправляются внешнему специалисту.
  Housing Navigator явно обозначен как AI.
- **Мобильный релиз:** необходима проверка на устройстве, подпись и выбор EAS/store-проекта.
- **Production:** сервер, домен, TLS, секреты, резервные копии и политика данных
  ещё не настроены. См. [границы безопасности](docs/security/implementation-boundaries.md)
  и [план развёртывания](docs/runbooks/production.md).

Этот PR — проверяемый MVP, не готовый публичный production-сервис.
