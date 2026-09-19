# retensy-mcp

[![CI](https://github.com/retensy/retensy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/retensy/retensy-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@retensy/mcp.svg)](https://www.npmjs.com/package/@retensy/mcp)
[![node](https://img.shields.io/node/v/@retensy/mcp.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP-сервер (+ скилл для Claude Code) для **сборки и публикации воронок/автоматизаций ботов (Telegram, MAX и Instagram)** в сервисе [retensy `/bots`](https://bots.retensy.com/bots): из текстового описания → валидный граф сценария → заливка и публикация через API.

- 🤖 **30 инструментов сборки/публикации**: `list_bots`, `list_graphs`, `list_channels`, `get_graph`, `create_graph`, `update_graph`, `edit_graph_live`, `patch_graph`, `dry_run`, `publish_graph`, `import_funnel`, `list_templates`, `create_graph_from_template`, `clone_graph`, `copy_graph`, `rename_graph`, `set_active_graph`, `delete_graph`, `upload_file`, `list_files`, `delete_file`, `graph_analytics`, `list_bot_users`, `list_links` (+ `setup`/`set_token`).
- 📝 **Статьи блога** (тот же токен `zmcp_…`): `article_publish`, `article_update`, `article_list`, `article_get` — публикация статей в Markdown (как README на GitHub) в раздел **/articles**.
- 📎 **Медиа**: `upload_file` грузит фото/видео/документы в библиотеку **/bots/files** (до 50 МБ) и возвращает публичный URL — его вставляешь в медиа-карточку сценария.
- 🧠 **Скилл `build-bot-funnel`**: учит агента собирать корректный граф (типы узлов, ветки, кнопки, задержки) и проверять его перед публикацией. Поддерживает Telegram, MAX и Instagram.
- 📦 **Без зависимостей** — чистый Node ≥18, ставится и запускается сразу.

### Поддерживаемые платформы

| Платформа | Онбординг | Триггеры входа | Ограничения |
|---|---|---|---|
| **Telegram** | Токен бота (BotFather) | `/start`, команды, callback, текст, рассылки | Полный функционал |
| **MAX** | Токен бота (MAX Developer) | Команды, callback, текст | Без SUBSCRIBED/reply-клавиатур (мягкие предупреждения) |
| **Instagram** | OAuth в `/bots/instagram` (без токена) | Комментарий/Direct/Ответ на историю/Упоминание | Ограниченный набор узлов; DELAY ≤ 24ч; ASK_QUESTION только TEXT/EMAIL/PHONE/NUMBER/CONTACT (CONTACT = ручной ввод номера); без рассылок |

---

## Установка

### Вариант A — как плагин Claude Code (рекомендуется)

```text
/plugin marketplace add retensy/retensy-mcp
/plugin install retensy-mcp@retensy
```

Подтянутся и MCP-сервер `bot-graph`, и скилл `build-bot-funnel`. Проверить: `/mcp` и `/plugin`.

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
| `list_graphs(botId)` | графы (сценарии) бота |
| `list_channels(botId)` | каналы/группы, подключённые к боту (chatId для условия SUBSCRIBED) |
| `list_integrations()` | подключённые сервисы (amoCRM, Битрикс24, GetCourse, Я.Метрика): `id` = `connectionId` для действий сценария |
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
| `article_list()` | свои статьи блога (id, slug, title, просмотры) |
| `article_get(slug)` | статья по slug (Markdown content, excerpt, обложка) |
| `article_publish(content, title?, cover?, excerpt?)` | новая статья (Markdown; title из `# ...`, если не задан; обложка из `cover`-URL или 1-й картинки → OG; `excerpt` явно или авто) → id, slug, URL |
| `article_update(id, content, title?)` | обновить свою статью по id |

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
