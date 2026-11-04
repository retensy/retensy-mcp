---
name: send-broadcast
description: Сделать рассылку подписчикам ботов retensy (Telegram/MAX) — сейчас, по расписанию или повторяющуюся, по нескольким ботам и с фильтром по тегам; черновики, отмена, статистика отправки. Использовать, когда пользователь просит «разослать», «сделать рассылку», «напомнить всем подписчикам», «отправить акцию в бота».
---

# Рассылки retensy

## Порядок

1. `list_bots` → id ботов. У Instagram-ботов рассылок нет (Meta разрешает писать только в окне 24 ч) — предложи
   сценарий с триггером.
2. Собери сообщения (до 5) и уточни у пользователя: кому (теги), когда, по каким ботам. Тексты не выдумывай.
3. Медиа — `upload_file {path|url}` → `url` в `mediaUrl`/`mediaUrls`.
4. `broadcast_preview {botIds, tagsAll?, tagsNone? | audienceFilter? | segmentId?}` — оцени охват, назови пользователю число получателей и **дождись
   подтверждения**: рассылку не вернуть, а получатели списываются с месячной квоты тарифа.
5. `broadcast_send {name, botIds, messages, tagsAll?, tagsNone?, scheduledAt?}` → `{broadcastIds, totalAudience}`.
   Не уверен в тексте — сначала `broadcast_drafts {action: "create", …}`: пользователь увидит черновик в кабинете,
   отправка — `broadcast_send {draftId}` (черновик после отправки удаляется).
   Повторно используемую аудиторию сохрани `audience_segments {action:"create", botId, name, audienceFilter}` и дальше передавай `segmentId`. Перед отправкой можно прислать тест себе: `broadcast_test {botId, messages}` (на привязанный Telegram владельца, без квоты).
   «В 10:00 по времени каждого» - `localTime:"10:00"` (пояс из переменной `timezone` подписчика, иначе пояс бота; не с `dedup`/`stagger`). Ночью не беспокоить - `bot_delivery_window {action:"set", botId, enabled:true, quietFrom:"22:00", quietTo:"09:00"}`: рассылки в окне переносятся на его конец.
6. Статус — `broadcast_get {broadcastId}` (с причинами ошибок) / `broadcast_list`; остановить — `broadcast_cancel`.
   Повторить или взять за основу — `broadcast_duplicate {broadcastId | draftId}` → черновик «… (копия)».

## Сообщение

`{type, text?, mediaUrl?, mediaUrls?, buttons?}`; строка — короткая запись `TEXT`.

| type | Обязательно | Текст | Кнопки |
|---|---|---|---|
| `TEXT` | `text` до 4096 | да | до 8 |
| `PHOTO` `VIDEO` `AUDIO` `FILE` `VOICE` | `mediaUrl` | подпись до 1024 | до 8 |
| `VIDEONOTE` (кружок) | `mediaUrl` | нет | до 8 |
| `GALLERY` | `mediaUrls`: 2–10 картинок | подпись до 1024 | нет |

- Текст — Telegram-HTML: `<b> <i> <u> <s> <code> <pre> <blockquote> <tg-spoiler> <a href="https://…">`.
  Перенос строки — `\n`, `<br>` не работает.
- Кнопки — только ссылки `[{text, url}]`. Нужна ветка по нажатию — это рассылка по сценарию: `broadcast_send
  {botId, graphId, entryNodeId?, name}` запускает сценарий бота для каждого получателя.

## Аудитория и время

- Подписчики бота; `tagsAll` — есть все эти теги, `tagsNone` — нет ни одного. До 50 000 на бота, до 20 ботов одного
  владельца за раз (по каждому боту создаётся своя рассылка).
- `scheduledAt` — ISO 8601; без пояса — московское время. Отложенная считает аудиторию в момент отправки.
- Повтор: `broadcast_recurring {action: "create", name, botIds, messages, recurrence: DAILY|MONTHLY|YEARLY,
  firstRunAt}`; список — `action: "list"`, остановить — `action: "stop", ruleId`.

## Тариф

Рассылки — на платном тарифе. HTTP 402 приходит со ссылкой (`upgradeUrl` или `/bots/subscription`): передай её
пользователю — оплата и смена тарифа только в браузере, потом повтори отправку.
