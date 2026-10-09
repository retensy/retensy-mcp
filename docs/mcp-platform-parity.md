# retensy-mcp ↔ платформа: паритет и доступ PAT

Состояние на 09.10.2026, ветка `bc/f-mcp` (от `feat/battery-completion`, 99 инструментов).
Источник фич платформы — контроллеры `backend/src/main/java/org/skiddgoddamn/controller/**` (retensy-bots
`feat/battery-completion`), доступ токена — `security/PatAuthFilter.java`.

Статусы: **есть** — инструмент покрывает фичу; **частично** — покрыта часть операций; **нет** — путь открыт для
PAT, инструмента нет; **PAT** — путь закрыт для токена (`PatAuthFilter`), нужен шаг владельца; **ждёт бэкенд** —
инструмент написан по контракту `docs/retensy-completion-plan.md` §1, эндпоинт делают агенты B/C/D в
`feat/battery-completion` (до деплоя — 404); **нет в платформе** — эндпоинта нет.

## 1. Таблица паритета

| Фича платформы | Эндпоинты (контроллер) | Инструменты MCP | Статус |
|---|---|---|---|
| Боты: список, подключение TG/MAX | `GET/POST /api/bots` (TgManagementController) | `list_bots`, `create_bot` | есть |
| Боты: веб-виджет | `POST /api/bots/web`, `GET /web/{id}/snippet` (WebWidgetController) | `create_bot {platform:"WEB"}`, `web_widget_snippet` | есть |
| Боты: стоп/запуск | `POST /api/bots/{id}/stop`, `/resume` | `bot_stop`, `bot_resume` | есть |
| Боты: удаление | `DELETE /api/bots/{id}` | `bot_delete` (новый, `confirm:true`) | есть |
| Боты: переименование, смена токена | `PATCH /api/bots/{id}`, `POST /{id}/token` | `create_bot` переименовывает только при создании | частично |
| Боты: совладельцы, приглашения, передача | BotCollaboratorController | — | PAT (закрыто намеренно, `isSharingPath`) |
| Настройки виджета | `GET/PUT /api/bots/web/{id}/settings` | `web_widget_settings` (новый) | есть |
| Графы/сценарии бота: CRUD, публикация, активный | TgGraphController | `list_graphs`, `get_graph`, `create_graph`, `update_graph`, `patch_graph`, `edit_graph_live`, `publish_graph`, `rename_graph`, `clone_graph`, `copy_graph`, `delete_graph`, `set_active_graph`, `import_funnel` | есть |
| Графы: шаблоны | `GET /api/bots/graph-templates`, `POST /{botId}/graphs/from-template` | `list_templates`, `create_graph_from_template` | есть |
| Графы: dry-run | `POST /api/bots/graphs/{id}/dry-run` | `dry_run` | есть |
| Графы: валидация без публикации, ИИ-помощник, граф из агента | `/validate`, `/ai-assist`, `/graphs/from-agent` | — (ошибки валидации отдаёт `publish_graph`) | нет |
| Аналитика графа | `GET /graphs/{id}/analytics` | `graph_analytics` | есть |
| Аналитика: UTM-источники, A/B | `GET /{botId}/utm-sources`, `/graphs/{id}/ab-results` | — | нет |
| Вебхук-сценарии: создать, URL+секрет, выходной бот, публикация, ротация секрета | `/api/scenarios/**` (ScenarioController) | — | **PAT** (G10, см. §2) |
| Вебхук-сценарии: правка тела графа | `PUT /api/bots/graphs/{id}` (автор — `requireWebhookScenarioAccess`) | `update_graph`, `patch_graph` | есть (если id известен) |
| База знаний: список, создание, документы, Q&A, текст, сайт, переиндексация, удаление документа | KnowledgeBaseController, KbDocActionsController | `kb_list`, `kb_create`, `kb_docs`, `kb_add_qa`, `kb_add_text`, `kb_add_site`, `kb_reindex`, `kb_delete_doc` | есть |
| База знаний: файл, удаление базы, правка/пересбор документа, поиск, история, правка Q&A | `docs/file`, `DELETE /kb/{id}`, `PATCH docs/{id}`, `recrawl`, `replace`, `search`, `history`, `PUT docs/{id}/qa` | — | нет |
| ИИ-агенты: CRUD, публикация, здоровье, песочница, неотвеченные | AiAgentController | `agent_list`, `agent_get`, `agent_create`, `agent_update`, `agent_publish`, `agent_health`, `agent_test_chat`, `agent_unanswered` | есть |
| ИИ-агенты: удаление, снятие с публикации, чек-лист, авто-проверки, аналитика, инсайты | `DELETE`, `/unpublish`, `/checklist`, `/checks*`, `/analytics`, `/insights` | — | нет |
| Сайты: CRUD, документ, публикация, откат, ассеты, схема, шаблоны, домены | SitePageController | `site_list`, `site_create`, `site_get`, `site_edit`, `site_schema`, `site_templates`, `site_publish`, `site_rollback`, `site_upload_asset`, `site_domains` | есть |
| Заявки сайта: список (фильтр `?status=`), настройки | `GET /pages/{id}/leads`, `GET/PUT /lead-settings` (SiteLeadController) | `site_leads` (с `status`), `site_lead_settings` | есть |
| Заявки сайта: статус NEW/IN_PROGRESS/DONE/REJECTED | `PATCH /api/bots/pages/{siteId}/leads/{leadId}` (409 — недопустимый переход) | `site_lead_status` (новый) | ждёт бэкенд (путь сверен с SiteLeadController) |
| Заявки сайта: прочитано, удаление, CSV | `POST /leads/read`, `DELETE /leads/{id}`, `GET /leads.csv` | — | нет |
| Подписчики: список, карточка | `GET /{botId}/users`, `/users/{chatId}` (TgBotUserController) | `list_bot_users`, `bot_user_get` | есть |
| Подписчики: метки и поля | `POST /{botId}/users/import` (добавляет метки, пишет только новые переменные) | `bot_users_import` (новый) | частично: снять метку / перезаписать поле — нет в платформе |
| Подписчики: удаление, неактивные, экспорт, сброс сессии | `POST /users/delete`, `/delete-inactive`, `GET /users/export`, `DELETE /{botId}/sessions/{chatId}` | — | нет |
| Диалоги: переписка, ответ оператора | `GET/POST /{botId}/users/{chatId}/messages` | `dialog_messages`, `dialog_reply` | есть |
| Передача оператору (handoff) | `POST /api/bots/{botId}/users/{chatId}/handoff {active}` (DialogReplyController; 409 `chat_busy`, 404 `chat_not_found`) | `dialog_handoff` (новый) | ждёт бэкенд (путь сверен) |
| Интеграции: каталог, статус, проверка | `/api/integrations/catalog`, `/{id}/status`, `/{id}/test` (точные пути в `isIntegrationCorePath`) | `integration_catalog`, `integration_status`, `integration_test` | есть |
| Интеграции: список, подключение, удаление, ingress-URL | `/api/bots/integrations/**` (алиас IntegrationConnectionController) | `list_integrations`, `connect_integration`, `disconnect_integration`, `integration_ingress_url` | есть |
| Интеграции: правка названия/ключей | `PUT /api/bots/integrations/{id}` | `integration_update` (новый) | есть |
| Интеграции: Google-аккаунты | `/api/bots/google/auth-url`, `/identities` | внутри `connect_integration` (GOOGLE_SHEETS) | частично (отвязка аккаунта — нет) |
| Журнал вызовов интеграций | `GET /api/bots/integrations/calls?connectionId=&ok=&limit=` (IntegrationConnectionController, ветка bc/b-actions) | `integration_calls` (новый) | ждёт бэкенд (путь и параметры сверены с bc/b-actions) |
| Прогоны/журналы: по подписчику | `GET /{botId}/users/{chatId}/runs` | `bot_user_runs` | есть |
| Прогоны/журналы: по боту, один прогон | `GET /api/bots/{botId}/runs`, `/api/bots/runs/{runId}` | `bot_runs` (новый) | есть |
| Расписания: повторяющиеся рассылки | `/api/bots/broadcasts/recurring` | `broadcast_recurring` | есть |
| Расписания: триггер сценария по cron | узел `TRIGGER_SCHEDULE` в графе (контракт 1.4, агент A) | через графовые инструменты | ждёт бэкенд (узел) |
| Рассылки: отправка, список, карточка, ошибки, отмена, превью, черновики, копия | TgBroadcastController, BroadcastDraftController | `broadcast_send`, `broadcast_list`, `broadcast_get`, `broadcast_cancel`, `broadcast_preview`, `broadcast_drafts`, `broadcast_duplicate` | есть |
| Каналы/группы бота, посты | `/{botId}/linked-chats`, `/linked-chats/{chatId}/post`; `/api/bots/{botId}/channels` | `list_channels`, `channel_post` | частично (добавить/убрать канал — нет) |
| Стартовые ссылки | `GET/POST /{botId}/links`, `DELETE /links/{id}` | `list_links` | частично (создать/удалить — нет) |
| Файлы (медиа) | `/api/bots/media` | `upload_file`, `list_files`, `delete_file` | есть |
| Статьи блога | `/api/articles/**` | `article_list`, `article_get`, `article_publish`, `article_update` | есть |
| Бронирование: календари, слоты, брони, отмена | `/api/bots/booking/calendars[/{id}[/slots\|/bookings[/{bookingId}/cancel]]]` (BookingController) | `booking_calendar_list`, `booking_calendar_get`, `booking_calendar_create`, `booking_calendar_update`, `booking_calendar_delete`, `booking_slots`, `booking_list`, `booking_create`, `booking_cancel` | ждёт бэкенд (пути сверены) |
| Платежи: приём оплат в сценарии | узлы графа + подключения касс (`connect_integration`), входящие — `/api/yookassa/owner/{id}` | графовые инструменты, `connect_integration` | есть (через граф) |
| Платежи: тариф и баланс конструктора | BotBuilderSubscriptionController (`/api/bots/plans`, `/subscription`, `/billing/topup`) | — (402 отдаёт ссылку на страницу тарифа) | нет, и не нужно: оплата — только в кабинете |
| «Требует внимания» (счётчики) | `GET /api/bots/attention` | — | нет |
| Отчёт MCP | `POST /api/mcp/report` | телеметрия сервера | есть |
| Instagram (growth), legacy-вебхуки `/api/webhooks`, дашборды `/api/dashboard`, `/api/projects` | — | — | вне продукта ботов / не PAT |

## 2. G10: доступ PAT к вебхук-сценариям

### Где фильтр
`backend/src/main/java/org/skiddgoddamn/security/PatAuthFilter.java`. Токен `zmcp_…` превращается в принципала
только если путь проходит `isTokenPath(path)` (префиксы `/api/bots`, `/api/tg`, `/api/articles`, `/api/mcp`, кроме
путей совладельцев/приглашений) или `isIntegrationCorePath(method, path)` (ровно `GET /api/integrations/catalog`,
`GET /api/integrations/{id}/status`, `POST /api/integrations/{id}/test`). Для остальных путей запрос остаётся
анонимным → 401 от цепочки. Скоупов у токена нет (`PersonalAccessToken`: id, owner, name, prefix, hash, даты,
`revoked`) — доступ определяется только этим списком путей.

### Что закрыто
1. **`/api/scenarios/**` целиком** (ScenarioController): `GET /api/scenarios`, `POST /api/scenarios`
   (создание вебхук-сценария: путь + секрет), `GET /api/scenarios/{id}` (единственное место, где автор читает
   секрет — бот-эндпоинты графа его вырезают, `withoutWebhookSecret`), `PUT /{id}/source` (выходной бот),
   `POST /{id}/publish` (активация вебхук-сценария; `set_active_graph` для него отдаёт 409),
   `POST /{id}/rotate-secret`. Итог: через MCP нельзя создать, опубликовать и получить URL+секрет вебхук-сценария
   (TASK-04, 10, 12, 16). Править тело уже созданного вебхук-сценария через `PUT /api/bots/graphs/{id}` можно.
2. **CRUD подключений — НЕ закрыт.** Аудит считал его закрытым, но IntegrationConnectionController смонтирован и на
   `/api/bots/integrations`, поэтому список/создание/правка/удаление/ingress-URL проходят по префиксу `/api/bots`, и
   MCP (`list_integrations`, `connect_integration`, `disconnect_integration`, `integration_ingress_url`, теперь
   `integration_update`) этим пользуется с 0.16. Закрыт только дубль `/api/integrations` без `bots`, а MCP его не
   вызывает. **Владельцу стоит это подтвердить:** комментарий в `PatAuthFilter.isIntegrationCorePath`
   («CRUD подключений остаётся только из сессии») с этим не сходится. Если доступ токена к ключам интеграций не
   задуман, закрывать надо алиас, и тогда `connect_integration` и связанные инструменты перестанут работать.

### Риски, если открыть `/api/scenarios`
- Утёкший токен сможет прочитать секреты всех вебхук-сценариев владельца и слать в них поддельные события. Сценарий
  может писать в CRM и отправлять сообщения через ботов владельца. Сегодня секреты токену недоступны, это
  единственный по-настоящему новый актив.
- `rotate-secret` чужими руками ломает рабочие интеграции (вебхуки перестанут проходить). Это тот же класс ущерба,
  что `delete_graph`/`bot_delete`, которые токену уже доступны.
- Создание/публикация расходуют лимит сценариев тарифа: 402 и `assertCanCreateScenario` остаются в силе.
- Утёкший токен уже правит и публикует бот-графы, шлёт рассылки, отвечает в диалогах и меняет ключи интеграций,
  так что прирост риска небольшой. Отзыв токена (`revoked`) закрывает всё сразу.

### Минимальное предложение (не внедрено)
Добавить в `PatAuthFilter` точный список методов и путей по образцу `isIntegrationCorePath`. Префикс не нужен, id
проверяется как UUID:

| Метод | Путь | Зачем |
|---|---|---|
| GET | `/api/scenarios` | список сценариев (найти вебхук-сценарий) |
| POST | `/api/scenarios` | создать (`source.type` WEBHOOK; BOT уже доступен через `/api/bots/{botId}/graphs`) |
| GET | `/api/scenarios/{uuid}` | URL-путь и секрет для настройки отправителя |
| PUT | `/api/scenarios/{uuid}/source` | выбрать выходного бота |
| POST | `/api/scenarios/{uuid}/publish` | опубликовать |
| POST | `/api/scenarios/{uuid}/rotate-secret` | по желанию владельца; без него при утечке секрета придётся идти в кабинет |

Название правила: `webhook-scenarios`, метод `isWebhookScenarioPath(method, path)`. Если позже у токенов появятся
скоупы, это будет скоуп `scenarios:webhook`. Тест — по образцу `PatIntegrationPathsTest`: перечисленные пары
проходят, а `DELETE /api/scenarios/{id}`, `/api/scenarios/../account`, не-UUID id и `/api/scenarios/{id}/anything`
не проходят.

Альтернатива одной строкой: добавить алиас `/api/bots/scenarios` в `@RequestMapping` ScenarioController, так же как
сделано для интеграций и журнала вызовов (контракт 1.2). Это проще, но открывает токену все текущие и будущие методы
контроллера сразу, поэтому рекомендую точный список.

После решения владельца MCP получит `webhook_scenario_create`, `webhook_scenario_get` (URL + секрет),
`webhook_scenario_bind_bot`, `webhook_scenario_publish` и `webhook_scenario_rotate_secret`. Тело графа правится
существующими `update_graph`/`patch_graph`.

## 3. Новые инструменты этой ветки

| Инструмент | Путь | Статус бэкенда |
|---|---|---|
| `integration_calls` | `GET /api/bots/integrations/calls?connectionId=&ok=&limit=` | требует бэкенд feat/battery-completion (сверено с bc/b-actions) |
| `dialog_handoff` | `POST /api/bots/{botId}/users/{chatId}/handoff {active}` | требует бэкенд feat/battery-completion (сверено) |
| `site_lead_status` | `PATCH /api/bots/pages/{siteId}/leads/{leadId} {status}` | требует бэкенд feat/battery-completion (сверено) |
| `integration_update` | `PUT /api/bots/integrations/{id}` | есть в проде |
| `web_widget_settings` | `GET/PUT /api/bots/web/{botId}/settings` | есть в проде |
| `bot_users_import` | `POST /api/bots/{botId}/users/import` | есть в проде |
| `bot_runs` | `GET /api/bots/{botId}/runs`, `GET /api/bots/runs/{runId}` | есть в проде |
| `bot_delete` | `DELETE /api/bots/{botId}` | есть в проде |
| `booking_calendar_list/get/create/update/delete` | `GET/POST /api/bots/booking/calendars`, `GET/PUT/DELETE /{id}` (PUT — целиком, MCP накладывает поля на текущий) | требует бэкенд feat/battery-completion |
| `booking_slots`, `booking_list` | `GET /{id}/slots?from&to&limit`, `GET /{id}/bookings?from` | требует бэкенд feat/battery-completion |
| `booking_create`, `booking_cancel` | `POST /{id}/bookings {slotAt,name,phone}` (409 — занят), `POST /{id}/bookings/{bookingId}/cancel` | требует бэкенд feat/battery-completion |

Плюс из PR #8: `web_widget_snippet`, `kb_list`, `kb_create`, `kb_delete_doc`, `bot_user_get`, `bot_user_runs`,
`dialog_messages`, `dialog_reply`, `create_bot` WEB, проверка UUID в `update_graph`/`edit_graph_live`/`import_funnel`.
