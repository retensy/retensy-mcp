# Code Mode: этап 0, замер (без правок кода)

Дата: 2026-11-08. Режим: два инструмента `api_search` + `execute` (код в песочнице вызывает объект `api`).
Все токены = символы/4. Время и размеры ответов в разделе 2 ОЦЕНКИ (не замеры): бэкенд не запускался.

## 1. Размер реестров (замер)

| | Инструментов | Описания, симв. | Схемы, симв. | Всего, токены |
|---|---|---|---|---|
| A. MCP, локальные TOOLS в `src/index.mjs` | 194 | 83 069 | 61 292 | 38 924 (tools/list по stdio, `RETENSY_MCP_CATALOG=off`) |
| A. MCP, серверный каталог поверх (имена, которых нет локально) | +65 | n/a | n/a | +12 032 (кэш `~/.retensy-bot-graph/catalog-*.json`, реальный ответ `/api/agent-tools/catalog`) |
| **A. итого, что видит клиент** | **~259** | | | **~50 900** |
| B. Реестр чата `AgentToolRegistry` (он же серверный каталог) | 116 | 21 765 | 42 297 | 17 735 |
| B. Что реально уходит в системный промпт чата за ход | core (5 шт.) + нужные группы | | | core 420; группы: bots 1 324, broadcasts 761, sites 1 808, dialogs 424, booking 1 348 (+ правила промпта, не мерил) |

Метод A: запуск `node src/index.mjs`, `initialize` + `tools/list`, JSON.stringify списка. Метод B: реальный каталог из кэша MCP (тот же `AgentToolRegistry.all()`), группы по префиксам из `AiChatPrompt.GROUPS`.
Самые тяжёлые инструменты A: broadcast_send 6 523 симв., broadcast_group 4 490, chain_create 4 380, broadcast_recurring 4 190.

Оговорки:
- Claude Code уже откладывает схемы (ToolSearch, в контексте только имена). Для него выигрыш по схемам мал; ~51k токенов реально давят на клиентах без отложенной загрузки (Claude Desktop, Cursor и др.).
- Чат уже экономит схемы: в промпте меню имён + полные схемы только нужных групп (`tools_load` подгружает ещё). Схемы в чате НЕ проблема (0.4-3k токенов), проблема в числе шагов.
- Ответы MCP отдаются `JSON.stringify(obj, null, 2)` без обрезки (`okResult`), pretty-print раздувает токены ~1.3-1.5x.

## 2. Типичные задачи: сейчас vs через execute (оценка)

Допущения: ход модели ~6-10 с, вызов API ~0.3-1 с; строка подписчика pretty-JSON ~100 токенов, ряд timeseries ~30, заявка ~250. «Накопительный вход» = сумма контекста по всем ходам (без учёта prompt cache). База A без отложенной загрузки ~40k (схемы + промпт).

### A. MCP

| Задача | Сейчас: вызовов | Ответы/выход, токены | Накопительный вход | Время | Через execute: вызовов | Токены (накопительно) | Время |
|---|---|---|---|---|---|---|---|
| A1. Подписчики по условию (~1200 совпадений) + тег | ~9: `audience_fields`, `audience_search` size=200 x6, `audience_tag_edit` | ~120k ответов + ~10k выхода (модель переписывает 1200 chatId в аргумент) | ~0.9M | 2-4 мин | 3-4 (поиск схемы, код-цикл по страницам, итог `{matched,tagged}`) | ~20k | 10-20 с |
| A2. Статистика: 15 сценариев в 5 ботах, `scenario_timeseries` 92 дня, агрегат | ~21: `list_bots`, `list_graphs` x5, `scenario_timeseries` x15 | ~50k | ~1.4M | ~3 мин | 2-3, `Promise.all`, итог таблица ~500 токенов | ~20k | 10-20 с |
| A3. Заявки: 40 NEW на 3 сайтах -> IN_PROGRESS | ~44: `site_list`, `site_leads` x3, `site_lead_status` x40 (массового нет) | ~10k чтение + 40 x ~100 | ~2.0M | 4-5 мин | 2-3, цикл по заявкам, итог «40 обновлено, 0 ошибок» | ~15k | 15-30 с |

Нюанс A1: при совпадениях <=200 это 2-3 вызова и выигрыш ~1.3x. Сервер уже даёт bulk (`audience_tag_edit` до 10 000 chatId, `bot_users_import` до 10 000 строк, `audience_export`). Выигрыш A1 появляется от >1 страницы: ids не проходят через контекст модели.

### B. ИИ-чат (Spring Boot, `AiChatService`, фронт `frontend/src/app/bots/ai-chat/`)

Жёсткие лимиты: `MAX_TOOL_STEPS=8` на сообщение, результат для модели сжат до 2500 симв. и 15 позиций (`MAX_RESULT_FOR_MODEL`, `MAX_RESULT_ITEMS`), 20 сообщений/мин, `invoke` 60/мин. Каждый шаг = полный вызов модели (~5k+ входных токенов: ядро + группы + история, оценка). Протокол ответа: текстовый JSON `{say, tool, args}`, не нативный tool calling.

| Задача | Сейчас | Вход, накопительно (оценка) | Время | Через execute | Токены | Время |
|---|---|---|---|---|---|---|
| B1. Сводка по подпискам 8 ботов за 30 дней | `list_bots` + `bot_subscriber_analytics` x8 = 9 шагов, упирается в лимит 8 («напишите продолжай»); ответы клипуются до 15 позиций | ~70k | ~60-90 с, неполно | 1-2 шага | ~15k | ~10-15 с |
| B2. Заявки по 6 сайтам: сколько новых и откуда (UTM) | `site_list` + `site_leads` x6 = 7 шагов; модель видит лишь первые 15 заявок на сайт, агрегат неточный | ~50k | ~45-70 с, неточно | 1 шаг, точный подсчёт | ~10k | ~8-12 с |
| B3. Подтвердить 12 ожидающих записей | `booking_list` + `booking_confirm` x12 = 13 шагов (>8) и 12 карточек (`booking_confirm` в IRREVERSIBLE) | ~110k | 3+ мин + 12 кликов | 1 шаг + ОДНА сводная карточка (нужен новый механизм) | ~15k | ~15 с + 1 клик |

В реестре чата нет `site_lead_status` и `audience_*`: B-задачи ограничены тем, что в реестре (116 шт.).

## 3. Деструктивные инструменты (по именам)

Сервер, реестр (`AgentToolPolicy.IRREVERSIBLE` + любой DELETE/`*_delete`), нужен confirmToken: bot_delete, graph_delete, broadcast_send_now, broadcast_cancel, dashboard_widget_remove, graph_publish, site_publish, site_rollback, agent_publish, bot_connect, bot_stop, chain_approve, chain_reject, booking_confirm, booking_reject, booking_cancel, dialog_reply, order_status, order_b24_deal, event_publish, ticket_checkin, ticket_cancel, integration_run, amocrm_contact_create, amocrm_task_create, amocrm_note_add, amocrm_lead_move, bitrix24_lead_create, gsheets_export_leads, site_quickstart, catalog_import_url, metrika_sales_upload, vkads_event_send, sendpulse_add_contact, sendpulse_send_email, whatsapp_template_send, telemost_meeting_create, zoom_meeting_create, booking_calendar_sync_set, avito_message_send.

MCP, локальные, идут через серверный confirmToken (`GUARDED_TOOLS`): publish_graph, site_publish, site_rollback, agent_publish, booking_cancel, bot_delete, broadcast_cancel, broadcast_send, delete_graph, create_bot, bot_stop, dialog_reply (мягкие: site_edit, agent_update, chain_enable, kb_add_site).

MCP, локальные, защищены ТОЛЬКО флагом `confirm:true` в аргументах (модель ставит сама): ai_pack_purchase (платёж), agent_delete, agent_api_key_revoke, booking_calendar_delete, bot_channel_delete, bot_user_reset, broadcast_undo, chain_delete, kb_delete, link_delete, site_lead_delete.

MCP, локальные, без защиты, но опасные (отправка, публичность, перезапись, массовая правка): channel_post, vk_post, broadcast_group, broadcast_recurring, broadcast_send_test, broadcast_test, unpublish_graph, graph_version_rollback, update_graph, patch_graph, edit_graph_live, scenario_publish, scenario_rotate_secret, chain_approve, chain_reject, booking_confirm, booking_reject, agent_unpublish, kb_delete_doc, vk_landing_delete, preset_delete, delete_file, disconnect_integration, vk_disconnect, bot_change_token, agent_api_key_create, bot_users_import, migration_commit, bothelp_scenario_commit, audience_tag_edit, audience_variable_edit, site_lead_status, dialog_handoff, bot_channel_add.

Вывод по безопасности: `confirm:true` из аргументов в коде песочницы ставится одной строкой (в т.ч. по инъекции из данных). В Code Mode нельзя пропускать `confirm` из кода, а деструктивные вызовы должны не исполняться, а прерывать `execute` и возвращать человеку просьбу подтвердить.

## 4. Как устроен вызов внутри

### A. MCP (`src/index.mjs`, 0 зависимостей, чистый ESM, Node >=18)
- Единая точка: JSON-RPC `tools/call` идёт в `callCatalog(params)` (серверные, `POST /api/agent-tools/invoke {name,args}`) либо в `handleCall(params)` (большой `switch` по локальным). Оба возвращают `{content:[{text}]}`. Объект `api` строится без дублирования: `api[name] = (args) => dispatch({name, arguments: args})`, имена из `mergeTools(TOOLS, catalog.tools())`. `okResult` уже сериализует JSON в текст, для execute нужен внутренний «сырой» вариант (или JSON.parse).
- Токен/права: токен (`zmcp_...`, `RETENSY_MCP_TOKEN` или `~/.retensy-bot-graph/token`) читается в `authHeaders()`/`api()` в основном процессе. Права токена (scopes) проверяет сервер (PatAuthFilter / PatScopePolicy). Песочница токена видеть не должна: вызовы идут через IPC в родительский процесс.
- Серверное подтверждение: `invokeGuarded` + 409 `confirmToken` привязан к пользователю, инструменту и аргументам, TTL 5 мин, одноразовый. Нельзя отдавать токен в песочницу: `pending` должен прерывать выполнение.
- Зависимостей нет (нет isolated-vm, нет node_modules). Это заявленное свойство пакета («Zero dependencies»); нативный isolated-vm его нарушил бы и усложнил `npx`.
- Варианты песочницы:
  1. `child_process.fork` отдельного процесса + `node --permission` (без fs/net/child_process; Node >=20, локально v24) + `--max-old-space-size`, таймаут kill, общение только по IPC (`api.*` -> родитель). Без новых зависимостей. Для `engines >=18` нужен fallback без `--permission` или поднять engines до 20.
  2. `worker_threads` с `resourceLimits`: изоляция слабая (в воркере доступны `process`, `require`, сеть), только защита от зависаний, не от злонамеренного кода.
  3. `node:vm`: не граница безопасности, не годится.
  Рекомендация: п.1. Угроза умеренная: код пишет модель пользователя на машине пользователя, главный риск это инъекция из данных (заявки, сообщения) в код. Поэтому: нет токена/env/fs/net в процессе, деструктивное только через pending-прерывание, лимит числа вызовов и размера результата.

### B. Чат (Java 17, Spring Boot 3.4.2)
- Единая точка: `AgentToolExecutor.execute(tool, args, Credentials)` делает внутренний HTTP на тот же REST (`127.0.0.1:{server.port}`) с cookie/Authorization исходного запроса (`Credentials(cookie, authorization, clientIp)`); путь только из шаблона реестра, id по whitelist-регэкспу, лишние поля отбрасываются. Владение, лимиты тарифа и права токена проверяет сам эндпоинт: отдельной авторизации у инструментов нет. Для песочницы `api.<name>(args)` -> `executor.execute(registry.find(name), args, creds)`: логика не дублируется, права пользователя наследуются.
- Подтверждение: чат решает через `AgentToolPolicy.requiresConfirmation(tool, tainted)` (default-deny для всего, кроме чтений и `REVERSIBLE`) + карточка `PendingAction`; `AgentToolService.invoke` (для MCP) добавляет confirmToken, журнал `AgentToolRun`, лимит 60/мин. Code Mode в чате должен идти через ту же политику, а не напрямую через executor, иначе обойдёт карточки и журнал.
- Защита уже есть: `foreignUrl` (адреса только из сообщений пользователя), `tainted` диалог, маскирование секретов (`CanvasSteps.maskArgs`, `{{secret:N}}`).
- Зависимостей GraalVM/polyglot, Rhino, Nashorn в `pom.xml` нет. Образ `eclipse-temurin:17-jre-jammy`, node в нём не установлен (проверял по Dockerfile: apt-get ставит другое).
- Варианты песочницы JS:
  1. GraalJS (`org.graalvm.polyglot:polyglot` + `js`, community) на обычном JDK 17: `Context.newBuilder("js").allowAllAccess(false)` (host access NONE, без IO/потоков/нативного), `api` только через `ProxyExecutable`; лимиты: `ResourceLimits.statementLimit` + таймаут через `context.close(true)` из другого потока. Ограничения: heap-лимита в CE нет (держим косвенно: лимит размера входа/результата и statementLimit), на стандартной JVM работает как интерпретатор (медленно, но для оркестрации вызовов достаточно). Добавляет ~40-60 МБ в jar/образ. Реалистичный вариант.
  2. Отдельный node-процесс: нужно добавить node в образ, IPC и проброс cookie/Bearer расширяют поверхность атаки. Менее реалистично, чем GraalJS.
  3. Rhino/Nashorn: Nashorn удалён из JDK 15, Rhino слабее по изоляции и версии ES. Нет.
- Отдельная проблема B: текстовый JSON-протокол. Модель должна стабильно писать JS внутри JSON-строки `args.code` (экранирование, обрыв по length: уже есть `TRUNCATED_NOTE`); результат выполнения снова сжимается `compactResult`.

## 5. Честный вывод

| | Выигрыш >=2x? | Где |
|---|---|---|
| A. MCP | Да, 10-25x по вызовам и токенам на цепочках | A2, A3 уверенно (21-44 вызова -> 2-3, ответы 50k -> <1k в контексте). A1 только при >200 совпадений (иначе ~1.3x). У клиентов с отложенными схемами (Claude Code) выигрыш от схем малый, остаётся от ответов и числа ходов |
| B. Чат | Количественно да (5-10x по токенам и времени), но главное: снимается лимит 8 шагов и клип 15 позиций; B1-B3 сейчас либо упираются в лимит, либо дают неточный агрегат | Только агрегаты и массовые операции; на одиночных вопросах выигрыша нет, схемы уже грузятся лениво |

1. Делать сначала A: реестр чётко диспетчеризован (`handleCall`/`callCatalog`), зависимостей не нужно (`child_process` + `--permission`), выигрыш большой. Условие: деструктивные вызовы из кода прерывают `execute`, `confirm`/`confirmToken` из кода не принимаются; инструменты, защищённые только `confirm:true` (список в п.3), исключить из `api` либо перевести на серверный confirmToken.
2. Для B полноценный Code Mode дорог (GraalJS +40-60 МБ, нет heap-лимита, текстовый протокол, переделка подтверждений под одну сводную карточку, лимит 60/мин). Дешёвая альтернатива, дающая большую часть эффекта без песочницы: серверные агрегирующие/массовые инструменты в реестр (`bot_subscriber_analytics` по всем ботам, сводка заявок по сайтам с UTM, `booking_confirm` пачкой с одной карточкой, `site_lead_status` пачкой) и больше шагов/слабее клип для read-only цепочек. Рекомендую так, Code Mode в чат откладывать.
3. В B стоимость определяет число ходов (каждый ~5k+ входных токенов), а не размер схем: чат и так грузит схемы по группам.
4. Что замерить на этапе 1 до реализации: реальные размеры ответов `audience_search`, `scenario_timeseries`, `site_leads` на боевом аккаунте (сейчас оценка), реальное время хода модели чата, холодный старт child-процесса (ожидается <100 мс).
5. Ограничения оценок: раздел 2 посчитан по размерам и лимитам из кода, не по прогону; накопительный вход без prompt cache (с кэшем деньги ниже, число ходов и время остаются).
