# retensy-mcp

[![CI](https://github.com/retensy/retensy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/retensy/retensy-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@retensy/mcp.svg)](https://www.npmjs.com/package/@retensy/mcp)
[![node](https://img.shields.io/node/v/@retensy/mcp.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP-сервер (+ скилл для Claude Code) для **сборки и публикации воронок/автоматизаций ботов (Telegram, MAX и Instagram)** в сервисе [retensy `/bots`](https://bots.retensy.com/bots): из текстового описания → валидный граф сценария → заливка и публикация через API.

- 🤖 **Сценарии ботов**: `list_bots`, `list_graphs`, `list_channels`, `get_graph`, `create_graph`, `update_graph`, `edit_graph_live`, `patch_graph`, `dry_run`, `publish_graph`, `import_funnel`, `list_templates`, `create_graph_from_template`, `clone_graph`, `copy_graph`, `rename_graph`, `set_active_graph`, `delete_graph`, `upload_file`, `list_files`, `delete_file`, `graph_analytics`, `list_bot_users`, `list_links` (+ `setup`/`set_token`).
- 🔌 **Боты и сервисы**: `create_bot` (Telegram/MAX по токену), `bot_stop`/`bot_resume`, `connect_integration`/`disconnect_integration` (amoCRM, Битрикс24, GetCourse, Я.Метрика, ЮKassa; Google Таблицы — ссылкой на вход Google; креды хранятся зашифрованными и не возвращаются), `integration_catalog`/`integration_status`/`integration_test` (каталог Integration Core и живая проверка подключения), `integration_ingress_url` (URL ингресса «Внешних событий» — Tilda, JivoSite, WooCommerce, amoCRM, Битрикс24, GetCourse, CloudPayments, Robokassa, Т-Банк, Prodamus — для `TRIGGER_WEBHOOK`), `channel_post` (пост в канал Telegram/MAX).
- 📣 **Рассылки**: `broadcast_preview` (размер аудитории), `broadcast_send` (сейчас или по расписанию, сразу по нескольким ботам; сообщения или запуск сценария), `broadcast_list`/`broadcast_get`/`broadcast_cancel`, повторяющиеся (`broadcast_recurring`), черновики (`broadcast_drafts`, `broadcast_duplicate`) + скилл `send-broadcast`.
- 🔗 **Ссылка вместо отказа**: что нельзя сделать через API (вход через Google/Facebook, оплата тарифа, вход в аккаунт) — инструмент возвращает прямую ссылку и одну строку, что сделать.
- 📝 **Статьи блога** (тот же токен `zmcp_…`): `article_publish`, `article_update`, `article_list`, `article_get` — публикация статей в Markdown (как README на GitHub) в раздел **/articles**.
- 🧠 **ИИ-агенты и база знаний**: `agent_list`/`agent_get`/`agent_create`/`agent_update`/`agent_publish`/`agent_health`/`agent_test_chat`/`agent_unanswered`, `kb_docs`/`kb_add_qa`/`kb_add_text`/`kb_add_site`/`kb_reindex` — настройка ИИ-агента и его базы знаний (раздел «ИИ-агенты»).
- 📎 **Медиа**: `upload_file` грузит фото/видео/документы в библиотеку **/bots/files** (до 50 МБ) и возвращает публичный URL — его вставляешь в медиа-карточку сценария.
- 🌐 **Сайты из блоков** (раздел «Страницы»): создание, правка операциями (блоки, Zero-блок со свободной вёрсткой, код блока, папки страниц, дизайны, шаблоны из библиотеки), публикация и откат, свои домены, заявки из форм и куда их доставлять — инструменты `site_*` + скилл `build-site`.
- 🧠 **Скилл `build-bot-funnel`**: учит агента собирать корректный граф (типы узлов, ветки, кнопки, задержки) и проверять его перед публикацией. Поддерживает Telegram, MAX и Instagram.
- 📦 **Без зависимостей** — чистый Node ≥18, ставится и запускается сразу.

### Поддерживаемые платформы

| Платформа | Онбординг | Триггеры входа | Ограничения |
|---|---|---|---|
| **Telegram** | Токен бота (BotFather) → `create_bot` | `/start`, команды, callback, текст, рассылки | Полный функционал |
| **MAX** | Токен бота (MasterBot в MAX) → `create_bot` | Команды, callback, текст | Без SUBSCRIBED/reply-клавиатур (мягкие предупреждения) |
| **Instagram** ⏸ | OAuth в `/bots/instagram` (без токена) — **сейчас выключен в сервисе** (подключение новых IG-ботов скрыто, флаг `instagram.enabled`) | Комментарий/Direct/Ответ на историю/Упоминание | Ограниченный набор узлов; DELAY ≤ 24ч; ASK_QUESTION только TEXT/EMAIL/PHONE/NUMBER/CONTACT (CONTACT = ручной ввод номера); без рассылок |

---

## Установка

### Вариант A — как плагин Claude Code (рекомендуется)

```text
/plugin marketplace add retensy/retensy-mcp
/plugin install retensy-mcp@retensy
```

Подтянутся MCP-сервер и скиллы `build-bot-funnel`, `build-site`, `send-broadcast`. Проверить: `/mcp` и `/plugin`.

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

Токен даёт **полный доступ** к управлению твоими ботами (как вход в аккаунт).

1. Залогинься на https://bots.retensy.com → открой **`/bots/mcp-tokens`**.
2. Создай токен → скопируй секрет `zmcp_...` (показывается один раз).
3. Передай токен любым способом:
   - **просто пришли его агенту в чат** — он вызовет инструмент `set_token` и сохранит токен в `~/.retensy-bot-graph/token` (применяется сразу, без рестарта), **или**
   - `env` в `.mcp.json` (Вариант B), **или**
   - переменной окружения: PowerShell `setx RETENSY_MCP_TOKEN "zmcp_..."`, bash `export RETENSY_MCP_TOKEN="zmcp_..."`.

Отозвать токен можно там же — доступ блокируется мгновенно.

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
| `create_bot(platform, token?, name?)` | подключить бота Telegram/MAX по токену; `WEB` — чат-виджет для сайта без токена → botId, key, snippet (Instagram → ссылка на кабинет) |
| `web_widget_snippet(botId)` | код вставки чат-виджета на сайт |
| `bot_stop(botId)` / `bot_resume(botId)` | остановить / запустить бота |
| `list_graphs(botId)` | графы (сценарии) бота |
| `list_channels(botId)` | каналы/группы, подключённые к боту (chatId для условия SUBSCRIBED) |
| `list_integrations()` | подключённые сервисы (amoCRM, Битрикс24, GetCourse, Я.Метрика, ЮKassa): `id` = `connectionId` для действий сценария |
| `connect_integration(provider, creds?, title?, connectionId?)` | подключить/обновить сервис; без кредов — какие поля нужны; Google Таблицы → ссылка входа Google, Instagram → ссылка на кабинет |
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
| `site_list()` | сайты пользователя (id, mode, url, publishedRevision) |
| `site_create(title, slug?, template?)` | новый сайт из блоков → `id`; `template` (`starter`/`blank`/`mini-landing`) — сразу черновик из шаблона |
| `site_get(siteId, saveToFile?)` | модель сайта (`revision`, `draft`, `versions[]` публикаций) |
| `site_schema()` | JSON Schema модели и операций — читать перед правкой |
| `site_edit(siteId, ops[]?, revision?, init?)` | правка операциями (`init`: `starter`/`blank`/`mini-landing`; только `init` — черновик из шаблона), всё или ничего: страницы и папки, блоки, Zero-элементы, код блока (`get/set/add_block_code`), дизайны и их кадры, шаблоны (`add_template`), тема, попапы |
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
| `broadcast_send(name, botIds, messages \| graphId, tagsAll?, tagsNone?, scheduledAt?, draftId?)` | отправить сейчас / запланировать; по нескольким ботам; или запуск сценария |
| `broadcast_cancel(broadcastId)` | отменить запланированную/идущую |
| `broadcast_recurring(action, …)` | повторяющиеся рассылки: list / create (DAILY·MONTHLY·YEARLY) / stop |
| `broadcast_drafts(action, …)` | черновики: list / get / create / update / delete |
| `broadcast_duplicate(broadcastId` или `draftId)` | копия рассылки или черновика — новый черновик «… (копия)» |
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
| `dialog_handoff(botId, chatId, active)` | передать диалог оператору (бот и ИИ молчат) / вернуть боту ¹ |
| `bot_users_import(botId, rows)` | добавить подписчикам метки и новые поля (`rows: [{chatId, tags?, variables?}]`; существующие поля не перезаписываются) |
| `bot_runs(botId` или `runId)` | журнал прогонов бота / один прогон с шагами |
| `bot_delete(botId, confirm:true)` | удалить бота навсегда (только по явной просьбе) |
| `web_widget_settings(botId, settings?)` | вид чат-виджета: прочитать / изменить (поля накладываются на текущие) |
| `integration_update(connectionId, title?, creds?)` | переименовать подключение или заменить ключи |
| `integration_calls(connectionId?, ok?, limit?)` | журнал вызовов внешних сервисов из сценариев (ошибки, попытки, runId) ¹ |
| `site_lead_status(siteId, leadId, status)` | статус заявки сайта: `NEW`\|`IN_PROGRESS`\|`DONE`\|`REJECTED` ¹ |

¹ — нужен бэкенд с веткой `feat/battery-completion` (до деплоя вернёт 404).

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
| Instagram (`create_bot`, `connect_integration`) | `/bots/connect` — подключается входом через Facebook; сейчас выключен в сервисе |
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

## Безопасность

Токен = доступ к аккаунту по API. Не коммить его; держи в `env`. В конфигах храни ссылку `${RETENSY_MCP_TOKEN}`, не само значение.

## Лицензия

MIT — см. [LICENSE](LICENSE).
