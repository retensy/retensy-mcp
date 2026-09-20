# Формат графа `retensy-bot-graph`

## Контейнер импорта
```json
{
  "format": "retensy-bot-graph",
  "version": 1,
  "name": "Название воронки",
  "nodes": [ /* TgNode[] */ ],
  "edges": [ /* TgEdge[] */ ],
  "canvasMeta": {}
}
```
При заливке через MCP в `update_graph` передаются только `nodes`, `edges`, `canvasMeta`, `name`.

## Узел (TgNode)
```json
{ "id": "<uuid>", "type": "<NodeType>", "config": { ... }, "position": { "x": 0, "y": 0 } }
```
- `id` — валидный UUID (8-4-4-4-12), уникальный.
- `position` — раскладка на холсте (слева направо: шаг x ≈ 420; ветки разносим по y).

## Ребро (TgEdge) — «стрелка»
```json
{ "id": "<uuid>", "sourceNodeId": "<uuid>", "sourceHandle": "next", "targetNodeId": "<uuid>" }
```
`sourceHandle` — какой выход узла используется (см. ниже).
- `id`, `sourceNodeId`, `targetNodeId` — **валидные UUID** (бэкенд десериализует их как `java.util.UUID`; короткая строка вроде `"m1"` → HTTP 400 при заливке). `id` уникален среди рёбер.

## Типы узлов (NodeType) и их config

### Триггеры (точки входа, корневые)

#### Telegram / MAX
- `TRIGGER_COMMAND` — `{ "isRoot": true, "command": "start" }` (команда без `/`). Первый — с `isRoot:true`.
- `TRIGGER_CALLBACK` — `{ "matchMode": "EQUALS"|"STARTS_WITH", "value": "<callback_data>" }`
- `TRIGGER_TEXT` — `{ "matchMode": "ANY"|"EQUALS"|"CONTAINS"|"REGEX", "value": "..." }`
- `BROADCAST_FILTER` — режим рассылки (если есть — единственный триггер).
- `TRIGGER_PAYMENT` — в кассе владельца прошла оплата, **не связанная с диалогом в боте**
  (продажа по ссылке из рассылки, оплата мимо сценария).
  `{ "minAmount": "1000", "descriptionContains": "курс" }` — оба фильтра необязательны.
  **Ставь хотя бы один фильтр:** без них сценарий будет запускаться на КАЖДУЮ оплату в кассе.
  Прогон headless (подписчика нет) — узлы отправки адресуются через `config.target`, иначе
  сообщение отправить некому. Обычное применение — не написать в чат, а создать сделку в CRM
  или дописать строку в таблицу.
  В контексте доступны: `{{payment.id}}`, `{{payment.amount}}`, `{{payment.status}}`,
  `{{payment.description}}`, `{{payment.currency}}`, плюс весь ответ ЮKassa как `body`.
  ⚠️ Чтобы поймать оплату ВНУТРИ сценария, этот триггер не нужен — веди ветку `paid`
  от блока `YOOKASSA_PAYMENT`.
- `TRIGGER_TG_EVENT` — любое событие Telegram, кроме обычного сообщения: вступил/вышел из канала,
  реакция, буст, заявка в закрытую группу, ответ в опросе и т.п.
  `{ "event": "<имя поля Update>", "filter": { ... }, "priority": 0 }`.
  Рабочие `event` (бэкенд их размечает, остальные молчат): `message`, `edited_message`,
  `callback_query`, `channel_post`, `edited_channel_post`, `chat_member`, `chat_join_request`,
  `my_chat_member`, `message_reaction`, `message_reaction_count`, `chat_boost`,
  `removed_chat_boost`, `poll`, `poll_answer`, `inline_query`, `chosen_inline_result`,
  `shipping_query`, `pre_checkout_query`.
  **НЕ работают** (Telegram их шлёт, но рантайм не разбирает): `business_*`, `chat_shared`,
  `users_shared`, `write_access_allowed`, `purchased_paid_media` — такой триггер не сработает.
  `filter` (все условия по И, пустое = не задано):
  `{"status":"member"|"left"|"kicked"|…}` — только там, где есть `member.status`
  (`chat_member`, `my_chat_member`); `{"chatId":"-1001234567890"}` — конкретный чат/канал
  (сравнение строкой, id каналов не влезают в int), доступен у 12 событий с `chat`;
  `{"text":"купить","textMode":"contains"|"equals"}` — только `message`/`edited_message`/
  `channel_post`/`edited_channel_post`. У `poll`/`poll_answer`/`inline_query`/
  `chosen_inline_result`/`shipping_query`/`pre_checkout_query` чата нет → фильтров тоже.
  Бот должен быть админом канала/группы, иначе события оттуда не придут.
- `TRIGGER_ANY_UPDATE` — `{}`, ловит ЛЮБОЙ апдейт. Приоритет самый низкий: срабатывает, только
  если не подошёл ни один конкретный триггер. Удобен как «ничего не понял» / отладка.
- `TRIGGER_WEBHOOK` — `{}`, точка входа сценария с источником WEBHOOK (не бот). Такие сценарии
  создаются в вебе; у графа бота этот триггер не сработает.
- ~~`TRIGGER_COMMENT`~~ — **мёртвый тип**: рантайм нигде не выставляет `event="comment"`, сработать
  он не может. Убран из палитры редактора. Комментарии Instagram — `TRIGGER_IG_COMMENT`.

#### Instagram (только для IG-ботов)
IG-боты не поддерживают команды (`/start`). Вход — через взаимодействие с контентом или директ:
- `TRIGGER_IG_DM` — `{ "isRoot": true, "keywords": "хочу, каталог" }` — входящее сообщение в Instagram Direct. Это дефолтный триггер нового IG-графа (бэкенд сеет его при создании). `keywords` (опц.) — список через запятую или с новой строки; **регистронезависимо, совпадение по вхождению (contains)**; пусто = любое сообщение.
- `TRIGGER_IG_COMMENT` — `{ "isRoot": true, "keywords": "купить, цена" }` — комментарий к посту или Reel бота. `keywords` (опц.) — список через запятую или с новой строки; регистронезависимый contains; пусто = любой комментарий.
- `TRIGGER_IG_STORY_REPLY` — `{ "isRoot": true, "keywords": "хочу, вопрос" }` — ответ на историю бота. `keywords` (опц.) — список через запятую или с новой строки; регистронезависимый contains; пусто = любой ответ.
- `TRIGGER_IG_STORY_MENTION` — `{ "isRoot": true }` — упоминание бота в истории подписчика. **Текста нет → фильтрация по ключевым словам не применяется**; срабатывает на каждое упоминание независимо от содержимого истории.

> **Разные слова — разные сценарии:** добавь **несколько триггеров одного типа** с разными `keywords`; бэкенд берёт **первый совпавший по порядку узлов**. Триггер-«ловушку» с пустыми `keywords` (ловит всё) ставь **последним** — иначе он заблокирует все нижестоящие ключевые слова.

Для всех IG-триггеров реакция бота отправляется через Instagram Messaging API в течение **24-часового окна** после последнего входящего действия пользователя.

### Сообщения
- `SEND_MESSAGE` —
  ```json
  { "_title": "Заголовок узла", "parseMode": "PLAIN"|"HTML"|"MARKDOWN",
    "text": "Текст сообщения",
    "cards": [ { "id": "c1", "type": "text", "text": "Текст сообщения" } ],
    "buttons": [ [ { "text": "Кнопка", "kind": "CALLBACK"|"URL", "value": "<url для URL; ПУСТО для CALLBACK>", "color": "", "track": true } ] ] }
  ```
  ВСЕГДА заполняй и `text`, и `cards[0].text` одинаково. `buttons` — массив рядов (каждый ряд — массив кнопок).
  - **Медиа-карточки** (`cards[].type`): `text`, `image`, `video`, `audio`, `file`, `voice`, `videonote` (кружок), `gallery` (альбом 2–10 фото), `question` (вопрос). У медиа-карточки ссылка на файл лежит в поле `url` (у `gallery` — массив `urls`). Сам файл (фото/видео/документ) в графе НЕ хранится — только URL. Чтобы получить URL, сперва загрузи файл инструментом **`upload_file`** (`path` локального файла или `url` для перезаливки) — он кладёт файл в библиотеку **/bots/files** и возвращает публичный `url`; его и вставляй в карточку. Примеры: `{ "id":"c2","type":"image","url":"https://bots.retensy.com/media/botmedia/<id>.jpg","text":"подпись (опц.)" }`, видео/аудио/файл/`voice`/`videonote` — так же с `url`; галерея — `{ "type":"gallery","urls":["https://…","https://…"] }`. Уже загруженные файлы — `list_files`, удалить — `delete_file`. Лимит 50 МБ; типы: image/video/audio/pdf/zip/doc(x)/xlsx/pptx/txt (SVG нельзя).
  - `parseMode:"HTML"` (дефолт редактора) — текст должен быть **безопасным Telegram-HTML**: разрешены только `b,strong,i,em,u,ins,s,strike,del,code,pre,a[href],tg-spoiler,br`. Любой другой тег/атрибут → ошибка публикации `HTML_NOT_SAFE`. Не уверен — ставь `PLAIN`.
  - **Кнопки-выборы (`kind:"CALLBACK"`)**: `value` ОСТАВЛЯЙ ПУСТЫМ (`""`). Бот сам сгенерит `callback_data` вида `n:<id узла>:<индекс>`, а переход задаётся ребром `btn_N` от кнопки. **Непустой `value`** трактуется как legacy-`callback_data` для отдельного узла `TRIGGER_CALLBACK` (у такой кнопки ребра `btn_N` быть не должно) — если поставить `value` обычной кнопке-выбору, переход по `btn_N` **сломается** (нажатие → `NO_MATCH`).
  - **Кнопки-ссылки (`kind:"URL"`)**: `value` = URL. Могут иметь `"track": true` — клики считаются, и на такой шаг можно сослаться из условия `LINK_CLICKED` (см. ниже).
  - **`color`** (опционально, и у CALLBACK, и у URL) — только стили, которые рендерит Telegram (как в основном боте / pengrad `ButtonStyle`): `""`=по умолчанию, `"#2EA6FF"`=primary (синий), `"#34C759"`=success (зелёный), `"#FF3B30"`=danger (красный). Других цветов нет.
  - **Режим «Вопрос» (`awaitReply: true`)** — сообщение задаёт вопрос и ждёт ответ (паркуется как `ASK_QUESTION`). Доп. поля: `"saveTo":"name"` (обязателен, `[a-z_][a-z0-9_]{0,63}`), `"inputKind":"TEXT"|"PHOTO"|"DOCUMENT"|"CONTACT"|"LOCATION"`, `"validator":"ANY"|"PHONE"|"EMAIL"|"REGEX"`, `"regex":"..."`, `"retryText":"..."`, `"maxAttempts":3`. Выходы — `valid` / `invalid` (как у `ASK_QUESTION`), плюс `btn_N` для кнопок.
  - **Канал ответа Instagram (`igReplyChannel`, только для IG-ботов)** — `"comment"` (по умолчанию) — публичный ответ под комментарием; `"dm"` — личное сообщение автору комментария (Private Reply). `"dm"` срабатывает только в графе с `TRIGGER_IG_COMMENT` (нужен `comment_id`): Meta разрешает **1 ЛС на комментарий**, 24-часовое окно на private reply не распространяется. Чтобы ответить и публично, и в ЛС — поставь два шага: один с `"igReplyChannel":"comment"`, второй с `"igReplyChannel":"dm"`.
- `SEND_PHOTO` — `{ "photoUrl": "https://...", "caption": "подпись (необязательно, ≤1024)", "igReplyChannel": "comment"|"dm" }` (`igReplyChannel` — только IG, см. `SEND_MESSAGE`). `photoUrl` можно получить через `upload_file`.

### Логика / ветвление
- `CONDITION` — проверка условий, выходы `yes` / `no`. `{ "match":"ALL"|"ANY", "conditions":[ { "kind":"...", "op":"...", "key":"...", "value":"..." } ] }`. `match:"ALL"` — все условия истинны; `"ANY"` — хотя бы одно. Полный список `kind`/`op`/полей — в разделе [«Условия CONDITION»](#условия-condition).
- `BRANCH` — `{ "cases":[ {"id":"c1","label":"...","expression":"var.x=='a'"} ], "hasDefault": false, "abTest": false }`. Выходы: `case_<id>` (+ `default`).
- `SWITCH` — развилка по ЗНАЧЕНИЮ, когда веток больше двух.
  `{ "expression":"{{var.http_status}}", "cases":[ {"id":"v1","value":"200","label":"Успех"},
  {"id":"v2","value":"404","label":"Не найдено"} ] }`. Выходы: `case_<id>` + `default` (есть всегда).
  Выражение рендерится как шаблон (обычно просто `{{var.x}}`) и сравнивается со `value` каждого
  случая **без учёта регистра и пробелов по краям**; первое совпадение выигрывает, иначе `default`.
  Отличия: `CONDITION` — бинарное да/нет, `BRANCH` — случайный выбор (A/B), `SWITCH` —
  детерминированный выбор по значению. Валидатор режет: пустое `expression`
  (`SWITCH_NO_EXPRESSION`), нет случаев (`SWITCH_NO_CASES`), пустое `value` (`SWITCH_EMPTY_VALUE`),
  повтор значения (`SWITCH_DUPLICATE_VALUE`), случай без ребра (`SWITCH_CASE_UNCONNECTED`).
  Ребро на `default` необязательно.
- `STOP_AND_ERROR` — `{ "message":"CRM не ответила: {{var.http_status}}" }`. Обрывает прогон и
  помечает его в журнале как ошибочный (`FAILED`), шаг — `ok:false` с этим текстом. Выходов нет,
  ничего подписчику не отправляет. Пустой `message` → «Сценарий остановлен с ошибкой».
- `ASK_QUESTION` — вопрос со сбором ответа. `{ "promptText":"...","saveTo":"name","inputKind":"TEXT"|"PHOTO"|"DOCUMENT"|"CONTACT"|"LOCATION","validator":"ANY"|"PHONE"|"EMAIL"|"REGEX","regex":"...","retryText":"...","maxAttempts":3 }`. `inputKind` (по умолчанию `TEXT`) — что ждём в ответ (`CONTACT` → телефон: в Telegram показывается кнопка «Поделиться номером», в MAX/Instagram кнопки нет — номер вводится вручную и принимается как телефон на всех платформах; `LOCATION` → `lat,lon`, `PHOTO`/`DOCUMENT` → file_id). Выходы `valid` / `invalid`.
- `END` — `{}` (конец ветки). **Не добавляй `END`**: ветка и так завершается на узле без исходящих рёбер; явный «конец сценария» бесполезен и убран из палитры редактора. Тип оставлен лишь для совместимости со старыми графами.

### Тайминги
- `DELAY` — пауза. Три вида (`kind`):
  - **`FIXED`** («Отправить через»): `{ "kind":"FIXED", "durationSec": 86400 }` — `durationSec` в **секундах** (60 = 1 мин, 3600 = 1 час, 86400 = 1 сутки). Редактор также пишет `{ "kind":"FIXED", "duration": 24, "unit":"MINUTES"|"HOURS"|"DAYS" }` (минуты/часы/дни — чтобы не вбивать большие числа). Для генерации проще `durationSec`.
  - **`TOMORROW`** («Отправить завтра»): `{ "kind":"TOMORROW", "time":"18:00" }` — завтра в указанное время `HH:mm` (МСК), относительно момента, когда пользователь дошёл до узла.
  - **`UNTIL`** («Отправить в»): `{ "kind":"UNTIL", "isoTimestamp":"2026-06-25T15:00:00Z" }` — конкретный момент в ISO-8601 (UTC). ⚠️ Рантайм читает только `isoTimestamp`; пары `isoDate`+`time` НЕ работают.
- `SCHEDULE` — `{ "isoDate":"2026-06-25", "time":"18:00", "timezone":"Europe/Moscow" }`. Выходы `scheduled` / `past`.

### Состояние / действия
- `SET_VARIABLE` (`{ "key":"name", "value":"..." }`), `ADD_TAG`/`REMOVE_TAG` (`{ "tag":"lead" }`), `FORMULA` (`{ "expression":"...", "saveTo":"name" }`)
- `ACTIONS` — непустой пакет действий `{ "actions":[ { "kind":"...", ...поля } ] }`. Допустимые `kind` (иначе ошибка `ACTION_UNKNOWN_KIND`):
  - **метки/автоворонки**: `add_tag`, `remove_tag`, `autoflow_add`, `autoflow_remove` — поле `tag` (`[a-z0-9_-]{1,64}`)
  - **профиль**: `set_field` — `key` (`[a-z_][a-z0-9_]{0,63}`) + `value`; `subscribe`, `unsubscribe`
  - **HTTP**: `external_request` — **основной способ сходить в чужой API**, те же поля и возможности,
    что у узла `CALL_WEBHOOK`: `url` + `method`/`headersJson`/`bodyTemplate`/`timeoutMs` +
    `saveStatusTo`/`saveBodyTo`/`extract`. Отличие одно: своих выходов у действия нет — сбой уводит
    ВЕСЬ блок `ACTIONS` в его выход `error` (если ребро нарисовано; нет — идём по `next`), а
    ветвиться по коду ответа надо следующим блоком `SWITCH`. **Платное действие** (как `CALL_WEBHOOK`):
    на бесплатном тарифе публикация падает с `PREMIUM_NODE_FORBIDDEN`.
    Ещё есть `subscriber_webhook` — `url` + `method`/`headersJson`/`bodyTemplate`
  - **уведомления**: `notify` (`text`), `subscriber_email` (`email`,`text`), `agent_chat`
  - **бот/шаг**: `stop_bot`, `delete_step_message`, `cancel_payment_subscription`
  - **Google Таблицы (работает)**: `gsheets_send` — дописать строку-заявку в таблицу: `{ "kind":"gsheets_send", "googleEmail":"me@gmail.com", "spreadsheetId":"<id таблицы>", "sheetName":"Лист1", "cells":["{{from.first_name}}","{{var.phone}}","{{var.email}}"] }`. `cells` — значения по порядку (шаблоны), бот дописывает их строкой в конец листа. Google-аккаунт подключается В ВЕБЕ (`/bots` → у действия кнопка «Подключить Google»), НЕ через MCP — у пользователя уже должен быть подключён `googleEmail`. Нужны `googleEmail` + `spreadsheetId` + непустой `cells[]` (иначе `ACTION_GSHEETS_INCOMPLETE`).
    Остальные четыре действия с таблицами тоже РАБОТАЮТ и тоже требуют `googleEmail` + `spreadsheetId`:
    `gsheets_get` (`range` → `saveTo`), `gsheets_update` (`range`, `values[]`), `gsheets_write_cell`
    (`cell`, `value`), `gsheets_read_cell` (`cell` → `saveTo`; пустая ячейка не ошибка — переменная станет `""`).
  - **CRM и внешние системы — РАБОТАЮТ** (реальные HTTP-клиенты на бэкенде, не заглушки).
    Всем им нужен **`connectionId`** — id подключения пользователя; без него действие падает
    «не выбрано подключение». **Узнать id: инструмент MCP `list_integrations`** (отдаёт
    `{id, provider, title, hint}`; сами креды не отдаются). Значения полей — шаблоны
    (`{{var.x}}`, `{{from.first_name}}`).
    - `amocrm_send` — создать сделку (+контакт): `connectionId`, `leadName`, опц. `price`,
      `pipelineId`, `statusId` (числа), `contactName`, `phone`, `email`. Если все три контактных
      поля после рендера пусты — сделка уходит без контакта. В переменные кладёт `amo_lead_id`
      и `amo_contact_id` (если amo его вернул).
    - `amocrm_update` — частичное обновление сделки: `connectionId`, `leadId` (обычно
      `{{var.amo_lead_id}}`), плюс те же `leadName`/`price`/`pipelineId`/`statusId`. Пустой
      `leadId` или отсутствие полей для обновления — отказ.
    - `bitrix24_call` — любой REST-метод Битрикс24: `connectionId`, **`b24method`** (именно так,
      не `method` — это имя занято HTTP-методом «Внешнего запроса»), `fields` — список пар
      `{key, value}` (ключ вида `fields[TITLE]` разворачивается во вложенную карту),
      `extract` — список `{path, saveTo}` для JsonPath-извлечения ответа в переменные.
    - `getcourse_send` — добавить/обновить пользователя: `connectionId`, `email`, опц. `userName`,
      `phone`, `groups` (CSV групп), `addfields` (карта доп.полей). Повторная заявка обновляет,
      а не дублирует.
    - `getcourse_order` — создать заказ: те же поля пользователя + `offerCode`, опц. `dealStatus`,
      `dealComment`. В переменные кладёт `gc_deal_id`, если GetCourse его вернул.
    - `yametrika_event` — офлайн-конверсия в Я.Метрику: `connectionId`, `idType`
      (`ClientId`|`Yclid`, по умолчанию `ClientId`), **`idValue`** (обязателен после рендера —
      пустой обрывает действие), опц. `target`, `price`, `currency` (по умолчанию `RUB`),
      `dateTime` (unix-секунды, по умолчанию «сейчас»).
  - **Единственные НЕ интегрированные действия**: `agent_chat` и `cancel_payment_subscription` —
    принимается как no-op с пометкой `integration_not_connected`.
  - **модерация группы**: `group_unban`, `group_kick`, `group_approve`, `group_decline`

### Внешнее / прочее
- `CALL_WEBHOOK` — `{ "url":"https://...", "method":"POST", "headersJson":"{\"X-Key\":\"…\"}",
  "bodyTemplate":"{...}", "timeoutMs":5000, "saveStatusTo":"http_status", "saveBodyTo":"http_body",
  "extract":[{"path":"$.id","saveTo":"crm_id"}] }`. Выходы `ok` (код 2xx) / `error` (код ≥ 400,
  сетевая ошибка, таймаут, отказ SSRF-гарда). Если ребра `error` нет — прогон идёт по `next`.
  - `timeoutMs` — на этот узел; 0/не задан = общий клиент (connect 5 с / read 7 с), иначе значение
    прижимается к диапазону **500…30000 мс**.
  - `saveStatusTo` / `saveBodyTo` — имена переменных для HTTP-кода и тела ответа целиком.
    Пишутся ВСЕГДА, в том числе на `error`: при сетевой ошибке код `0` и пустое тело (чтобы в
    переменной не осталось значение прошлого прогона). Тело длиннее 64 КБ обрезается.
    Это штатный способ разветвиться по коду ответа: `saveStatusTo` → `SWITCH`.
  - `extract` — разбор JSON-тела по JsonPath в переменные (работает только на валидном JSON).
- `AI_REPLY` — ответ модели.
  `{ "systemPrompt":"Ты консультант магазина.", "userPromptTemplate":"Вопрос: {{last_text}}",
  "sendToUser": true, "saveTo":"ai_answer", "quotaFallbackText":"Спросите менеджера" }`.
  `userPromptTemplate` обязателен (пустой → выход `error`). `sendToUser:true` — отправить ответ
  подписчику; `saveTo` — положить в переменную. **Узел платный** (`PREMIUM_NODES`): на бесплатном
  тарифе публикация падает с `PREMIUM_NODE_FORBIDDEN`. Если месячный AI-бюджет тарифа исчерпан,
  узел НЕ ошибка: отправляется `quotaFallbackText` (если задан) и сценарий идёт дальше по `next`.
  Температура задаётся глобально на сервере — поле `temperature` в конфиге рантайм не читает.
- `PAYMENT_LINK` — сообщение с кнопкой-ссылкой на оплату (сам платёж не проводит).
  `{ "paymentUrl":"https://example.com/pay?user={{from.id}}", "description":"Оплатите подписку:",
  "buttonText":"Оплатить" }`.
- `YOOKASSA_PAYMENT` — настоящий счёт на **кассу владельца бота** (деньги идут на его магазин,
  не на счёт сервиса) и, если нужно, ожидание оплаты.
  `{ "connectionId":"<id подключения ЮKassa>", "amount":"990", "description":"Доступ к курсу",
  "buttonText":"Оплатить", "timeoutMinutes":60 }`.
  - `connectionId` **обязателен** — это подключение из реестра с `provider=YOOKASSA`
    (`list_integrations`). Нет его → валидатор даёт `YK_NO_CONNECTION`. Касса обязана принадлежать
    владельцу бота, чужой id рантайм отвергает.
  - `amount` обязателен, > 0, можно шаблоном (`{{var.price}}`); `description` обязателен.
  - **Выходы: `next`, `paid`, `timeout`, `error`.** Ключевое правило: **поведение зависит от того,
    нарисовал ли ты ветку `paid`.**
    - Ветки `paid` НЕТ → блок просто шлёт ссылку и сразу идёт по `next` (как вёл себя узел раньше).
    - Ветка `paid` ЕСТЬ → сценарий встаёт на паузу и продолжится только после подтверждения
      оплаты кассой; не дождался за `timeoutMinutes` → уйдёт в `timeout`.
  - `timeoutMinutes` — 1…1440, по умолчанию 60. Имеет смысл только вместе с веткой `paid`.
  - Переменные после шага: `{{var.payment_url}}`, `{{var.payment_id}}`.
  - ⚠️ Чтобы `paid` вообще срабатывал, владелец должен вписать адрес уведомлений из карточки
    подключения в кабинет ЮKassa (событие `payment.succeeded`). Если этого не сделано, оплата
    пройдёт, а сценарий будет молча ждать до таймаута — это не баг графа.
- `CALL_WEBHOOK` — тоже платный узел, см. раздел «Внешнее / прочее». **В новых сценариях его не
  ставь**: узла больше нет ни в палитре, ни в меню — внешний запрос собирается действием
  `external_request` внутри `ACTIONS`. Тип живёт в рантайме только ради графов, где он уже стоит.
- Действие `external_request` внутри `ACTIONS` — **тоже платное**, гейт тот же.

## Лимиты тарифа, которые видит сборщик графов

- **Блоков в сценарии.** Публикация падает с `NODE_LIMIT_EXCEEDED` (в тексте — сколько блоков в
  графе и сколько даёт тариф). Ошибка на весь граф, `nodeId` пустой. Проверять нечем заранее:
  число блоков берётся из `nodes[]`, лимит — из тарифа владельца.
- **Число сценариев.** `create_graph`, `create_graph_from_template`, `clone_graph`, `copy_graph` и
  создание сценария в вебе отдают **HTTP 402** `{error, upgradeUrl}`, когда лимит исчерпан.
  Считаются сценарии, которые завёл человек; снимок публикации место не занимает.
- **Переменные** (глобальные и на сценарий) тоже лимитированы тарифом — сама подсистема переменных
  ещё не построена, поле лимита в тарифе уже есть.

## Условия CONDITION

Каждый элемент `conditions[]` — `{ "kind", "op", ...поля }`. Любая внутренняя ошибка условия = `false` (узел уходит в `no`).

| `kind` | `op` (допустимые) | Поля | Что проверяет |
|---|---|---|---|
| `TAG` | `HAS`, `NOT_HAS` | `value` — метка `[a-z0-9_-]{1,64}` | есть ли у пользователя тег |
| `VARIABLE` | `EQUALS`, `NOT_EQUALS`, `CONTAINS`, `NOT_EMPTY`, `EMPTY`, `GT`, `LT` | `key` — имя переменной `[a-z_][a-z0-9_]{0,63}`, `value` | значение переменной (`GT`/`LT` — числовое сравнение) |
| `UTM` | `EQUALS`, `CONTAINS`, `NOT_EMPTY`, `EMPTY` | `key` ∈ `source`/`medium`/`campaign`/`content`/`term`, `value` | UTM-метку клика (`utm_<key>`), регистронезависимо |
| `NAME` | `EQUALS`, `CONTAINS`, `NOT_EMPTY`, `EMPTY` | `value` | имя из профиля, регистронезависимо |
| `EMAIL` | `EQUALS`, `CONTAINS`, `NOT_EMPTY`, `EMPTY` | `value` | email из профиля |
| `PHONE` | `EQUALS`, `CONTAINS`, `NOT_EMPTY`, `EMPTY` | `value` | телефон из профиля |
| `USERNAME` | `EQUALS`, `CONTAINS` | `value` | @username пользователя Telegram |
| `SUBSCRIBED` | `SUBSCRIBED`, `NOT_SUBSCRIBED` | `key` — **числовой** id канала/группы (напр. `-1001234567890`); узнать числовой id подключённых каналов: `list_channels(botId)` | подписан ли пользователь на канал бота |
| `LINK_CLICKED` | `CLICKED`, `NOT_CLICKED` | `key` — **`id` узла-шага** с отслеживаемой URL-кнопкой (тот же UUID, что у `SEND_MESSAGE`) | кликал ли пользователь по ссылке этого шага |
| `CURRENT_DATE` | `BEFORE`, `AFTER`, `EQUALS` | `value` — дата `YYYY-MM-DD` | сегодняшнюю дату (МСК) |
| `CURRENT_TIME` | `BETWEEN` | `value`, `value2` — время `HH:mm` | текущее время в интервале (через полночь — если `value`>`value2`) |
| `DAY_OF_WEEK` | `IN` | `days` — массив из `MON`,`TUE`,`WED`,`THU`,`FRI`,`SAT`,`SUN` | день недели (МСК) |

Для `NOT_EMPTY`/`EMPTY` поле `value` не нужно. `UTM` без `key` всегда `false`.

**`SUBSCRIBED`** работает только если бот **админ** в канале/группе и канал «привязан» (бот узнаёт о членстве через хук `my_chat_member` — добавь бота в канал админом). `key` должен парситься в число, иначе условие = `false`. Профильные поля (`NAME`/`EMAIL`/`PHONE`) и UTM заполняются по ходу воронки (`ASK_QUESTION`→`saveTo`, диплинк-клик с UTM).

**`LINK_CLICKED`** проверяет факт клика по URL-кнопке конкретного шага. Чтобы условие работало: у нужного `SEND_MESSAGE` хотя бы одна кнопка `kind:"URL"` с `"track": true`, а в условии `key` = `id` этого узла-шага. Клик фиксируется через публичный редирект бота, поэтому условие имеет смысл ставить **после** `DELAY`/`ASK_QUESTION` (дай пользователю время кликнуть).

> **Платформа MAX.** Боты конструктора умеют работать и в мессенджере MAX. Там не поддерживаются `SUBSCRIBED`/`NOT_SUBSCRIBED` (нет членства в каналах) и reply-клавиатуры; публикация такого графа на MAX-бот вернёт **мягкие предупреждения** (не блокирует). Для Telegram-ботов всё работает как описано.

## Платформа Instagram

IG-боты подключаются через OAuth на странице **`/bots/instagram`** (раздел «Подключения» → карточка
Instagram; прежний раздел «Инструменты роста» / `/growth` расформирован и редиректит) — **без вставки токена вручную**; у IG нет персонального бот-токена. После OAuth бот получает доступ к Messaging API через привязанный Instagram Business/Creator-аккаунт.

### Разрешённые типы узлов для IG-ботов

Только следующие (всё остальное — ошибка `IG_NODE_UNSUPPORTED` при публикации):

| Тип | Доступен в IG |
|---|---|
| `TRIGGER_IG_COMMENT`, `TRIGGER_IG_DM`, `TRIGGER_IG_STORY_REPLY`, `TRIGGER_IG_STORY_MENTION` | ✅ (триггеры входа) |
| `SEND_MESSAGE`, `SEND_PHOTO` | ✅ |
| `BRANCH`, `CONDITION`, `SWITCH`, `STOP_AND_ERROR` | ✅ |
| `SET_VARIABLE`, `ADD_TAG`, `REMOVE_TAG`, `FORMULA` | ✅ |
| `ASK_QUESTION` | ✅ (с ограничениями — см. ниже) |
| `DELAY` | ✅ (не более 24ч — см. ниже) |
| `END` | ✅ |
| `TRIGGER_COMMAND`, `TRIGGER_CALLBACK`, `TRIGGER_TEXT` | ❌ |
| `BROADCAST_FILTER` (рассылки) | ❌ |
| `SCHEDULE`, `ACTIONS`, `CALL_WEBHOOK`, `AI_REPLY`, `PAYMENT_LINK`, `YOOKASSA_PAYMENT` | ❌ |
| `TRIGGER_PAYMENT` | ❌ |

### Ограничения IG-ботов

- **Нет команд** — вход только через `TRIGGER_IG_COMMENT` / `TRIGGER_IG_DM` / `TRIGGER_IG_STORY_REPLY` / `TRIGGER_IG_STORY_MENTION`. `/start` и другие команды не поддерживаются.
- **Нет рассылок** — `BROADCAST_FILTER` недоступен.
- **DELAY не более 24 часов** — Instagram доставляет сообщения только в течение 24-часового окна после последнего входящего действия (`IG_DELAY_OVER_24H`). `DELAY` с `kind=TOMORROW` или `kind=UNTIL` блокируются (они заведомо > 24ч). `kind=FIXED` с `durationSec > 86400` тоже блокируется.
- **`ASK_QUESTION`** — `inputKind`: `TEXT`, `EMAIL`, `PHONE`, `NUMBER`, `CONTACT` (`IG_INPUT_UNSUPPORTED` для остальных). `CONTACT` допустим: кнопки «Поделиться номером» в IG нет, поэтому бот отправляет текст-инструкцию и принимает номер, набранный вручную (как телефон). Нельзя запрашивать `LOCATION`, `PHOTO`, `DOCUMENT`.
- **Нет reply-клавиатур** — кнопки IG работают как inline (URL или Deep Link); стиль кнопок ограничен возможностями IG Messaging API.
- **Нет SUBSCRIBED** — условие «подписан на канал» недоступно.
- **Коммент → ЛС (Private Reply)** — на `SEND_MESSAGE`/`SEND_PHOTO` в графе с `TRIGGER_IG_COMMENT` укажи `"igReplyChannel": "dm"`, чтобы ответить автору комментария в Direct (а не публично под постом). По умолчанию (`"comment"`) — публичный ответ. Подробнее — `igReplyChannel` в разделе «Сообщения». **`"comment"` тоже требует, чтобы шаг был достижим от `TRIGGER_IG_COMMENT`** — иначе ошибка валидации `IG_COMMENT_REPLY_NO_COMMENT_TRIGGER` (в DM/story-флоу отвечать в комментарии некуда).

### Оффлайн-проверка IG-графа

```bash
node validate.mjs graph.json --platform=INSTAGRAM
```

Ловит `IG_NODE_UNSUPPORTED`, `IG_DELAY_OVER_24H`, `IG_INPUT_UNSUPPORTED` — в дополнение ко всем обычным структурным проверкам.

## Кросс-платформенное копирование (Telegram ⇄ MAX)

Инструмент `copy_graph` копирует граф в **другого бота** пользователя (`targetBotId`), в т.ч. на другую платформу. Формат графа один и тот же; различается лишь платформа бота-получателя. При копировании в MAX-бот несовместимые узлы **адаптируются**, отчёт — в `notes[]`:

| code | severity | что значит |
|---|---|---|
| `MAX_CONTACT_AS_TEXT` | TRANSFORM | вопрос с `inputKind=CONTACT` переписан в `inputKind=TEXT` + `validator=PHONE` (в MAX нет кнопки «поделиться контактом»; иначе узел стал бы тупиком) |
| `MAX_SUBSCRIBED_ALWAYS_NO` | MANUAL | условие `SUBSCRIBED` оставлено как есть, но в MAX всегда «не подписан» — проверьте ветвление вручную |
| `MAX_VOICE_AS_AUDIO` | INFO | голосовое уйдёт обычным аудио |
| `MAX_VIDEO_NOTE_AS_VIDEO` | INFO | кружок уйдёт обычным видео |
| `MAX_GALLERY_AS_ATTACHMENTS` | INFO | галерея уйдёт одним сообщением с вложениями |
| `MAX_DELETE_NOOP` | INFO | действие «удалить сообщение» в MAX игнорируется |

`preview: true` возвращает только `notes[]` (без копирования). Копирование в Telegram-бота (или в бота той же платформы) — точная копия, `notes[]` пустой. Новый граф создаётся как `DRAFT` с именем «… (copy)». Копировать в тот же бот нельзя (для дублирования — `clone_graph`).

## Выходные хэндлы (`sourceHandle`) — шпаргалка
| Узел | Хэндлы |
|---|---|
| обычный поток | `next` |
| кнопки сообщения (`buttons`) | `btn_0`, `btn_1`, … (по индексу кнопки, плоско по всем рядам) |
| `CONDITION` | `yes`, `no` |
| `BRANCH` | `case_<id>`, `default` |
| `ASK_QUESTION` | `valid`, `invalid` |
| `SEND_MESSAGE` с `awaitReply:true` | `valid`, `invalid` (+ `btn_N` для кнопок) |
| `CALL_WEBHOOK` | `ok`, `error` |
| `ACTIONS` | `next`, плюс `error` — если внутри есть действие, которое может упасть (внешний запрос, CRM, Таблицы) |
| `SWITCH` | `case_<id>`, `default` |
| `STOP_AND_ERROR` | выходов нет (терминатор) |
| `SCHEDULE` | `scheduled`, `past` |
| `DELAY` | `next` |

## Подстановки в тексте
`{{from.first_name}}`, `{{from.username}}`, `{{var.<имя>}}`, либо `{Имя}` как плейсхолдер. Имена переменных/меток: `[a-z_][a-z0-9_]{0,63}` (var) и `[a-z0-9_-]{1,64}` (tag).
