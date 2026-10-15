---
name: build-publication-chain
description: Собрать «Цепочку публикаций» (автопостинг source → обработка → назначения) для сервиса /bots через MCP retensy-mcp — спроектировать граф (DAG-дерево с ветвлением), настроить общий/раздельный ИИ-адаптер, UTM на назначение, квоту, режим согласования и 1→N фан-аут (несколько TG-каналов + VK + MAX одним шагом). Использовать, когда пользователь описывает автопостинг/репост между площадками словами и просит «настроить цепочку», «автоматически репостить», «разослать по каналам», «собрать схему публикаций».
---

# Сборка цепочки публикаций (retensy /bots → «Публикации» → «Цепочки»)

Превращает описание автопостинга в `PublishChain` и заливает его через MCP-инструменты `chain_*`
сервера `retensy-mcp`. Цепочка — это **источник → граф обработки → одно или несколько назначений**:
один пост в источнике может размножиться на N каналов за один проход, с общей или раздельной
обработкой на пути к каждому.

## Когда применять
Пользователь хочет: «публикуй из этого Telegram-канала во все остальные», «перепощивай VK в
Telegram с меткой UTM», «собери контент-хаб: один канал — источник, остальные 10 — зеркала»,
«прогоняй через ИИ и переписывай под каждую площадку». Не для разового поста (`channel_post`/`vk_post`)
и не для рассылок по подписчикам бота (`broadcast_*`) — цепочка работает с ПОСТАМИ ИСТОЧНИКА, не с
аудиторией бота.

## Модель данных — коротко

`PublishChain` = `{id, name, enabled, approvalMode, source, utmDefaults, createdAt/updatedAt, И ЛИБО
legacy (steps[]+destinations[]) ЛИБО граф (nodes[]+edges[])}`.

- **`source`** — ВСЕГДА отдельное top-level поле, в графовом режиме тоже. Узел `SOURCE` в `nodes` —
  просто маркер-корень графа, он НЕ дублирует конфигурацию источника.
  `{type: "TELEGRAM"|"VK"|"RSS", botId?, chatId?, accountId?, rssUrl?}`.
  - TELEGRAM: `botId`+`chatId` — свой привязанный канал (`chain_destinations_catalog` → `telegram[]`,
    или `bot_channel_list`/`list_channels`). Источник срабатывает сразу по событию (webhook).
  - VK: `accountId` — подключённый VK-аккаунт (`chain_destinations_catalog` → `vk[]`, или `vk_status`).
    Опрос раз в 3 минуты.
  - RSS: `rssUrl` — любой http(s)-URL. Опрос раз в 3 минуты.

- **Граф (режим «Схема»)** — приоритетнее legacy, если `nodes` непуст. Дерево-с-ветвлением
  (**out-tree**), НЕ произвольный DAG: у любого не-`SOURCE` узла **ровно одно** входящее ребро;
  ветвление делается НЕСКОЛЬКИМИ исходящими рёбрами ОДНОГО узла (например, один общий `AI_ADAPT` →
  рёбра на 10 узлов `DESTINATION`). Слияния путей (несколько родителей у узла) не поддерживается.
  ```
  nodes: [{ id, type: SOURCE|FILTER|TEXT_TRANSFORM|AI_ADAPT|UTM|DELAY|DESTINATION, x?, y?,
            step?: {...поля шага, см. ниже — только для type≠SOURCE/DESTINATION},
            destination?: {id, type: TELEGRAM|MAX|VK|INSTAGRAM, botId?, chatId?, accountId?, utmOverride?} }]
  edges: [{ fromNodeId, toNodeId }]
  ```
  `x`/`y` — координаты на холсте, чисто для UI редактора; можно не задавать (MCP-агенту они не нужны).
  Узел — «мешок полей»: только поля своего `type` что-то значат.

- **Legacy (линейный режим, `nodes` пуст)** — проще для одного source → один путь обработки → N
  назначений БЕЗ ветвления посередине (ветвление всё равно есть — просто неявное, как «один путь,
  потом веер в destinations»):
  ```
  steps: [{ type: FILTER|TEXT_TRANSFORM|AI_ADAPT|UTM|DELAY, ...поля }]   // применяются по порядку ко всем
  destinations: [{ type: TELEGRAM|MAX|VK|INSTAGRAM, botId?, chatId?, accountId?, utmOverride? }]
  ```
  Используй legacy, когда обработка ОДИНАКОВА для всех назначений (линия, без развилок). Переходи на
  граф, когда назначениям нужна РАЗНАЯ обработка (например, свой тон ИИ под каждую площадку) или нужно
  явно показать ветвление в UI.

- **Шаги обработки (`step`/`steps[]` — поля по `type`)**:
  - `FILTER`: `containsAny[]`, `notContainsAny[]`, `hasMedia` (true=только с медиа, false=только без,
    null=не проверять), `minLength`, `requireHashtag`.
  - `TEXT_TRANSFORM`: `prependText`, `appendText`, `removeLinks`, `removeHashtags`, `replaceFrom`/`replaceTo`.
  - `AI_ADAPT`: `aiMode: NONE|LIGHT|FULL`, `targetPlatform`, `tone`, `targetLength`, `useEmoji`,
    `useHashtags`, `preserveLinks` (default true), `preserveAdMarkers` (default true), `instructions`.
    Тратит AI-бюджет тарифа (`bot_ai_usage`) — ОДИН РАЗ на элемент источника, даже если один узел
    `AI_ADAPT` кормит 10 назначений (общий узел = одна оплата на пост, не 10).
  - `UTM`: самостоятельного конфига не несёт — разметку делает `utmDefaults`/`destination.utmOverride`
    (ниже), шаг `UTM` в графе просто фиксирует момент применения в цепочке обработки.
  - `DELAY`: `delaySeconds`.

- **`destination`/`destinations[]`**: `{id (строка, стабильный ключ идемпотентности — не меняй после
  первого сохранения), type: TELEGRAM|MAX|VK|INSTAGRAM, botId?, chatId?, accountId?, utmOverride?}`.
  TELEGRAM/MAX — `botId`+`chatId` (свой привязанный канал, бот должен быть админом). VK — `accountId`.
  **INSTAGRAM принимается моделью, но публикация ГАРАНТИРОВАННО уходит в `SKIPPED`** (не `FAILED`) —
  нет медиа-процесса в этой волне; не предлагай его пользователю как рабочее назначение, только если
  он сам просит «добавить на будущее».

- **`utmDefaults`** (на уровне цепочки) / **`destination.utmOverride`** (на уровне назначения, `null` =
  взять `utmDefaults`): `{enabled, source, medium, campaign, content, term,
  overridePolicy: KEEP_EXISTING|OVERRIDE (default KEEP_EXISTING), skipInternalLinks (default true)}`.
  Ставь РАЗНЫЙ `utmOverride.source`/`campaign` на разных назначениях, если нужно различать трафик по
  каналам в аналитике — иначе один `utmDefaults` на всю цепочку.

- **`approvalMode`**: `NONE` (публикуется сразу) | `AI_ONLY` (на согласование — только то, что прошло
  через `AI_ADAPT` с режимом ≠ `NONE`) | `ALL` (вообще всё, даже без ИИ). Согласование — через
  `chain_runs` (ищи `AWAITING_APPROVAL`) → `chain_approve`/`chain_reject`.

- **Квота**: каждое назначение = отдельная публикация в месячной квоте владельца (как `channel_post`/
  `vk_post`) — 10 TG-каналов + 2 VK + 4 MAX в одной цепочке = 16 публикаций за один проход источника,
  это не одна операция с точки зрения лимита тарифа. Предупреди пользователя при большом фан-ауте.

## Рабочий процесс

1. **Собери вводные.** Источник (платформа + канал/аккаунт/URL), что меняется в тексте по пути
   (фильтры, переписывание, ИИ), куда публикуется (один список площадок или разные пути на разные
   площадки), нужно ли согласование, нужна ли UTM-метка и различается ли она по каналам.

2. **Найди id источника/назначений одним вызовом — `chain_destinations_catalog`** (без `botIds` —
   обойдёт все боты владельца): вернёт `{telegram: [{botId, botName, chatId, title, type, status}],
   max: [{...}], vk: [{id, label, enabled, isDefault}]}`. Это замена ручного обхода `list_bots` +
   `list_channels` на каждого бота + `vk_status`. Бот должен быть администратором канала, иначе он не
   попадёт в `linked-chats` этого бота (и в каталог) — такие случаи решаются в самом /bots, не здесь.

3. **Выбери режим:**
   - Одна обработка на всех → **legacy** (`steps`+`destinations`), проще и короче JSON.
   - Разная обработка по ветвям, либо хочешь явную схему в UI, либо общий дорогой узел (например,
     один `AI_ADAPT`, кормящий много каналов, чтобы не платить за адаптацию N раз) → **граф**
     (`nodes`+`edges`).

4. **Собери граф/legacy и проверь офлайн — `chain_validate`** (nodes/edges напрямую или
   `chain: {...}`), ПЕРЕД отправкой на сервер. Зеркалит серверный `ChainGraphValidator`: ровно один
   `SOURCE` без входящих рёбер, у любого другого узла ровно одно входящее, `DESTINATION` без исходящих,
   без циклов, каждый `DESTINATION` достижим от `SOURCE`. Возвращает `{valid, errors: [{nodeId,
   message}]}` — почини всё, что найдёт, прежде чем звать `chain_create`/`chain_update`. Для legacy
   (`steps`+`destinations`) валидация не нужна — она всегда корректна по построению.

5. **Создай/обнови — `chain_create`/`chain_update`.** 400 — не хватает полей или источник/назначение
   не найдены/не твои (чаще всего: бот не админ канала, или `accountId` не свой); в графовом режиме
   400 также приходит как «Схема цепочки: <причины>» — те же правила, что в п.4, просто сервер —
   последнее слово. 409 — прямой цикл с другой твоей цепочкой (A→B, когда уже есть B→A): переосмысли
   направление, не пытайся обойти через третью цепочку (сервер ловит только прямой случай — не создавай
   его намеренно).

6. **Включи — `chain_enable`** (черновик создаётся выключенным, если явно не передать `enabled:true`).
   TELEGRAM начнёт публиковать сразу по следующему посту в источнике; VK/RSS — со следующего опроса
   (до 3 минут).

7. **Проверь первый прогон — `chain_runs`** (page/size режут список на стороне MCP, бэкенд отдаёт
   всё целиком). Статусы: `PENDING→RUNNING→DONE|FAILED`, либо `AWAITING_APPROVAL` (approvalMode),
   либо `SKIPPED` (не прошло фильтр / loop-guard / назначение исчезло / Instagram). `FAILED` с
   транзиентной причиной ретраится автоматически (до 5 раз, бэкофф); постоянная ошибка (бот не админ,
   квота кончилась, VK отклонил) — сразу `FAILED` без ретраев, почини причину и `chain_retry` вручную.

8. **Отчитайся**: источник, число шагов/ветвей, число назначений по площадкам, включена ли, режим
   согласования, ссылка/id цепочки.

## Пример 1 — простой линейный репост (legacy)

TG-канал → убрать ссылки → разметить UTM → в VK-сообщество.

```json
{
  "name": "TG блог → VK стена",
  "enabled": true,
  "approvalMode": "NONE",
  "source": { "type": "TELEGRAM", "botId": "<botId из chain_destinations_catalog.telegram>", "chatId": 1001 },
  "steps": [
    { "type": "TEXT_TRANSFORM", "removeLinks": true },
    { "type": "UTM" }
  ],
  "destinations": [
    { "type": "VK", "accountId": "<accountId из chain_destinations_catalog.vk>",
      "utmOverride": { "enabled": true, "source": "vk", "medium": "repost", "campaign": "blog" } }
  ],
  "utmDefaults": { "enabled": true, "source": "tg", "medium": "repost", "campaign": "blog" }
}
```

## Пример 2 — «1 источник → общий ИИ → 10 TG-каналов + 2 VK + 4 MAX» (граф, фан-аут)

Один общий узел `AI_ADAPT` адаптирует пост под нейтральный деловой тон ОДИН раз, затем веером — на
16 назначений без повторной оплаты ИИ за каждое. Ниже сокращённо (3 назначения для примера, остальные —
та же форма узла/ребра с новым `id`).

```json
{
  "name": "Контент-хаб: 1 источник → ИИ → все каналы",
  "enabled": true,
  "approvalMode": "AI_ONLY",
  "source": { "type": "TELEGRAM", "botId": "<botId>", "chatId": 1001 },
  "utmDefaults": { "enabled": true, "source": "hub", "medium": "crosspost", "campaign": "2026q4" },
  "nodes": [
    { "id": "src", "type": "SOURCE" },
    { "id": "ai1", "type": "AI_ADAPT",
      "step": { "type": "AI_ADAPT", "aiMode": "LIGHT", "tone": "деловой, нейтральный",
                "preserveLinks": true, "preserveAdMarkers": true } },
    { "id": "d-tg-1", "type": "DESTINATION",
      "destination": { "id": "d-tg-1", "type": "TELEGRAM", "botId": "<botId>", "chatId": 2001 } },
    { "id": "d-tg-2", "type": "DESTINATION",
      "destination": { "id": "d-tg-2", "type": "TELEGRAM", "botId": "<botId>", "chatId": 2002 } },
    { "id": "d-vk-1", "type": "DESTINATION",
      "destination": { "id": "d-vk-1", "type": "VK", "accountId": "<accountId1>",
                        "utmOverride": { "enabled": true, "source": "vk", "medium": "crosspost", "campaign": "2026q4" } } },
    { "id": "d-max-1", "type": "DESTINATION",
      "destination": { "id": "d-max-1", "type": "MAX", "botId": "<maxBotId>", "chatId": 3001 } }
  ],
  "edges": [
    { "fromNodeId": "src", "toNodeId": "ai1" },
    { "fromNodeId": "ai1", "toNodeId": "d-tg-1" },
    { "fromNodeId": "ai1", "toNodeId": "d-tg-2" },
    { "fromNodeId": "ai1", "toNodeId": "d-vk-1" },
    { "fromNodeId": "ai1", "toNodeId": "d-max-1" }
  ]
}
```

Чтобы собрать все 16 назначений (10 TG + 2 VK + 4 MAX): пройдись по `chain_destinations_catalog`
результату (`telegram[]`, `vk[]`, `max[]`), для каждого выбранного канала добавь один узел
`DESTINATION` с уникальным `id` и одно ребро `{fromNodeId: "ai1", toNodeId: "<тот же id>"}` — узел
`ai1` остаётся общим, обработка оплачивается один раз на пост источника, не 16.

## Пример 3 — раздельная обработка по ветвям (граф, разный тон на разные площадки)

Источник → в Telegram без изменений, в VK — через ИИ с более разговорным тоном.

```json
{
  "name": "TG как есть, VK — адаптировано",
  "source": { "type": "TELEGRAM", "botId": "<botId>", "chatId": 1001 },
  "nodes": [
    { "id": "src", "type": "SOURCE" },
    { "id": "d-tg", "type": "DESTINATION",
      "destination": { "id": "d-tg", "type": "TELEGRAM", "botId": "<botId>", "chatId": 2001 } },
    { "id": "ai-vk", "type": "AI_ADAPT",
      "step": { "type": "AI_ADAPT", "aiMode": "LIGHT", "tone": "неформальный, дружелюбный" } },
    { "id": "d-vk", "type": "DESTINATION",
      "destination": { "id": "d-vk", "type": "VK", "accountId": "<accountId>" } }
  ],
  "edges": [
    { "fromNodeId": "src", "toNodeId": "d-tg" },
    { "fromNodeId": "src", "toNodeId": "ai-vk" },
    { "fromNodeId": "ai-vk", "toNodeId": "d-vk" }
  ]
}
```

(Источник ветвится напрямую на два пути — это тоже «несколько исходящих у одного родителя», просто
родитель здесь `SOURCE`, а не промежуточный узел обработки.)

## Авторизация MCP

Персональный токен (`/bots/mcp-tokens`, `zmcp_…`). Нет токена/ошибка доступа → вызови `setup`,
объясни шаги пользователю, сохрани токен через `set_token`. Также работают env `RETENSY_MCP_TOKEN`
и session-cookie.

## Если возможности не хватает

При неудаче инструмента сервер шлёт анонимный отчёт на `POST /api/mcp/report` (без секретов) —
не выдумывай обходных путей для того, чего нет в этой схеме, скажи прямо и не повторяй падающий
вызов по кругу. Пользователь может выключить отчёты `RETENSY_MCP_TELEMETRY=off`.
