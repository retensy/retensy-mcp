# retensy-mcp

[![CI](https://github.com/retensy/retensy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/retensy/retensy-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@retensy/mcp.svg)](https://www.npmjs.com/package/@retensy/mcp)
[![node](https://img.shields.io/node/v/@retensy/mcp.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP-сервер (+ скилл для Claude Code) для **сборки и публикации воронок/автоматизаций ботов (Telegram, MAX и Instagram)** в сервисе [retensy `/bots`](https://bots.retensy.com/bots): из текстового описания → валидный граф сценария → заливка и публикация через API.

---

## Быстрый старт

1. **Получи токен.** Залогинься на https://bots.retensy.com → открой `/bots/mcp-tokens` → создай токен → скопируй секрет `zmcp_...` (показывается один раз).
2. **Подключи у своего клиента** (env-переменные везде одни и те же: `RETENSY_BASE_URL`, `RETENSY_MCP_TOKEN`):

   **Claude Desktop** — добавь в `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "retensy-mcp": {
         "command": "npx",
         "args": ["-y", "@retensy/mcp@latest"],
         "env": {
           "RETENSY_BASE_URL": "https://bots.retensy.com",
           "RETENSY_MCP_TOKEN": "zmcp_ваш_токен"
         }
       }
     }
   }
   ```

   **Claude Code** — одной командой:
   ```bash
   claude mcp add retensy-mcp -e RETENSY_BASE_URL=https://bots.retensy.com -e RETENSY_MCP_TOKEN=zmcp_ваш_токен -- npx -y @retensy/mcp@latest
   ```
   Или как плагин (подтянет и скиллы, см. [«Вариант A» ниже](#вариант-a--как-плагин-claude-code-рекомендуется)):
   ```text
   /plugin marketplace add retensy/retensy-mcp
   /plugin install retensy-mcp@retensy
   ```

   **Cursor** — Settings → MCP → Add new MCP Server (или `.cursor/mcp.json` в проекте) — тот же JSON-объект, что и для Claude Desktop выше (`mcpServers.retensy-mcp` с `command`/`args`/`env`).

3. **Собери первую воронку.** Опиши сценарий словами агенту — он сам соберёт граф и опубликует (см. [«Использование»](#использование)), либо перенеси готовую воронку из другого сервиса — см. [«Перенос воронки из другого конструктора»](#перенос-воронки-из-другого-конструктора) ниже.

Проверить подключение в любом клиенте: спроси агента «настрой подключение» — вызовет `setup` и подскажет, если что-то не так.

---

- 🤖 **Сценарии ботов**: `list_bots`, `list_graphs`, `list_channels`, `get_graph`, `create_graph`, `update_graph`, `edit_graph_live`, `patch_graph`, `dry_run`, `publish_graph`, `import_funnel`, `list_templates`, `create_graph_from_template`, `clone_graph`, `copy_graph`, `rename_graph`, `set_active_graph`, `delete_graph`, `upload_file`, `list_files`, `delete_file`, `graph_analytics`, `list_bot_users`, `list_links` (+ `setup`/`set_token`).
- 🔌 **Боты и сервисы**: `create_bot` (Telegram/MAX по токену), `bot_stop`/`bot_resume`, `connect_integration`/`disconnect_integration` (amoCRM, Битрикс24, GetCourse, Я.Метрика, ЮKassa; Google Таблицы — ссылкой на вход Google; креды хранятся зашифрованными и не возвращаются), `integration_catalog`/`integration_status`/`integration_test` (каталог Integration Core и живая проверка подключения), `integration_ingress_url` (URL ингресса «Внешних событий» — Tilda, JivoSite, WooCommerce, amoCRM, Битрикс24, GetCourse, CloudPayments, Robokassa, Т-Банк, Prodamus — для `TRIGGER_WEBHOOK`), `channel_post` (пост в канал Telegram/MAX).
- 📣 **Рассылки**: `broadcast_preview` (размер аудитории), `broadcast_send` (сейчас или по расписанию, сразу по нескольким ботам; сообщения или запуск сценария; полный фильтр аудитории `audienceFilter`, дедуп `dedup` и распределённый запуск `stagger` по ботам), `broadcast_list`/`broadcast_get`/`broadcast_cancel`, повторяющиеся (`broadcast_recurring`), черновики (`broadcast_drafts`, `broadcast_duplicate`), мульти-бот группы (`broadcast_group` — preview/list/get/pause/resume/cancel) + скилл `send-broadcast`.
- 👥 **Аудитория подписчиков**: `audience_search`/`audience_fields` — кросс-бот поиск и фильтр (теги, даты, статус, условия по переменным), `audience_tag_edit`/`audience_variable_edit` — массовое редактирование тегов/переменных, `audience_export` — потоковая выгрузка выборки в CSV/XLSX, `dialog_search` — поиск по «Диалогам» (включая текст сообщений).
- 📤 **Миграция подписчиков** из других конструкторов: `migration_presets`/`migration_preview`/`migration_commit` — generic CSV column-mapper для BotHelp/SaleBot/Senler/Leadteh/Smartsender/ManyChat (переносятся только подписчики — ни один из них не публикует документированный формат экспорта воронки).
- 📅 **Запись на слоты**: `booking_calendar_*` (буферы до/после брони, горизонт записи, типы встреч своей длительности, форма клиента, публичная страница `/book/<slug>`), `booking_confirm`/`booking_reject` — ручное подтверждение брони (`confirmationMode:"MANUAL"`).
- 📰 **Публикации и VK**: `publications_usage` — месячная квота (общая для Telegram/MAX/Instagram/VK), `vk_status`/`vk_connect`/`vk_disconnect`/`vk_post` — подключение VK-сообщества токеном и публикация на стену.
- 🔗 **Ссылка вместо отказа**: что нельзя сделать через API (вход через Google/Instagram, оплата тарифа, вход в аккаунт) — инструмент возвращает прямую ссылку и одну строку, что сделать.
- 📝 **Статьи блога** (тот же токен `zmcp_…`): `article_publish`, `article_update`, `article_list`, `article_get` — публикация статей в Markdown (как README на GitHub) в раздел **/articles**.
- 🧠 **ИИ-агенты и база знаний**: `agent_list`/`agent_get`/`agent_create`/`agent_update`/`agent_publish`/`agent_health`/`agent_test_chat`/`agent_unanswered`, `kb_docs`/`kb_add_qa`/`kb_add_text`/`kb_add_site`/`kb_reindex` — настройка ИИ-агента и его базы знаний (раздел «ИИ-агенты»).
- 📎 **Медиа**: `upload_file` грузит фото/видео/документы в библиотеку **/bots/files** (до 50 МБ) и возвращает публичный URL — его вставляешь в медиа-карточку сценария.
- 🌐 **Сайты из блоков** (раздел «Страницы»): создание, правка операциями (блоки, Zero-блок со свободной вёрсткой, код блока, папки страниц, дизайны, шаблоны из библиотеки), публикация и откат, свои домены, заявки из форм и куда их доставлять — инструменты `site_*` + скилл `build-site`.
- 🧠 **Скилл `build-bot-funnel`**: учит агента собирать корректный граф (типы узлов, ветки, кнопки, задержки) и проверять его перед публикацией. Поддерживает Telegram, MAX и Instagram.
- 🔁 **Скилл `rebuild-funnel-from-builder`**: переносит воронку из другого конструктора (BotHelp, SaleBot, Senler, Leadteh, Smartsender, ManyChat, PuzzleBot и др.) по export JSON/тексту, скриншотам или пересказу — в граф Retensy, новым черновиком, без перезаписи текущего сценария. См. [«Перенос воронки из другого конструктора»](#перенос-воронки-из-другого-конструктора).
- 🔗 **Скилл `build-publication-chain`**: учит агента собирать «Цепочки публикаций» (автопостинг source → граф обработки → N назначений) — линейно или графом (общий/раздельный ИИ-адаптер на ветках), UTM по назначению, согласование, фан-аут в один заход («1 источник → общий ИИ → 10 TG-каналов + 2 VK + 4 MAX»).
- 📦 **Без зависимостей** — чистый Node ≥18, ставится и запускается сразу.

### Поддерживаемые платформы

| Платформа | Онбординг | Триггеры входа | Ограничения |
|---|---|---|---|
| **Telegram** | Токен бота (BotFather) → `create_bot` | `/start`, команды, callback, текст, рассылки | Полный функционал |
| **MAX** | Токен бота (MasterBot в MAX) → `create_bot` | Команды, callback, текст | Без SUBSCRIBED/reply-клавиатур (мягкие предупреждения) |
| **Instagram** | Вход через Instagram (OAuth) в кабинете `/bots/instagram` (без токена) — нужен Instagram-аккаунт Business или Creator | Комментарий/Direct/Ответ на историю/Упоминание | Ограниченный набор узлов; DELAY ≤ 24ч; ASK_QUESTION только TEXT/EMAIL/PHONE/NUMBER/CONTACT (CONTACT = ручной ввод номера); без рассылок |

---

## Установка

### Вариант A — как плагин Claude Code (рекомендуется)

```text
/plugin marketplace add retensy/retensy-mcp
/plugin install retensy-mcp@retensy
```

Подтянутся MCP-сервер и скиллы `build-bot-funnel`, `rebuild-funnel-from-builder`, `build-site`, `send-broadcast`, `build-publication-chain`. Проверить: `/mcp` и `/plugin`.

### Вариант B — как обычный MCP-сервер (Claude Code / Cursor / Windsurf / любой MCP-клиент)

Через `npx` без установки. Пример конфига (`.mcp.json` / настройки клиента):

```json
{
  "mcpServers": {
    "retensy-mcp": {
      "command": "npx",
      "args": ["-y", "@retensy/mcp@latest"],
      "env": {
        "RETENSY_BASE_URL": "https://bots.retensy.com",
        "RETENSY_MCP_TOKEN": "zmcp_ваш_токен"
      }
    }
  }
}
```

См. также [`examples/.mcp.json`](examples/.mcp.json).

---

## Авторизация — персональный токен

Токен действует от твоего имени **в пределах выбранных прав** (см. «Права токена» ниже).

1. Залогинься на https://bots.retensy.com → открой **`/bots/mcp-tokens`**.
2. Выбери права токена (пресет «Только чтение», «Полный доступ» или свой набор) и, при желании, срок действия → создай токен → скопируй секрет `zmcp_...` (показывается один раз).
3. Передай токен любым способом:
   - **просто пришли его агенту в чат** — он вызовет инструмент `set_token` и сохранит токен в `~/.retensy-bot-graph/token` (применяется сразу, без рестарта), **или**
   - `env` в `.mcp.json` (Вариант B), **или**
   - переменной окружения: PowerShell `setx RETENSY_MCP_TOKEN "zmcp_..."`, bash `export RETENSY_MCP_TOKEN="zmcp_..."`.

Отозвать токен можно там же — доступ блокируется мгновенно.

> С 14.10 тот же токен `zmcp_...` полностью покрывает и вебхук-сценарии (`/api/scenarios` — `scenario_*`),
> и управление подключениями сервисов (`/api/integrations` — `connect_integration`/`disconnect_integration`/
> `integration_update` и остальные `integration_*`), не только `/api/bots`. Отдельного токена под эти инструменты не нужно.

### Права токена (scopes)

С 17.10.2026 у токена есть права. Их проверяет **сервер на каждом запросе**, а не MCP-клиент, поэтому прямой
вызов API (curl и т.п.) их тоже не обходит; MCP-клиент только объясняет отказ. Но права **крупные** — выдавай
токену только то, что нужно для задачи.

| Право | Что разрешает | Примеры инструментов |
|---|---|---|
| `read` | любое чтение: списки, карточки, аналитика, превью, поиск, `dry_run`. **Включает персональные данные**: подписчики, переписка в диалогах, заявки с сайтов и их файлы | `list_bots`, `get_graph`, `site_leads`, `dialog_messages`, `broadcast_preview` |
| `write:bots` | создание и изменение ботов, сценариев, цепочек, интеграций, ИИ-агентов, базы знаний, черновиков рассылок. Правка опубликованного сценария сразу меняет ответы бота подписчикам; можно сменить ключи и вебхуки интеграций; `agent_test_chat` тратит ИИ-бюджет, `integration_test` ходит во внешний сервис | `create_graph`, `publish_graph`, `chain_update`, `connect_integration`, `agent_test_chat` |
| `write:sites` | сайты, лиды, VK-лендинги, статьи | `site_create`, `site_edit`, `site_publish`, `vk_landing_update`, `article_publish` |
| `crm` | теги/переменные подписчиков, импорт, передача диалога оператору, записи. `booking_confirm`/`booking_reject` отправляют клиенту сообщение | `audience_tag_edit`, `bot_users_import`, `dialog_handoff`, `booking_create` |
| `broadcast` | всё, что доходит до живых людей без участия человека: рассылки, ответы, посты, а также **включённая цепочка без согласования постов** (approvalMode `NONE`/`AI_ONLY`) и **публикация/правка/активация сценария с `TRIGGER_SCHEDULE`** | `broadcast_send`, `dialog_reply`, `channel_post`, `vk_post`, `chain_approve`, `chain_enable` (без согласования) |
| `billing` | деньги и ключи, которые тратят бюджет | `ai_pack_purchase`, `agent_api_key_create` |
| `destructive` | любое удаление и массовая выгрузка ПДн | `delete_graph`, `bot_delete`, `audience_export`, `site_leads_export` |

- **Пресеты:** «Только чтение» = `read`; «Полный доступ» = все семь. По умолчанию в кабинете предлагается
  `read` + `write:bots` + `write:sites` — собирать ботов и сайты. Это **не «безопасный»** набор: он видит ПДн
  подписчиков и заявок и меняет живые ответы ботов и ключи интеграций. В нём нет только рассылок, оплаты,
  удаления и выгрузки.
- **Цепочки и расписание** с одним `write:bots`: цепочку можно создать выключенной или с согласованием каждого
  поста (`approvalMode: ALL`), сценарий по расписанию, с отправкой в заданный чат/канал (`target.mode` chat/expression)
  или вебхук-сценарий с получателем из тела запроса (`recipientFrom`) — оставить черновиком. Включить/опубликовать — нужен `broadcast`.
- **Нет права** → сервер отвечает `403 {"error":"insufficient_scope","requiredScope":"…"}`, а инструмент
  возвращает ошибку «Токену не хватает права «X» …». Это не сбой: добавь право токену кнопкой
  «Изменить права» на `/bots/mcp-tokens` (действует со следующего запроса, переподключать клиента не нужно)
  или выпусти новый токен.
- **Старые токены** (выпущены до появления прав) работают как раньше — с полным доступом; в кабинете они
  помечены «полный доступ (старый токен)». Рекомендуем ограничить им права.
- **Срок действия** (30/90/365 дней или бессрочно) задаётся при создании; истёкший токен отвечает 401 и не
  ротируется (400 `token_expired`) — выпусти новый. Ротация сохраняет права и длительность срока; API ротации
  принимает и новые права (`scopes`/`preset`) — так старый токен переводят на явные права.

> **Не знаешь, что делать?** Скажи агенту «настрой подключение» — он вызовет `setup`, объяснит шаги и попросит токен. Любой инструмент при отсутствии токена тоже вернёт пошаговую инструкцию.

> Дев-окружение: `RETENSY_BASE_URL=http://localhost:8066`.
> Fallback без токена: `RETENSY_SESSION_COOKIE` = значение куки `SESSION` из браузера.

---

## Использование

Опиши воронку словами — агент соберёт граф и (через MCP) опубликует:

> «Собери бота: `/start` → приветствие с кнопкой подписки на канал → вопрос с 3 кнопками (бизнес / эксперт / просто смотрю) → для каждой свою цепочку из 2 сообщений с задержкой 1 день → финал с регистрацией на вебинар. Залей в бота и опубликуй.»

Под капотом скилл соберёт `nodes/edges`, прогонит локальную проверку и вызовет `import_funnel` → создаст граф, зальёт узлы, прогонит `dry-run /start`, опубликует. При ошибках публикации — разберёт по `code`/`nodeId`, починит, повторит.

### Инструменты

| Tool | Назначение |
|---|---|
| `setup` | статус авторизации + пошаговая инструкция подключения |
| `set_token` | сохранить присланный токен `zmcp_…` (без env/рестарта) |
| `list_bots` | список ботов |
| `create_bot(platform, token?, name?)` | подключить бота Telegram/MAX по токену; `WEB` — чат-виджет для сайта без токена → botId, key, snippet (Instagram → ссылка на кабинет `/bots/instagram`, вход через Instagram) |
| `web_widget_snippet(botId)` | код вставки чат-виджета на сайт |
| `bot_stop(botId)` / `bot_resume(botId)` | остановить / запустить бота |
| `list_graphs(botId)` | графы (сценарии) бота |
| `list_channels(botId)` | каналы/группы, подключённые к боту (chatId для условия SUBSCRIBED) |
| `list_integrations()` | подключённые сервисы (amoCRM, Битрикс24, GetCourse, Я.Метрика, ЮKassa): `id` = `connectionId` для действий сценария |
| `connect_integration(provider, creds?, title?, connectionId?)` | подключить/обновить сервис; без кредов — какие поля нужны; Google Таблицы → ссылка входа Google, Instagram → ссылка на кабинет `/bots/instagram` (вход через Instagram) |
| `disconnect_integration(connectionId)` | удалить подключение |
| `integration_catalog()` | каталог Integration Core: поля подключения (`configSchema`) и действия (`actions[].kind`) сервисов |
| `integration_status(connectionId)` | статус подключения: `OK` / `NEEDS_REAUTH` / `ERROR` / `UNKNOWN`, последняя проверка и ошибка |
| `integration_test(connectionId)` | живая проверка ключа во внешнем сервисе от имени владельца (без побочных эффектов) |
| `integration_ingress_url(connectionId, rotate?)` | URL ингресса для триггера «Внешние события» (`TRIGGER_WEBHOOK` с `provider`+`connectionId`+`event`); `rotate:true` — выпустить новый, старый отключается сразу |
| `channel_post(botId, chatId, text?, mediaUrl?)` | разовый пост в канал/группу Telegram или MAX (раздел «Публикации»); файл — из `upload_file` |
| `get_graph(graphId, [summary], [saveToFile])` | получить граф; `summary:true` — компактная сводка (id/type/title + рёбра), `saveToFile` — записать полный JSON на диск (для больших графов, чтобы не упереться в лимит токенов) |
| `create_graph(botId, name)` | создать пустой граф (DRAFT) |
| `update_graph(graphId, graphFile\|graph\|nodes,edges)` | залить узлы/рёбра (PUT); `graphFile` — путь к локальному JSON, граф не нужно слать инлайном |
| `edit_graph_live(graphId, graphFile\|graph\|nodes,edges)` | правка живого графа НА МЕСТЕ + авто-бэкап (рекомендуется для прода) |
| `patch_graph(graphId, replacements)` | строковые замены в JSON графа на сервере (для больших/живых графов) |
| `dry_run(graphId, kind, value)` | прогон без публикации |
| `publish_graph(graphId)` | публикация (вернёт `errors[]` при провале) |
| `import_funnel(botId, name, graphFile\|graph)` | всё за раз: create → update → dry-run → publish |
| `list_templates()` | готовые шаблоны воронок |
| `create_graph_from_template(botId, templateId, name)` | граф из шаблона (DRAFT) |
| `clone_graph(graphId)` | копия графа в новый DRAFT |
| `rename_graph(graphId, name)` | переименовать сценарий |
| `set_active_graph(botId, graphId)` | переключить активный (живой) граф бота |
| `delete_graph(graphId)` | удалить граф (активный — нельзя, 409) |
| `upload_file(path\|url)` | загрузить файл в /bots/files → публичный `url` для медиа-карточки |
| `list_files()` | файлы библиотеки /bots/files + использовано/лимит байт |
| `delete_file(id)` | удалить файл из /bots/files |
| `graph_analytics(graphId)` | прохождение сценария по узлам (где отваливается воронка) |
| `list_bot_users(botId)` | подписчики/лиды бота (постранично, поиск `query`) |
| `list_links(botId)` | стартовые трекинговые ссылки бота с UTM |
| `site_list()` | сайты пользователя (id, mode, url, publishedRevision, status — `BLOCKED` у заблокированных модерацией, blockedReason) |
| `site_create(title, slug?, template?)` | новый сайт из блоков → `id`; `template` (`starter`/`blank`/`mini-landing`) — сразу черновик из шаблона; число сайтов ограничено тарифом — сверх лимита HTTP 402 с причиной и ссылкой на смену тарифа |
| `site_get(siteId, saveToFile?)` | модель сайта (`revision`, `draft`, `versions[]` публикаций) |
| `site_schema()` | JSON Schema модели и операций — читать перед правкой |
| `site_edit(siteId, ops[]?, revision?, init?)` | правка операциями (`init`: `starter`/`blank`/`mini-landing`; только `init` — черновик из шаблона), всё или ничего: страницы и папки, блоки, Zero-элементы, код блока (`get/set/add_block_code`), дизайны и их кадры, шаблоны (`add_template`), тема, попапы; пиксели аналитики (GA4/GTM/Meta/VK/Яндекс.Метрика) — тоже сюда, `set_settings {analytics: {...}}` (отдельного инструмента нет — те же `settings.analytics` модели сайта, валидируются форматом id на сервере) |
| `site_templates(category?, full?)` | библиотека шаблонов блоков для `add_template` |
| `site_publish(siteId)` | опубликовать черновик → `url` |
| `site_rollback(siteId, revision)` | вернуть прошлую публикацию |
| `site_upload_asset(siteId, path\|url)` | картинка/видео в сайт → `assets/…` |
| `site_domains(siteId, action, host?, withWww?, domainId?)` | свои домены: list / add / check / remove (число — по тарифу) |
| `site_leads(siteId, page?, size?)` | заявки из форм (поля, UTM, статус доставки) |
| `site_lead_settings(siteId, settings?)` | куда доставлять заявки: бот уведомлений, почта, вебхук, вебхук-сценарий, amoCRM, «Интеграция» (`coreDelivery {connectionId, kind, params}` из `coreConnections`) |
| `broadcast_list(botId?, group?, page?, size?)` | рассылки + счётчики разделов (черновики/запланированные/отправленные/повторы) |
| `broadcast_get(broadcastId)` | рассылка целиком: статус, счётчики, сообщения, причины ошибок |
| `broadcast_preview(botIds, tagsAll?, tagsNone?)` | сколько подписчиков получат рассылку |
| `broadcast_send(name, botIds, messages \| graphId, tagsAll?/tagsNone? или audienceFilter?, scheduledAt?, draftId?, dedup?, stagger?)` | отправить сейчас / запланировать; по нескольким ботам; или запуск сценария; `dedup`/`stagger` → мульти-бот группа (`broadcast_group`) вместо прямых рассылок |
| `broadcast_cancel(broadcastId)` | отменить запланированную/идущую (для группы — `broadcast_group action:"cancel"`) |
| `broadcast_recurring(action, …)` | повторяющиеся рассылки: list / create (DAILY·MONTHLY·YEARLY, те же `audienceFilter`/`dedup`/`stagger`) / stop |
| `broadcast_drafts(action, …)` | черновики: list / get / create / update / delete |
| `broadcast_duplicate(broadcastId` или `draftId)` | копия рассылки или черновика — новый черновик «… (копия)» |
| `broadcast_group(action, …)` | мульти-бот группа с дедупом/распределённым запуском: `preview` (read-only оценка) / `list` / `get` / `pause` / `resume` / `cancel` (каскадом на уже запущенные боты) |
| `article_list()` | свои статьи блога (id, slug, title, просмотры) |
| `article_get(slug)` | статья по slug (Markdown content, excerpt, обложка) |
| `article_publish(content, title?, cover?, excerpt?)` | новая статья (Markdown; title из `# ...`, если не задан; обложка из `cover`-URL или 1-й картинки → OG; `excerpt` явно или авто) → id, slug, URL |
| `article_update(id, content, title?)` | обновить свою статью по id |
| `agent_list()` | список ИИ-агентов (id, имя, статус) |
| `agent_get(agentId)` | настройки агента: язык, тон, длина/формат ответа, инструкции, темы, `kbId` базы знаний, статус |
| `agent_create(name?, description?)` | создать агента; вместе с ним создаётся база знаний (`kbId` в ответе) |
| `agent_update(agentId, patch)` | частично изменить настройки (`patch` — только меняемые поля: `tone`, `language`, `instructions` и т.п.) |
| `agent_publish(agentId)` | опубликовать; 409 `CHECKLIST_FAILED`, если агент не готов |
| `agent_health(agentId)` | счётчики документов/фрагментов базы знаний |
| `agent_test_chat(agentId, question, history?)` | проверить ответ в песочнице (**тратит бюджет ИИ** — не вызывай массово) |
| `agent_unanswered(agentId, days?)` | вопросы без ответа за период (7\|30\|90, по умолчанию 30) |
| `kb_docs(kbId)` | документы базы знаний агента (источник, статус, фрагменты) |
| `kb_add_qa(kbId, pairs)` | добавить пары вопрос-ответ (`pairs: [{question, answer}]`, до 200 за раз) |
| `kb_add_text(kbId, title, text)` | добавить источник «Текст/инструкция» |
| `kb_add_site(kbId, url, schedule?)` | добавить сайт обходом страниц; `schedule`: `NEVER`\|`DAILY`\|`WEEKLY`\|`MONTHLY` |
| `kb_reindex(kbId, docId, headerRow?)` | переиндексировать файл из оригинала («Повторить»); `headerRow` — для таблиц, если шапка определилась неверно |
| `kb_list()` / `kb_create(name)` | базы знаний: список / новая (база агента создаётся с ним — `kbId` в `agent_get`) (id → `knowledgeBaseId` узла `AI_REPLY mode:"agent"`) |
| `kb_delete_doc(kbId, docId)` | удалить документ из базы знаний вместе с фрагментами |
| `bot_user_get(botId, chatId)` | карточка подписчика: теги, переменные, ai_summary |
| `bot_user_runs(botId, chatId)` | журнал запусков с шагами — проверка, что сценарий реально выполнил действия (CRM, уведомление, HTTP) |
| `dialog_messages(botId, chatId)` / `dialog_reply(botId, chatId, text)` | переписка с подписчиком / ответ оператора (уходит реальному человеку) |
| `dialog_handoff(botId, chatId, active)` | передать диалог оператору (бот и ИИ молчат) / вернуть боту |
| `bot_users_import(botId, rows)` | добавить/обновить подписчиков пачкой JSON (`rows: [{chatId, tags?, variables?, subscribedAt?, source?, status?}]`; существующие поля не перезаписываются, `status: BLOCKED/UNSUBSCRIBED` только выставляет блокировку, никогда не снимает) |
| `bot_runs(botId` или `runId)` | журнал прогонов бота / один прогон с шагами (статус `PARTIAL` — «завершён с ошибками») |
| `scenario_runs(graphId, page?, size?)` | журнал прогонов одного сценария, включая headless (вебхук, заявки сайта, `TRIGGER_SCHEDULE`) |
| `bot_delete(botId, confirm:true)` | удалить бота навсегда (только по явной просьбе) |
| `web_widget_settings(botId, settings?)` | вид чат-виджета: прочитать / изменить (поля накладываются на текущие) |
| `integration_update(connectionId, title?, creds?)` | переименовать подключение или заменить ключи |
| `integration_calls(connectionId?, ok?, limit?)` | журнал вызовов внешних сервисов из сценариев (ошибки, попытки, runId) |
| `site_lead_status(siteId, leadId, status)` | статус заявки сайта: `NEW`\|`IN_PROGRESS`\|`DONE`\|`REJECTED` (фильтр — `site_leads(status)`) |
| `bot_rename(botId, name)` / `bot_change_token(botId, token)` | переименовать бота (пустое имя — `@username`) / сменить токен после перевыпуска |
| `bot_channel_list(botId)` / `bot_channel_add(botId, token, name?)` / `bot_channel_delete(botId, channelId, confirm:true)` | дополнительные Telegram-боты (мультиканальность); каналы/группы для постинга — `list_channels` |
| `link_create(botId, name?, targetNodeId?)` / `link_delete(linkId, confirm:true)` | стартовая ссылка (диплинк на узел) / удаление; список — `list_links` |
| `utm_sources(botId)` / `ab_results(graphId, branchNodeId, period?)` | UTM-источники подписчиков / итоги A/B-развилки (`period`: `24h`, `7d`, `30d`) |
| `kb_delete(kbId, confirm:true)` | удалить базу знаний целиком (база агента — только вместе с агентом) |
| `agent_unpublish(agentId)` / `agent_delete(agentId, confirm:true)` | снять агента с публикации / удалить (409 `AGENT_IN_USE`, пока подключён к сценариям) |
| `site_leads_mark_read(siteId)` / `site_lead_delete(siteId, leadId, confirm:true)` / `site_leads_export(siteId, savePath?)` | заявки сайта: всё прочитано / удалить заявку / CSV |
| `bot_users_export(botId, format?, savePath?)` | выгрузка подписчиков `csv`\|`json` (с `savePath` — в файл) |
| `bot_user_reset(botId, chatId, confirm:true)` | сбросить сессию подписчика: позиция, метки, переменные (для повторного теста воронки) |
| `booking_calendar_list()` / `booking_calendar_get(calendarId)` | календари записи (id → `calendarId` действий сценария `booking_*`) |
| `booking_calendar_create(name, zone?, slotMinutes?, hours?, exceptions?, botId?)` | новый календарь: окна `{day:1–7, from:"HH:mm", to:"HH:mm"}`, исключения `{date, from?, to?}` |
| `booking_calendar_update(calendarId, …поля)` / `booking_calendar_delete(calendarId, confirm:true)` | правка (поля накладываются на текущие) / удаление |
| `booking_slots(calendarId, from?, to?, limit?)` | свободные слоты `[{at, label}]`, даты ГГГГ-ММ-ДД в зоне календаря |
| `booking_list(calendarId, from?, pendingOnly?)` / `booking_create(calendarId, slotAt, name?, phone?, email?, comment?, customAnswers?, meetingTypeId?)` / `booking_cancel(calendarId, bookingId)` | брони: список (или только ждущие подтверждения) / ручная запись (занятый слот — ошибка «занят») / отмена |
| `booking_confirm(calendarId, bookingId)` / `booking_reject(calendarId, bookingId)` | подтвердить/отклонить бронь при `confirmationMode:"MANUAL"` (прочие поля календаря: `breaks`, `meetingTypes`, буферы, `horizonDays`, `intakeFields`, `notifyOwner`, `slug`+`enabled` — публичная ссылка `/book/<slug>` — в `booking_calendar_create`/`_update`) |
| `audience_fields(botId, search?, limit?)` | ключи переменных (с выведенным типом) и теги бота — для построителя фильтра |
| `audience_search(botId?, botIds?, filter?, q?, sort?, dir?, page?, size?)` | фильтр+сортировка подписчиков: один бот или кросс-бот (без `botId`); `filter` — полный `AudienceFilter` (теги any/all/none, диапазоны дат, `blocked`, `variableConditions`) |
| `audience_tag_edit(botId, chatIds, add?, remove?)` / `audience_variable_edit(botId, chatIds, set?, unset?)` | массово добавить/снять теги / установить/снять переменные у выбранных подписчиков |
| `audience_export(botId?, botIds?, filter?, q?, format, savePath?)` | потоковая выгрузка ТЕКУЩЕЙ отфильтрованной выборки, `csv`\|`xlsx` (xlsx требует `savePath` — бинарный формат), потолок 100000 строк |
| `dialog_search(q, limit?)` | кросс-бот поиск по «Диалогам» — имя/username/id/текст сообщения |
| `publications_usage(botId)` | месячная квота публикаций владельца (общая для Telegram/MAX/Instagram/VK) |
| `vk_status()` / `vk_connect(communityId, accessToken)` / `vk_disconnect(accountId)` | подключённые VK-сообщества / подключить токеном сообщества (проверяется живым вызовом VK) / отключить |
| `vk_post(accountId, text?, mediaUrl?)` | пост на стену VK (только текст/фото — без видео), списывает ту же квоту публикаций |
| `migration_presets()` | каталог источников миграции подписчиков (BotHelp/SaleBot/Senler/Leadteh/Smartsender/ManyChat/универсальный CSV) |
| `migration_preview(botId, path, platform, mapping?)` | пробный прогон CSV (ничего не пишет): без `mapping` — определение заголовков/подсказка сопоставления, с `mapping` — полный dry-run (новые/существующие, превышение лимита) |
| `migration_commit(botId, path, platform, mapping)` | реальный импорт подписчиков тем же `mapping`, что подтвердил `migration_preview` |
| `bothelp_scenario_preview(botId, scenarioFile, externalRequestsDir?)` | dry-run структурной конвертации ОДНОГО сценария BotHelp (его собственный JSON-экспорт, не CSV) в граф Retensy — ничего не пишет, возвращает отчёт `notes[]` (что сконвертировано приближённо/заглушкой) |
| `bothelp_scenario_commit(botId, scenarioFile, externalRequestsDir?)` | то же + сохраняет граф (DRAFT); идемпотентно по `(botId, bothelpScenarioId)` — повторный вызов обновляет тот же граф |
| `chain_list()` / `chain_get(chainId)` | цепочки публикаций («Публикации» → «Цепочки», автопостинг source → граф обработки/назначений) / одна цепочка как хранится (legacy либо граф) |
| `chain_graph_get(chainId)` | граф цепочки ВСЕГДА graph-shaped `{nodes, edges}`, даже для старых линейных цепочек (синтезируется на лету) |
| `chain_create(chain)` / `chain_update(chainId, chain)` | создать / изменить цепочку целиком (`chain`: `name`, `source` TELEGRAM\|VK\|RSS, `approvalMode?`, `utmDefaults?`, и либо legacy `destinations[]`+`steps[]`, либо граф `nodes[]`+`edges[]` — дерево с ветвлением, не произвольный DAG: один узел может кормить несколько назначений, слияния путей нет); граф-узлы — опциональные `x?`/`y?` (координаты холста, UI-подсказка, бэкенд не интерпретирует, опусти → авто-layout); каждое `destination`/`destinations[]` — опциональный `aiOverride?: {enabled, aiMode, tone?, instructions?}`, персональная адаптация ИИ сверх общего `AI_ADAPT` только для этого назначения; HTTP 409 — прямой цикл с другой цепочкой; графовый 400 — «Схема цепочки: …» (см. `chain_validate`) |
| `chain_create_draft(name)` | создать минимальный черновик цепочки (`enabled:false`, без источника/назначений) для потока «создать → сразу донастроить на холсте „Схема“»; не проходит обычную валидацию `chain_create` |
| `chain_validate(nodes, edges)` / `chain_validate(chain)` | офлайн-проверка графа (зеркало серверного `ChainGraphValidator`, не строже сервера) — перед `chain_create`/`chain_update` на сложном графе |
| `chain_destinations_catalog(botIds?)` | одним вызовом: все TG/MAX-каналы по ботам владельца + VK-аккаунты — собрать «1 источник → N каналов» без ручного обхода `list_bots`+`list_channels`+`vk_status` |
| `chain_delete(chainId, confirm:true)` | удалить цепочку (теряется история заданий) |
| `chain_enable(chainId)` / `chain_pause(chainId)` | включить / поставить на паузу приём новых постов источника |
| `chain_runs(chainId, page?, size?)` | история заданий цепочки, новые сверху (бэкенд без постраничной выдачи — `page`/`size`, если переданы, режут список в MCP) |
| `chain_approve(jobId)` / `chain_reject(jobId)` | согласовать / отклонить задание, ждущее подтверждения (`approvalMode` AI_ONLY/ALL) |
| `chain_retry(jobId)` | повторить проваленное задание вручную, минуя бэкофф |
| `site_analytics(siteId, from?, to?)` | KPI+тренд сайта: просмотры, клики (только с `goalName`), заявки, топ-страницы/источники (по умолчанию последние 30 дней) |
| `site_analytics_events(siteId, from?, to?, page?, size?)` | сырые события сайта постранично (`PAGE_VIEW`\|`CLICK`\|`FORM_SUBMIT`, UTM) |
| `bot_subscriber_analytics(botId, from, to)` | новые подписчики/активность бота по дням (дашборд аналитики, диапазон до 92 дней) |
| `scenario_timeseries(graphId, from, to)` | дневной ряд прогонов сценария `{ok, failed, other}` (по узлам — `graph_analytics`) |
| `agent_tool_test(agentId, toolId, params?)` | проверить инструмент агента (`AMO_LOOKUP`/`SHEETS_LOOKUP`/`HTTP_API`) напрямую, без модели — бюджет ИИ не тратится |
| `site_lead_file_download(siteId, leadId, fileId)` | метаданные вложения заявки + ссылка на скачивание (сам файл через MCP не передаётся — HEAD-запрос, не GET) |
| `scenario_list()` | сценарии автора, включая вебхук-сценарии (`sourceType: WEBHOOK`\|`BOT`) — в `list_graphs` вебхук-сценарии не входят |
| `scenario_create(name, botId?)` | создать сценарий: без `botId` — вебхук-сценарий (сервер сам выпускает путь входа и секрет), с `botId` — бот-сценарий, сразу привязанный к боту |
| `scenario_get(scenarioId)` | сценарий целиком — граф + `source` (у вебхук-сценария: путь/секрет входа) + `outputBinding` |
| `scenario_update_source(scenarioId, botId?, channel?, recipientFrom?)` | привязка выхода вебхук-сценария, заменяется ЦЕЛИКОМ (без `botId` — привязка снимается, без `recipientFrom` — очищается); только для `sourceType:"WEBHOOK"` |
| `scenario_publish(scenarioId)` | опубликовать вебхук-сценарий (бот-сценарий — через `publish_graph`) |
| `scenario_rotate_secret(scenarioId)` | выпустить новый секрет входа вебхук-сценария — старый сразу перестаёт приниматься |
| `agent_api_key_create(agentId, name?)` / `agent_api_key_list(agentId)` / `agent_api_key_revoke(agentId, keyId, confirm:true)` | API-ключи публичного чата агента (`zagt_...`, секрет виден один раз) — для `POST /api/public/agents/{agentId}/chat` без основного токена |
| `ai_packs()` | каталог пакетов ответов ИИ сверх тарифа + текущий баланс (`aiPackAnswersLeft`) |
| `ai_pack_purchase(sku, method?, confirm:true)` | купить пакет — возвращает ссылку на оплату, деньги не списываются этим вызовом |

### Рассылки

Сообщение рассылки — как в мастере кабинета: `{type, text?, mediaUrl?, mediaUrls?, buttons?}`, до 5 сообщений.

| type | Обязательно | Текст | Кнопки |
|---|---|---|---|
| `TEXT` | `text` (до 4096) | Telegram-HTML | до 8 URL-кнопок |
| `PHOTO` `VIDEO` `AUDIO` `FILE` `VOICE` | `mediaUrl` | подпись до 1024 | до 8 |
| `VIDEONOTE` (кружок) | `mediaUrl` | нет | до 8 |
| `GALLERY` | `mediaUrls` — 2–10 картинок | подпись до 1024 | нет |

- HTML: `<b> <i> <u> <s> <code> <pre> <blockquote> <tg-spoiler> <a href="https://…">`, перенос строки — `\n`.
- Кнопки только URL `[{text, url}]` — callback-кнопок в рассылке нет. Медиа — сначала `upload_file`, потом его `url`.
- Аудитория — подписчики бота, фильтр тегами: `tagsAll` (есть все), `tagsNone` (нет ни одного). До 50 000 на бота, до 20 ботов одного владельца за раз.
- `scheduledAt` — ISO 8601; без часового пояса считается московским. Пусто — отправить сейчас.
- Рассылки — на платном тарифе; квота получателей месячная. При нехватке — ошибка с прямой ссылкой на смену тарифа.
- У Instagram-ботов рассылок нет.

```json
{"name": "Распродажа", "botIds": ["<id>"], "tagsAll": ["клиент"], "scheduledAt": "2026-10-10T10:00",
 "messages": ["<b>Только сегодня</b> — скидка 30%",
              {"type": "PHOTO", "mediaUrl": "https://…/sale.jpg", "text": "Успей до полуночи",
               "buttons": [{"text": "В магазин", "url": "https://shop.example"}]}]}
```

### Когда нужен браузер

Через API не делается то, что требует входа пользователя у стороннего сервиса, оплаты или входа в аккаунт.
Такие инструменты не падают, а возвращают `{needsBrowser: true, url, instruction}` или ошибку со ссылкой:

| Ситуация | Ссылка |
|---|---|
| нет токена / токен отозван | `/bots/mcp-tokens` — создать токен и прислать агенту |
| Google Таблицы (`connect_integration`) | одноразовая ссылка согласия Google (OAuth) |
| Instagram (`create_bot`, `connect_integration`) | `/bots/instagram` — подключается входом через Instagram (OAuth); нужен Instagram-аккаунт Business/Creator |
| лимит тарифа, рассылки на бесплатном (HTTP 402) | `upgradeUrl` из ответа или `/bots/subscription` |
| свой домен сайта | DNS у регистратора: A-запись на `dnsTarget` из `site_domains` |

---

## Формат графа и проверка

Граф — контейнер `retensy-bot-graph` (`nodes[]` + `edges[]`). Полная схема узлов/хэндлов и правила валидатора — в скилле:
- [`skills/build-bot-funnel/reference/schema.md`](skills/build-bot-funnel/reference/schema.md)
- [`skills/build-bot-funnel/reference/validation.md`](skills/build-bot-funnel/reference/validation.md)

Локальная проверка графа перед заливкой:

```bash
# Telegram (по умолчанию)
node skills/build-bot-funnel/validate.mjs path/to/import.json
# Instagram-бот
node skills/build-bot-funnel/validate.mjs path/to/import.json --platform=INSTAGRAM
# MAX-бот
node skills/build-bot-funnel/validate.mjs path/to/import.json --platform=MAX
```

---

## Перенос воронки из другого конструктора

Есть готовая воронка в BotHelp, SaleBot, Senler, Leadteh, Smartsender, ManyChat, PuzzleBot или
любом другом сервисе — скилл [`rebuild-funnel-from-builder`](skills/rebuild-funnel-from-builder/SKILL.md)
учит агента перенести её в Retensy: разобрать export JSON/текст/скриншоты/пересказ → построить
инвентарь блоков → сопоставить с реальными типами узлов Retensy (таблица в
[reference/mapping.md](skills/rebuild-funnel-from-builder/reference/mapping.md)) → прямо спросить
про то, что не мапится, вместо того чтобы выдумывать замену → собрать граф → проверить
`validate.mjs`/`dry_run` → залить **новым** черновиком (никогда не поверх текущего сценария) →
опубликовать только после явного подтверждения. Перенос самих подписчиков (не графа) — отдельно,
через `migration_presets`/`migration_preview`/`migration_commit` (CSV).

---

## Разработка

```bash
git clone https://github.com/retensy/retensy-mcp
cd retensy-mcp
RETENSY_MCP_TOKEN=zmcp_... node src/index.mjs   # стартует stdio MCP-сервер
```

Зависимостей нет — это голый JSON-RPC по stdio (протокол MCP `2024-11-05`).

## Обновления

При старте сервер сверяет свою версию с npm (результат кэшируется на 6 часов в
`~/.retensy-bot-graph/update-check.json`). Если вышла новая — уведомление появится в `setup` и
в первом ответе инструмента.

- **Установка через npx** (вариант B): держите в конфиге `@retensy/mcp@latest` — тогда свежая
  версия подтягивается при запуске. Если пакет установлен глобально, сервер сам запустит
  `npm i -g @retensy/mcp@latest` в фоне (отключается `RETENSY_MCP_AUTOUPDATE=0`).
- **Установка как плагин** (вариант A): обновляйте плагин/`git pull` — npm тут не при чём,
  исполняется файл репозитория.

Важно: запущенный процесс не может подменить собственный код — **обновление вступает в силу после
перезапуска MCP-сервера**. Нет сети или npm недоступен — проверка молча пропускается, работа не ломается.

## Отчёты о неудачах (телеметрия)

Чтобы мы узнавали, каких возможностей не хватает, при неудаче инструмента отправляется **анонимный**
отчёт: неизвестный инструмент, отказ публикации (`errors[]`), ошибка API.

Отчёт уходит на **`POST {RETENSY_BASE_URL}/api/mcp/report`** — то есть на тот же сервер, с которым
вы и так работаете. Адреса чата/вебхука, куда мы складываем отчёты, в пакете нет: он живёт в
переменной окружения на сервере. Так его нельзя вытащить из пакета и залить, а мы можем сменить
приёмник без выпуска новой версии.

**Что уходит:** имя инструмента, категория неудачи, текст ошибки, ключи аргументов, версия, платформа
и анонимный id установки (хэш от имени хоста и домашнего каталога — не сами значения).
**Что НЕ уходит никогда:** токены, cookie, пароли, креды интеграций, содержимое графов и текстов
рассылок. Значения аргументов по умолчанию скрыты — присылаются только безопасные поля вроде
`graphId`/`botId`/`kind`.

Если персональный токен настроен, он прикладывается к отчёту — тогда мы видим, у кого именно
не хватило возможности, и можем ответить. Токен прикладывается **только** когда приёмник совпадает
с `RETENSY_BASE_URL`: на сторонний `RETENSY_MCP_REPORT_URL` он не отправляется.

| Переменная | Значение |
|---|---|
| `RETENSY_MCP_TELEMETRY=off` | полностью выключить отчёты |
| `RETENSY_MCP_TELEMETRY=full` | присылать и значения аргументов (для отладки своей установки) |
| `RETENSY_MCP_REPORT_URL=<url>` | свой приёмник (напр. локальный сервер), вместо `/api/mcp/report` |

Отчёты дедуплицируются и ограничены 20 на запуск, отправка не блокирует ответ инструмента
(таймаут 4 с) и при сбое сети молча игнорируется. На сервере — свои лимиты (30 в час с адреса,
500 в час всего), так что отчёты нельзя использовать для заливки.

Отдельно: если токен ещё не настроен вовсе, отчёт **не** отправляется — это обычное состояние
нового пользователя, а не пробел в возможностях.

## Работа партнёра с несколькими проектами

Партнёр настраивает MCP **один раз**, своим собственным токеном — дальше тот же токен работает со всеми проектами, доступ к которым ему дали клиенты.

- **Токен = аккаунт, не проект.** `zmcp_...` всегда идентифицирует тебя. Он не привязан к конкретному боту или сайту — какие проекты видны и что с ними можно делать, решает не токен, а твоя роль в каждом отдельном проекте.
- **Доступ — через приглашение, а не передачу токена.** Чтобы ты поработал в боте клиента, клиент сам приглашает тебя соредактором (в боте → «Доступ» → email или ссылка, роль Viewer/Editor/Admin). Свой MCP-токен или пароль клиент никогда не присылает — и ты его не просишь.
- **`list_bots` и `site_list` показывают всё сразу**: твои собственные проекты и те, куда тебя пригласили — у чужих в ответе есть `ownerName` (имя владельца) и `accessRole` (твоя роль в этом конкретном проекте: OWNER / ADMIN / EDITOR / VIEWER). Так ты сразу видишь, где ты владелец, а где гость с ограниченной ролью.
- **Передавай `botId`/`siteId` явно** в каждом вызове инструмента — ассистент не хранит «текущий проект». Переключение между проектами клиентов — это просто другой `botId` в следующем вызове, оно не меняет твой аккаунт и не путает данные между проектами.
- **Доступ проверяется заново на каждый запрос.** Если клиент поменял тебе роль или вовсе убрал из соредакторов, следующий же вызов к этому проекту откажет — без повторной настройки токена и без задержки.
- **Бери минимально нужную роль.** Viewer — чтобы посмотреть и оценить задачу, Editor — чтобы собирать и публиковать сценарии, Admin — только если по договорённости настраиваешь рассылки или параметры бота.
- **Никогда не проси пароль от аккаунта клиента или его MCP-токен.** Единственный штатный способ работать в чужом проекте — приглашение с ролью; свой токен отзывай сам в кабинете, если он утёк.

## Безопасность

Токен = доступ к аккаунту по API в пределах его прав. Выдавай агенту минимально нужные права (для знакомства — «Только чтение»). Не коммить токен; держи в `env`. В конфигах храни ссылку `${RETENSY_MCP_TOKEN}`, не само значение.

## Лицензия

MIT — см. [LICENSE](LICENSE).
