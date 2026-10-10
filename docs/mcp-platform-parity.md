# retensy-mcp ↔ платформа: паритет и доступ PAT

Состояние на 10.10.2026: retensy-bots `master` (dfa58a81), retensy-mcp ветка `feat/mcp-parity-2` (117 инструментов;
в npm — 0.19.0, 100 инструментов). Источник фич платформы — контроллеры
`backend/src/main/java/org/skiddgoddamn/controller/**`, доступ токена — `security/PatAuthFilter.java`
(`isTokenPath`: всё под `/api/bots/**` и `/api/tg/**`, кроме сегментов совладельцев/приглашений).

Статусы: **есть** — инструмент покрывает фичу; **частично** — покрыта часть операций; **нет** — путь открыт для
PAT, инструмента нет; **PAT** — путь закрыт для токена (`PatAuthFilter`), нужен шаг владельца; **нет в платформе** —
эндпоинта нет. «Новый» — инструмент из `feat/mcp-parity-2`, до выхода следующей версии пакета есть только в
ветке. Всё, что раньше было «ждёт бэкенд» (`feat/battery-completion`), смержено в `master` (PR #63).

## 1. Таблица паритета

| Фича платформы | Эндпоинты (контроллер) | Инструменты MCP | Статус |
|---|---|---|---|
| Боты: список, подключение TG/MAX | `GET/POST /api/bots` (TgManagementController) | `list_bots`, `create_bot` | есть |
| Боты: веб-виджет | `POST /api/bots/web`, `GET /web/{id}/snippet` (WebWidgetController) | `create_bot {platform:"WEB"}`, `web_widget_snippet` | есть |
| Боты: стоп/запуск | `POST /api/bots/{id}/stop`, `/resume` | `bot_stop`, `bot_resume` | есть |
| Боты: удаление | `DELETE /api/bots/{id}` | `bot_delete` (`confirm:true`) | есть |
| Боты: переименование, смена токена | `PATCH /api/bots/{id}` (TgManagementController:137), `POST /api/bots/{id}/token` (:150) | `bot_rename`, `bot_change_token` (новые) | есть |
| Боты: дополнительные Telegram-боты (мультиканальность) | `GET/POST /api/bots/{botId}/channels`, `DELETE /{botId}/channels/{channelId}` (ChannelController:37/47/60) | `bot_channel_list`, `bot_channel_add`, `bot_channel_delete` (новые, удаление — `confirm:true`) | есть |
| Боты: совладельцы, приглашения, передача | BotCollaboratorController | — | PAT (закрыто намеренно, `isSharingPath`) |
| Настройки виджета | `GET/PUT /api/bots/web/{id}/settings` | `web_widget_settings` | есть |
| Графы/сценарии бота: CRUD, публикация, активный | TgGraphController | `list_graphs`, `get_graph`, `create_graph`, `update_graph`, `patch_graph`, `edit_graph_live`, `publish_graph`, `rename_graph`, `clone_graph`, `copy_graph`, `delete_graph`, `set_active_graph`, `import_funnel` | есть |
| Графы: шаблоны | `GET /api/bots/graph-templates`, `POST /{botId}/graphs/from-template` | `list_templates`, `create_graph_from_template` | есть |
| Графы: dry-run | `POST /api/bots/graphs/{id}/dry-run` | `dry_run` | есть |
| Графы: валидация без публикации, ИИ-помощник, граф из агента | `/validate`, `/ai-assist`, `/graphs/from-agent` | — (ошибки валидации отдаёт `publish_graph`) | нет |
| Аналитика графа | `GET /graphs/{id}/analytics` | `graph_analytics` | есть |
| Аналитика: UTM-источники, A/B | `GET /api/bots/{botId}/utm-sources` (TgAnalyticsController:50), `GET /api/bots/graphs/{id}/ab-results?branchNodeId&period` (:58) | `utm_sources`, `ab_results` (новые) | есть |
| Вебхук-сценарии: создать, URL+секрет, выходной бот, публикация, ротация секрета | `/api/scenarios/**` (ScenarioController) | — | **PAT** (G10, см. §2) |
| Вебхук-сценарии: правка тела графа | `PUT /api/bots/graphs/{id}` (автор — `requireWebhookScenarioAccess`) | `update_graph`, `patch_graph` | есть (если id известен) |
| База знаний: список, создание, документы, Q&A, текст, сайт, переиндексация, удаление документа | KnowledgeBaseController, KbDocActionsController | `kb_list`, `kb_create`, `kb_docs`, `kb_add_qa`, `kb_add_text`, `kb_add_site`, `kb_reindex`, `kb_delete_doc` | есть |
| База знаний: удаление базы | `DELETE /api/bots/kb/{kbId}` (KnowledgeBaseController:212; 409 `KB_OWNED_BY_AGENT`) | `kb_delete` (новый, `confirm:true`) | есть |
| База знаний: файл, правка/пересбор документа, поиск, история, правка Q&A | `docs/file`, `PATCH docs/{id}`, `recrawl`, `replace`, `search`, `history`, `PUT docs/{id}/qa` | — | нет |
| ИИ-агенты: CRUD, публикация, здоровье, песочница, неотвеченные | AiAgentController | `agent_list`, `agent_get`, `agent_create`, `agent_update`, `agent_publish`, `agent_health`, `agent_test_chat`, `agent_unanswered` | есть |
| ИИ-агенты: удаление, снятие с публикации | `DELETE /api/bots/agents/{id}` (AiAgentController:140; 409 `AGENT_IN_USE`), `POST /{id}/unpublish` (:193) | `agent_delete` (новый, `confirm:true`), `agent_unpublish` (новый) | есть |
| ИИ-агенты: чек-лист, авто-проверки, аналитика, инсайты | `/checklist`, `/checks*`, `/analytics`, `/insights` | — | нет |
| Сайты: CRUD, документ, публикация, откат, ассеты, схема, шаблоны, домены | SitePageController | `site_list`, `site_create`, `site_get`, `site_edit`, `site_schema`, `site_templates`, `site_publish`, `site_rollback`, `site_upload_asset`, `site_domains` | есть |
| Заявки сайта: список (фильтр `?status=`), настройки | `GET /pages/{id}/leads`, `GET/PUT /lead-settings` (SiteLeadController) | `site_leads` (с `status`), `site_lead_settings` | есть |
| Заявки сайта: статус NEW/IN_PROGRESS/DONE/REJECTED | `PATCH /api/bots/pages/{siteId}/leads/{leadId}` (409 — недопустимый переход) | `site_lead_status` | есть |
| Заявки сайта: прочитано, удаление, CSV | `POST /api/bots/pages/{id}/leads/read` (SiteLeadController:72), `DELETE /leads/{leadId}` (:88), `GET /leads.csv` (:94) | `site_leads_mark_read`, `site_lead_delete` (`confirm:true`), `site_leads_export` (`savePath?`) — новые | есть |
| Подписчики: список, карточка | `GET /{botId}/users`, `/users/{chatId}` (TgBotUserController) | `list_bot_users`, `bot_user_get` | есть |
| Подписчики: метки и поля | `POST /{botId}/users/import` (добавляет метки, пишет только новые переменные) | `bot_users_import` | частично: снять метку / перезаписать поле — нет в платформе |
| Подписчики: экспорт, сброс сессии | `GET /api/bots/{botId}/users/export?format=csv\|json` (TgBotUserController:232), `DELETE /api/bots/{botId}/sessions/{chatId}` (TgSessionController:50) | `bot_users_export` (`savePath?`), `bot_user_reset` (`confirm:true`) — новые | есть |
| Подписчики: массовое удаление, неактивные | `POST /users/delete`, `/users/inactive-count`, `/delete-inactive` | — | нет (вне задачи) |
| Диалоги: переписка, ответ оператора | `GET/POST /{botId}/users/{chatId}/messages` | `dialog_messages`, `dialog_reply` | есть |
| Передача оператору (handoff) | `POST /api/bots/{botId}/users/{chatId}/handoff {active}` (DialogReplyController; 409 `chat_busy`, 404 `chat_not_found`) | `dialog_handoff` | есть |
| Интеграции: каталог, статус, проверка | `/api/integrations/catalog`, `/{id}/status`, `/{id}/test` (точные пути в `isIntegrationCorePath`) | `integration_catalog`, `integration_status`, `integration_test` | есть |
| Интеграции: список, подключение, удаление, ingress-URL | `/api/bots/integrations/**` (алиас IntegrationConnectionController) | `list_integrations`, `connect_integration`, `disconnect_integration`, `integration_ingress_url` | есть |
| Интеграции: правка названия/ключей | `PUT /api/bots/integrations/{id}` | `integration_update` | есть |
| Интеграции: Google-аккаунты | `/api/bots/google/auth-url`, `/identities` | внутри `connect_integration` (GOOGLE_SHEETS) | частично (отвязка аккаунта — нет) |
| Журнал вызовов интеграций | `GET /api/bots/integrations/calls?connectionId=&ok=&limit=` (IntegrationConnectionController:58) | `integration_calls` | есть |
| Прогоны/журналы: по подписчику | `GET /{botId}/users/{chatId}/runs` | `bot_user_runs` | есть |
| Прогоны/журналы: по боту, один прогон (вкл. headless) | `GET /api/bots/{botId}/runs` (TgGraphController:674), `/api/bots/runs/{runId}` (:686) | `bot_runs` | есть |
| Прогоны/журналы: по сценарию (вкл. вебхук/расписание) | `GET /api/bots/graphs/{graphId}/runs?page&size` (TgGraphController:702) | `scenario_runs` | есть |
| Статус прогона `PARTIAL` | контракт 1.1 | описан в `dry_run`, `bot_runs`, `bot_user_runs`, `scenario_runs` | есть |
| Расписания: повторяющиеся рассылки | `/api/bots/broadcasts/recurring` | `broadcast_recurring` | есть |
| Расписания: триггер сценария по cron | узел `TRIGGER_SCHEDULE` (`cron`, `timezone`) | графовые инструменты; схема и `validate.mjs` скилла `build-bot-funnel` | есть |
| Новые действия сценария: `booking_slots/book/cancel`, `lead_link_contact`, `invite_link_create/revoke`, `subscription_extend/check`, `yookassa_charge_saved`, `meta_capi_event`, `agent_chat` (handoff), DELAY UNTIL / SCHEDULE от `{{var.x}}` + `offset` | GraphValidator / FlowExecutor | `reference/schema.md`, `validate.mjs` (не отклоняет; kind Integration Core — предупреждение) | есть |
| Рассылки: отправка, список, карточка, ошибки, отмена, превью, черновики, копия | TgBroadcastController, BroadcastDraftController | `broadcast_send`, `broadcast_list`, `broadcast_get`, `broadcast_cancel`, `broadcast_preview`, `broadcast_drafts`, `broadcast_duplicate` | есть |
| Каналы/группы бота, посты | `GET /api/bots/{botId}/linked-chats` (BotLinkedChatController:37), `POST /linked-chats/{chatId}/post` | `list_channels`, `channel_post` | есть: добавить/убрать группу — нет в платформе (бот попадает в список сам, когда его добавляют админом в Telegram) |
| Стартовые ссылки | `GET/POST /api/bots/{botId}/links` (BotStartLinkController:40/46), `DELETE /api/bots/links/{id}` (:59) | `list_links`, `link_create`, `link_delete` (новые; удаление — `confirm:true`) | есть (переименование — нет в платформе) |
| Файлы (медиа) | `/api/bots/media` | `upload_file`, `list_files`, `delete_file` | есть |
| Статьи блога | `/api/articles/**` | `article_list`, `article_get`, `article_publish`, `article_update` | есть |
| Бронирование: календари, слоты, брони, отмена | `/api/bots/booking/calendars[/{id}[/slots\|/bookings[/{bookingId}/cancel]]]` (BookingController) | `booking_calendar_list`, `booking_calendar_get`, `booking_calendar_create`, `booking_calendar_update`, `booking_calendar_delete`, `booking_slots`, `booking_list`, `booking_create`, `booking_cancel` | есть |
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

## 3. Новые инструменты ветки `feat/mcp-parity-2`

Все пути — под `/api/bots/**`, `PatAuthFilter.isTokenPath` пропускает токен; бэкенд не менялся.

| Инструмент | Путь (контроллер:строка) | Защита |
|---|---|---|
| `bot_rename` | `PATCH /api/bots/{botId} {name}` (TgManagementController:137) | botId — UUID |
| `bot_change_token` | `POST /api/bots/{botId}/token {token}` (TgManagementController:150) | 400 → причина без токена; ключ `token` скрыт в телеметрии |
| `bot_channel_list`, `bot_channel_add`, `bot_channel_delete` | `GET/POST /api/bots/{botId}/channels`, `DELETE …/{channelId}` (ChannelController:37/47/60) | удаление — `confirm:true` |
| `link_create`, `link_delete` | `POST /api/bots/{botId}/links`, `DELETE /api/bots/links/{id}` (BotStartLinkController:46/59) | удаление — `confirm:true` |
| `utm_sources`, `ab_results` | `GET /api/bots/{botId}/utm-sources`, `GET /api/bots/graphs/{id}/ab-results` (TgAnalyticsController:50/58) | period — `\d+[hd]` |
| `kb_delete` | `DELETE /api/bots/kb/{kbId}` (KnowledgeBaseController:212) | `confirm:true`; 409 `KB_OWNED_BY_AGENT` → подсказка |
| `agent_unpublish`, `agent_delete` | `POST /api/bots/agents/{id}/unpublish`, `DELETE /api/bots/agents/{id}` (AiAgentController:193/140) | удаление — `confirm:true`; 409 `AGENT_IN_USE` → список сценариев |
| `site_leads_mark_read`, `site_lead_delete`, `site_leads_export` | `POST …/leads/read`, `DELETE …/leads/{leadId}`, `GET …/leads.csv` (SiteLeadController:72/88/94) | удаление — `confirm:true`; CSV — текстом или в `savePath` |
| `bot_users_export` | `GET /api/bots/{botId}/users/export?format=csv\|json` (TgBotUserController:232) | текстом или в `savePath` |
| `bot_user_reset` | `DELETE /api/bots/{botId}/sessions/{chatId}` (TgSessionController:50) | `confirm:true`; chatId без округления |

Тесты: `scripts/parity-2.test.mjs` (42 проверки: пути и тела, `confirm`, валидация до запроса, 400/403/404/409).

## 4. Требует решения владельца / работы на бэкенде

1. **Вебхук-сценарии (`/api/scenarios/**`) закрыты для PAT** — см. §2, предложение `isWebhookScenarioPath` с точным
   списком методов. Без него MCP не создаёт и не публикует вебхук-сценарии и не отдаёт URL+секрет.
2. **Снять метку / перезаписать поле подписчика** — эндпоинта нет (`users/import` только добавляет). Предложение:
   `PATCH /api/bots/{botId}/users/{chatId} {addTags, removeTags, setVariables, unsetVariables}` в TgBotUserController,
   под `/api/bots` — PAT откроется сам; MCP получит `bot_user_update`.
3. **Переименование стартовой ссылки** — нет `PATCH /api/bots/links/{id}`. Нужно, если ссылки переименовывают в кабинете;
   иначе — удалить и создать заново (но меняется `code`, разосланные ссылки ломаются).
4. **Добавить/убрать канал или группу для постинга** (`linked-chats`) — в платформе только список: бот появляется
   там сам, когда его делают админом. Если нужен «отвязать», это `DELETE /api/bots/{botId}/linked-chats/{id}` в
   BotLinkedChatController.
5. **Сброс сессии = удаление подписчика из списка.** `DELETE /sessions/{chatId}` стирает и метки/переменные. Если для
   теста воронки нужен «перезапуск без потери полей», это отдельный эндпоинт (например, `POST …/sessions/{chatId}/restart`,
   который обнуляет только `currentGraphId`/`waitingOnNodeId`).
6. **Подтвердить доступ PAT к CRUD подключений** через алиас `/api/bots/integrations` (§2, п. 2) — комментарий в
   `isIntegrationCorePath` с этим расходится.
7. **Выпуск пакета**: 17 новых инструментов уйдут пользователям только после поднятия версии и `npm publish` (тег `vX.Y.Z`)
   — решение владельца, в этой ветке версия не менялась.
