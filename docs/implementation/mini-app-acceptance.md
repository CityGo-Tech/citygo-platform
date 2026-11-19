# Приёмка мини-приложений CityGo

Мини-приложения используют общий аккаунт, API, план, переписку и историю операций CityGo. Сравнение выполнено по [прототипу Telegram и MAX][mini], [прототипу Web][web] и исходникам сценариев. [Гид Figma][figma-guide] показывает письма, SMS, ответы и платежи на примерах. В матрице указано, какие рабочие состояния проверять и где находится проверка.

Браузерные сценарии запускаются в desktop и mobile Chromium. Заглушка SDK подставляет данные запуска и действия платформы. Там, где важна запись, сквозной сценарий или отдельный тест проверяет локальный Fastify и тестовую БД. Результаты в разделе «Доказательства этапов» относятся к указанным SHA. Результаты объединённого прогона указываются в приёмочном PR.

| Сценарий                                           | Telegram                                                                                                                                                                                                                                                                                                                                                                                                          | MAX                                                                                                                                                                                                                                                                                                                                                                                                                                   | Web                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Гостевой запуск, выбор задачи и безопасный переход | Из [запуска][tg-launch] открывается [выбор задачи][tg-guest]. Проверить меню бота, разовый явный переход в CityGo с ключом задачи, отказ SDK, «Назад» и отсутствие аккаунта, ИИ, SMS и оплаты на гостевых шагах. [Гостевые тесты Telegram][tg-entry-test]                                                                                                                                                         | Из [запуска][max-launch] открывается [выбор задачи][max-guest]. Проверить тот же маршрут и переход через MAX Bridge, включая отказ инициализации. [Гостевые тесты MAX][max-entry-test]                                                                                                                                                                                                                                                | Прямой URL мини-аппа открывает гостевой просмотр без SDK. Переход к [входу Web][web-login] сохраняет выбранную задачу. Проверить, что URL содержит только допустимую задачу без контактных данных. [Гостевой тест][tg-entry-test], [браузерная оболочка][shell-test]                                                                       |
| Проверка данных запуска и повтор                   | Проверить подпись Telegram, свежесть, назначение, неоднозначные поля и повтор. Проверка запуска сама по себе возвращает назначение. Вход и привязка потребляют запуск атомарно. [Тесты проверки][launch-verification-test], [тест HTTP][launch-http-test], [тест привязки][link-api-test]                                                                                                                         | Та же проверка с адаптером MAX. Проверить числовой ID, обязательное поле `query_id` и отказ с подписью другого провайдера. [Тесты проверки][launch-verification-test], [тест HTTP][launch-http-test]                                                                                                                                                                                                                                  | Обычный вход через email и пароль. Проверка запуска мессенджера не нужна для Web-сессии. [Проверка доступа][link-api-test]                                                                                                                                                                                                                 |
| Регистрация, согласия и почта                      | [Регистрация][tg-register] с обязательным согласием и отдельным выбором рассылок, [код email][tg-email], возврат к той же задаче. Проверить сценарий после передачи в Web. [Тест регистрации по задаче][tg-entry-test], [регрессии согласий][consent-test]                                                                                                                                                        | [Регистрация][max-register] с теми же согласиями, [код email][max-email], возврат к задаче и отдельная привязка. [Браузерный сценарий аккаунта][account-test]                                                                                                                                                                                                                                                                         | [Регистрация][web-register] и [подтверждение почты][web-email]. Проверить обязательное согласие на сервере, необязательную рассылку, неверный/просроченный код и восстановление состояния после потери ответа. [Согласия][consent-test], [профиль и почта][web-account-test]                                                               |
| Повторный вход и восстановление пароля             | [Вход][tg-login], [восстановление][tg-reset], [просроченный вход][tg-expired]. Мини-апп переиспользует формы CityGo. Проверить повторный запуск и доступ после сброса. [Аккаунт][account-test], [восстановление пароля][reset-test]                                                                                                                                                                               | [Вход][max-login], [восстановление][max-reset], [просроченный вход][max-expired]. Повторить путь в клиенте MAX. [Аккаунт][account-test], [восстановление пароля][reset-test]                                                                                                                                                                                                                                                          | [Восстановление][web-reset]. Проверить срок кода, интервал повтора, возврат к форме входа и защиту при смене аккаунта в другой вкладке. [Регрессии восстановления][reset-test]                                                                                                                                                             |
| Привязка, отказ и выход                            | [Экран привязки][tg-bind]. Подтвердить владение CityGo и проверить подпись запуска перед записью, явно выбрать «Привязать», «Не сейчас» или смену аккаунта. Проверить повтор/гонку, отвязку, отзыв сессий и изоляцию черновика после смены владельца. [Аккаунт][account-test], [API][link-api-test]                                                                                                               | [Экран привязки][max-bind]. Тот же сценарий с идентификатором MAX. Телефон, имя и email из SDK не объединяют аккаунты. [Аккаунт][account-test], [API][link-api-test]                                                                                                                                                                                                                                                                  | Страница существующего аккаунта и общие согласия. Web-сессия остаётся отдельной при отзыве сессии мессенджера. [API привязки][link-api-test]                                                                                                                                                                                               |
| Навигация, размер и возвращение                    | [План][tg-plan], [диалоги][tg-dialogs], [каталог][tg-catalog], [профиль][tg-profile]. Проверить активную вкладку, «Назад», системное закрытие, безопасные отступы, прокрутку, 320 px, крупный шрифт и доступный редактор при имитации клавиатуры. [Тест оболочки][shell-test]                                                                                                                                     | [План][max-plan], [диалоги][max-dialogs], [каталог][max-catalog], [профиль][max-profile]. Проверить SDK Back, переход в каталог, возврат к задаче после закрытия. Текущий адаптер использует системное закрытие MAX. Проверку крупного шрифта, отступов и клавиатуры повторить на устройстве. [Тест оболочки][shell-test], [сценарий жилья][housing-test]                                                                             | Обычные [план][web-plan], [диалоги][web-dialogs], [Помощники][web-catalog], [профиль][web-profile]. Проверить Web-навигацию при переходе с гостевой страницы мини-аппа. [Браузерная оболочка][shell-test]                                                                                                                                  |
| Жильё: первая польза и сохранение                  | [Критерии][tg-housing], [стартовый план][tg-start]. Ввести один известный ориентир, оставить бюджет неизвестным, явно сохранить и открыть [результаты][tg-results] из «Плана». Проверить изменение критериев, версию и возврат к исходному диалогу. [Сквозной тест жилья][housing-test]                                                                                                                           | [Критерии][max-housing], [стартовый план][max-start], [результаты][max-results]. Открыть тот же сохранённый план из другой вкладки/после запуска из бота. [Сквозной тест жилья][housing-test]                                                                                                                                                                                                                                         | [Стартовый план][web-housing] и [результаты][web-results]. Проверить совместимость общих данных и изменения в другой вкладке; Web-библиотека результатов остаётся отдельным входом. [Жильё][housing-test], [библиотека][web-results-test]                                                                                                  |
| Чек-лист, первый платёж и версии                   | [Отдельный чек-лист][tg-checklist] с отмеченными пунктами и [проверкой полного первого платежа][tg-first-cost]. Перезагрузить, потерять ответ после записи, открыть свежую версию из другой вкладки и проверить отметку устаревания. [Сквозной тест жилья][housing-test], [API версий][housing-api-test]                                                                                                          | [Чек-лист][max-checklist] и [первый платёж][max-first-cost]. Проверить перенос выбранных пунктов при обновлении и повторное подтверждение расчёта платежа. [Сквозной тест жилья][housing-test], [API версий][housing-api-test]                                                                                                                                                                                                        | [Чек-лист][web-checklist]. Проверить сохранение, изменение и перечитывание после неопределённого результата. [Регрессии чек-листов][web-checklist-test]                                                                                                                                                                                    |
| Подтверждение результата и XP                      | [Подтверждение чек-листа][tg-confirm]. В текущем жилищном сценарии сохранение не даёт XP. Реализация однократной награды за точную ревизию и учёт ранее выданных XP остаются отдельным допуском. [Правила CG-010][housing-xp], [PR жилья][housing-pr]                                                                                                                                                             | [Подтверждение чек-листа][max-confirm]. То же общее ограничение. [Правила CG-010][housing-xp], [PR жилья][housing-pr]                                                                                                                                                                                                                                                                                                                 | Исторические правила квестов сохраняются. Перед вводом нового подтверждения сверить существующие начисления. [Правила CG-010][housing-xp]                                                                                                                                                                                                  |
| Диалог, контекст и результаты                      | [Каталог][tg-catalog] и [диалог][tg-chat]. Проверить историю, новый диалог, «Что помощники знают», явную передачу выбранного фрагмента, избранное, сохранение результата и [источники][tg-sources]. [Сценарии диалогов][chat-test]                                                                                                                                                                                | [Каталог][max-catalog], [диалог][max-chat] и [источники][max-sources]. Те же проверки с сохранённым контекстом текущего владельца. [Сценарии диалогов][chat-test]                                                                                                                                                                                                                                                                     | [Диалоги][web-dialogs], [память][web-context], [избранное][web-favorites], [источники][web-sources]. Проверить пользовательские данные и источники на обычном маршруте. [Контекст][context-test], [избранное][favorites-test], [источники][sources-test]                                                                                   |
| PDF, TXT и редактор                                | [Вложение][tg-attachment]. Предпросмотр PDF/TXT, удаление вложения, неподдерживаемый формат, ввод 100 000 символов и видимость редактора при уменьшении viewport уже имеют браузерный сценарий Telegram. [Сценарии диалогов][chat-test]                                                                                                                                                                           | [Вложение][max-attachment]. Общий компонент использует тот же API. Повторить полный сценарий предпросмотра и клавиатуры на устройстве MAX. [Сценарии диалогов][chat-test]                                                                                                                                                                                                                                                             | [Вложение][web-attachment]. Проверить предпросмотр, доступность управления файлом и ошибки вложения. [Регрессии PDF][web-pdf-test]                                                                                                                                                                                                         |
| Три режима и восстановление отправки               | [Режим работы][tg-modes], [прерванный ответ][tg-interrupted]. Детерминированные ответы в «Максимуме», «Балансе» и «Минимуме»; при остановке/потере сети сверить состояние и повторить только отсутствующий запрос с тем же UUID. Платная отправка закрыта. [Сценарии диалогов][chat-test], [PR диалогов][chat-pr]                                                                                                 | [Режим работы][max-modes], [прерванный ответ][max-interrupted]. То же ограничение платной отправки. Проверить маршрут после повторного открытия в MAX. [Сценарии диалогов][chat-test], [PR диалогов][chat-pr]                                                                                                                                                                                                                         | [Переключатель][web-mode]. Три режима и действующие тарифы: ×10 за успешный ответ «Максимума»/«Баланса», 3 ₽ за успешный «Минимум», постоплата без удержания перед ответом. Проверить, что отключение платных маршрутов мессенджеров не влияет на Web. [Тесты режимов][mode-test], [тесты готовности][credit-test], [PR диалогов][chat-pr] |
| Профиль, история, чеки и правила                   | [Профиль][tg-profile], [баланс][tg-wallet]. Проверить свой статус email и телефона, баланс, историю, «Чеки» и правовые документы. [Тест профиля][profile-test], [тест оболочки][shell-test]                                                                                                                                                                                                                       | [Профиль][max-profile], [баланс][max-wallet]. Проверить статус телефона, операции и документы. Показать уже начисленные операции из Web. [Тест профиля][profile-test], [тест оболочки][shell-test]                                                                                                                                                                                                                                    | [Профиль][web-profile], [баланс][web-wallet], [правовые сведения][web-legal]. Проверить доступ только к своим операциям и чекам. [Профиль][web-account-test], [история][web-history-test], [чеки][web-receipts-test]                                                                                                                       |
| SMS и подарок 500 ₽                                | [Ввод номера][tg-phone], [ввод кода][tg-otp], [начисление][tg-gift]. Проверить явную отправку, срок и паузу повтора, неверный код, занятый номер, уже выданный подарок и потерянный ответ. Сервер подтверждает статус и одну запись +500 ₽. [Профиль][profile-test], [API телефона][phone-api-test]                                                                                                               | [Телефон][max-phone] и [подарок][max-gift] показаны в Figma. Текущая реализация показывает статус, а SMS и предложение акции закрыты до согласования MAX. Проверить отсутствие активных действий и наличие ранее начисленного подарка в общей истории. [Профиль][profile-test], [API телефона][phone-api-test]                                                                                                                        | Существующее подтверждение и та же запись +500 ₽. Проверить занятый номер, истёкший код, лимиты, единое начисление между клиентами и статус после потерянного ответа. [Браузерный тест SMS][web-phone-test], [API телефона][phone-api-test]                                                                                                |
| Поддержка и конфиденциальность                     | [Обращение][tg-help] и [сохранение][tg-help-saved]. Создать, потерять ответ, перечитать, увидеть статус, ответ и отметку о прочтении. Убедиться в отсутствии передачи переписки, телефона, кода и вложений в Метрику. [Сквозная поддержка][support-test], [профиль][profile-test]                                                                                                                                 | [Обращение][max-help] и [сохранение][max-help-saved]. Тот же тест с локальным API и сменой статуса администратором. Метрика/Вебвизор закрыты в мини-аппе. [Сквозная поддержка][support-test]                                                                                                                                                                                                                                          | [Обращение][web-help] и [сохранение][web-help-saved]. Проверить состояние и ответ. Обычная разрешённая аналитика использует события из списка и маскирует приватные данные. [Ответы поддержки][web-support-test], [аналитика][analytics-test]                                                                                              |
| Оплата, возврат и сверка                           | Stars покрывает тестовый 1 XTR в отдельном контуре. Проверить явный checkout, отсутствие зачисления по callback SDK, серверную выдачу/возврат при закрытом мини-аппе, повторы, отмену и `/paysupport`. В Figma для Telegram есть [кошелёк][tg-wallet]. Оплата цифровых услуг рублёвым Web-балансом внутри Telegram требует отдельного решения. [PR Stars][stars-pr]                                               | [Выбор суммы][max-topup], [переход][max-pay], [ожидание][max-pay-pending], [результат][max-pay-success], [пример чека][max-receipt]. Проверить явное открытие страницы, отсутствие зачисления по возврату, отмену, чужой заказ, дубли уведомлений и зачёт после проверенного статуса на сервере, независимый статус чека и однократный возврат. [Сквозная проверка MAX][max-payment-test], [границы тестовой оплаты][max-payment-doc] | [Баланс][web-wallet]. Действующие пополнение и чеки ЮKassa, история и возвраты. Проверить, что раздельные тестовые маршруты мессенджеров оставляют рублёвые Web-операции и привилегии в их прежней области. [Пополнение][web-topup-test], [чеки][web-receipts-test], [серверные возвраты][refund-api-test]                                 |
| Анонимная воронка                                  | Проверить `launch` и `task_selected` на гостевом экране без аккаунта и платных операций. Сервер считает `sign_in_confirmed` после подтверждённой сессии Telegram, `step_saved` после сохранения новой версии плана/чек-листа, `answer_succeeded` после завершённого ответа тестового ИИ, `payment_confirmed` после подтверждённого тестового Stars. Проверить, что повтор команды не добавляет серверное событие. | Те же события с отдельными итогами MAX. Переход во внешнее окно и возврат из него не считаются `payment_confirmed`. Сервер пишет это событие после одного подтверждённого тестового зачисления. Проверить отсутствие контактов, токенов, идентификаторов заказов, содержимого сообщений и вложений в событиях.                                                                                                                        | Действующие счётчики Web используются отдельно. Проверить, что обычный браузер не пишет события мини-аппа. Не отправлять события в Метрику из мини-аппов; учитывать `DNT` и `Sec-GPC`.                                                                                                                                                     |

## Доказательства этапов

Приведены результаты из PR на соответствующих этапах. PR с зависимыми ветками могут повторно запускать одни и те же тесты.

| Этап                       | Проверенный SHA и результат                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Гостевые оболочки          | `85e7495` Telegram — 20/20. `6375d19` Telegram + MAX — 30/30 целевых. [PR #200][tg-pr], [PR #201][max-pr]                                                                                                                 |
| Серверная проверка запуска | `a0d62e0` — 17/17 новых тестов на синтетических ключах, API 825/825 в локальном Linux-прогоне. [PR #208][verification-pr]                                                                                                 |
| Аккаунт и оболочка         | `d18d49d`, `f15e81b`. В PR зафиксированы отдельно этапные браузерные проверки аккаунта, регрессии обычного Web и проверки итогового стека. [PR #209][access-pr], [PR #211][shell-pr]                                      |
| Жилищный сценарий          | `49de2f3` — 46 браузерных проверок, включая реальный локальный API, потерянный ответ после записи и повторный запуск. [PR #212][housing-pr]                                                                               |
| Диалоги                    | `d681836` — 12 целевых и 116/116 в более широком браузерном прогоне, отдельные тесты API трёх режимов на детерминированных адаптерах. [PR #213][chat-pr]                                                                  |
| Профиль, SMS и поддержка   | `3e8c712` — 72/72 браузерных проверок и 20/20 тестов API телефона с заглушкой доставки. [PR #214][profile-pr]                                                                                                             |
| Telegram Stars             | `b0e375b` — 70/70 браузерных и 6 серверных проверок, включая оплату и возврат при закрытом мини-аппе. [PR #215][stars-pr]                                                                                                 |
| MAX ЮKassa                 | `d6dbd14` — 2/2 целевых браузерных, 76/76 браузерных регрессий и 86/86 целевых серверных. Синтетический HTTP-транспорт проверяет существующие заказы, очередь уведомлений, проводки и возвраты. [PR #216][max-payment-pr] |

Объединённый прогон проверяет воронку в [API][funnel-api-test] и [браузере][funnel-browser-test]. Гостевые события дают анонимные счётчики действий. Сохранения плана и чек-листа относятся к платформе по типу серверной сессии. Вход по email без привязки входит в обычный сценарий CityGo, а отдельный счётчик подтверждённого входа мини-приложения учитывает сессии, выданные после проверки подписи мессенджера. `DNT` и `Sec-GPC` учитываются в запросах браузера. Подтверждение синтетического платежа приходит от тестового провайдера и учитывается как отдельное серверное событие.

Числа в таблице выше относятся к своим веткам. Точный SHA приёмки и результаты объединённого прогона доступны в [PR #217][acceptance-pr].

## Порядок зависимостей

База `main` — `659e665c0f4435928c637417c1e4194be3410c3a`. [PR #208][verification-pr] независим от #200–201. Для #209 нужны оба результата. После общей цепочки до #214 ветки Stars и MAX-оплаты независимы. Проверяем приёмочную ветку поверх обеих.

| PR                      | Зависимости | Удалённый SHA                              |
| ----------------------- | ----------- | ------------------------------------------ |
| [#200][tg-pr]           | `main`      | `85e749577287bfc29668fd244171fa7fbee0c2b0` |
| [#201][max-pr]          | #200        | `6375d19a714c394335335ff94930d7c22f6a34af` |
| [#208][verification-pr] | `main`      | `a0d62e0d626d887a4cd5c64fdf8fd8dd5a83f604` |
| [#209][access-pr]       | #201 и #208 | `d18d49d8b269da7651db7887c7a3347e19911032` |
| [#211][shell-pr]        | #209        | `f15e81bf8d4958e687fc2fa18d477634b996c318` |
| [#212][housing-pr]      | #211        | `49de2f31db9f31c5cf8a875734fbb47b86afff25` |
| [#213][chat-pr]         | #212        | `d681836f53050e6da036338afd10e4bf5895c4b8` |
| [#214][profile-pr]      | #213        | `3e8c712762827e4e7936f3b08ba5a6565438664e` |
| [#215][stars-pr]        | #214        | `b0e375b62940a0d588eb74608718b21195988069` |
| [#216][max-payment-pr]  | #214        | `d6dbd14236bba208ad1b28ddd6d723ed0187221c` |

## Приёмка на устройствах и выпуск

- Пройти путь в Telegram и MAX на Android и iOS с тестовыми ботами: запуск, системные «Назад»/«Закрыть», клавиатура, крупный шрифт, отступы платформы, сеть и повторный вход. Ширину 320 px и изменения высоты браузер уже имитирует. Для встроенных Web-версий мессенджеров нужна отдельная проверка допустимых источников iframe. [Шаги обычного браузера и границы устройств][shell-pr]
- Для внешней интеграции отдельно подтвердить доступность тестовых ботов и настроек запуска. Реальная доставка email/SMS, платежи, фискализация и запросы к ИИ не входят в локальную приёмку. [Привязка и границы выпуска][access-doc], [тестовый MAX][max-payment-doc]
- До коммерческого включения нужны решение о цифровом продукте и фискализации Stars, согласование канала MAX с площадкой и ЮKassa и согласование акции MAX. Тестовый XTR не участвует в рублёвом кошельке. [Условия Stars][stars-pr], [условия MAX][max-payment-doc]

[mini]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=4-2
[figma-guide]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=7-1831
[web]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-6
[tg-launch]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=4-21
[tg-guest]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=4-42
[max-launch]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=4-73
[max-guest]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=4-94
[tg-register]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-176
[tg-email]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-252
[tg-login]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-298
[tg-reset]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-354
[tg-bind]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-397
[tg-expired]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-442
[max-register]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-608
[max-email]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-684
[max-login]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-730
[max-reset]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-786
[max-bind]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-829
[max-expired]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-874
[tg-housing]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-896
[tg-start]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-956
[tg-plan]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-1088
[tg-results]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-1139
[tg-first-cost]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-1184
[tg-checklist]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-1232
[tg-confirm]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-1848
[max-housing]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-1931
[max-start]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-1991
[max-plan]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-2123
[max-results]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-2174
[max-first-cost]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-2219
[max-checklist]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-2267
[max-confirm]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-2883
[tg-dialogs]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-2966
[tg-catalog]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-3018
[tg-chat]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-3092
[tg-modes]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-3454
[tg-attachment]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-3481
[tg-sources]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-3901
[tg-interrupted]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-3988
[max-dialogs]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-4034
[max-catalog]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-4086
[max-chat]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-4160
[max-modes]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-4522
[max-attachment]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-4549
[max-sources]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-4969
[max-interrupted]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5056
[tg-profile]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5102
[tg-phone]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5150
[tg-otp]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5173
[tg-gift]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5197
[tg-wallet]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5262
[tg-help]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5309
[tg-help-saved]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5331
[max-profile]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5509
[max-phone]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5557
[max-gift]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5604
[max-wallet]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5669
[max-topup]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5715
[max-pay]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5769
[max-pay-pending]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5794
[max-pay-success]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5817
[max-receipt]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-5863
[max-help]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-6162
[max-help-saved]: https://www.figma.com/design/xnlvdm113tfcHbZO5bekdg?node-id=5-6184
[web-login]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-7
[web-register]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-8
[web-email]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-9
[web-reset]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-10
[web-context]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-20
[web-plan]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-24
[web-dialogs]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-26
[web-catalog]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-27
[web-results]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-28
[web-housing]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-34
[web-checklist]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-37
[web-profile]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-64
[web-wallet]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-65
[web-legal]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-69
[web-help]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-72
[web-help-saved]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-73
[web-attachment]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-80
[web-sources]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=6-82
[web-mode]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=41-4293
[web-favorites]: https://www.figma.com/design/6pAycf8MPlTyddwYPH6NEL?node-id=65-5317
[tg-entry-test]: ../../e2e/telegram-mini-app.spec.ts
[max-entry-test]: ../../e2e/max-mini-app.spec.ts
[launch-verification-test]: ../../apps/api/src/mini-app-launch/verify.test.ts
[launch-http-test]: ../../apps/api/src/mini-app-launch/http.test.ts
[link-api-test]: ../../apps/api/src/mini-app-launch/account.test.ts
[shell-test]: ../../e2e/mini-app-authorized-shell.spec.ts
[consent-test]: ../../e2e/service-consents.spec.ts
[account-test]: ../../e2e/messenger-account-access.spec.ts
[web-account-test]: ../../e2e/account-profile.spec.ts
[reset-test]: ../../e2e/password-recovery.spec.ts
[housing-test]: ../../e2e/mini-app-housing.spec.ts
[housing-api-test]: ../../apps/api/src/housing-workspace.test.ts
[web-results-test]: ../../e2e/results-library.spec.ts
[web-checklist-test]: ../../e2e/plan-checklist.spec.ts
[chat-test]: ../../e2e/mini-app-conversations.spec.ts
[context-test]: ../../e2e/assistant-context.spec.ts
[favorites-test]: ../../e2e/message-favorites.spec.ts
[sources-test]: ../../e2e/message-sources.spec.ts
[web-pdf-test]: ../../e2e/pdf-material-preview.spec.ts
[mode-test]: ../../e2e/ai-modes.spec.ts
[credit-test]: ../../e2e/chat-credit-readiness.spec.ts
[profile-test]: ../../e2e/mini-app-profile.spec.ts
[web-history-test]: ../../e2e/balance-history.spec.ts
[web-receipts-test]: ../../e2e/owner-receipts.spec.ts
[phone-api-test]: ../../apps/api/src/phone-verification.test.ts
[web-phone-test]: ../../e2e/phone-verification.spec.ts
[support-test]: ../../e2e/mini-app-support.spec.ts
[web-support-test]: ../../e2e/human-support-replies.spec.ts
[analytics-test]: ../../e2e/product-analytics.spec.ts
[max-payment-test]: ../../e2e-max-payments/max-yookassa.spec.ts
[web-topup-test]: ../../e2e/test-topup.spec.ts
[refund-api-test]: ../../apps/api/src/payment-receipt-refunds.test.ts
[housing-xp]: cg-010-housing-criteria.md
[access-doc]: mini-app-account-access.md
[max-payment-doc]: max-yookassa-test.md
[tg-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/200
[max-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/201
[verification-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/208
[access-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/209
[shell-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/211
[housing-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/212
[chat-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/213
[profile-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/214
[stars-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/215
[max-payment-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/216
[acceptance-pr]: https://github.com/CityGo-Tech/citygo-platform/pull/217
[funnel-api-test]: ../../apps/api/src/mini-app-funnel.test.ts
[funnel-browser-test]: ../../e2e/mini-app-funnel.spec.ts
