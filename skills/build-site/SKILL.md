---
name: build-site
description: Собрать сайт или лендинг из блоков в сервисе retensy (раздел «Страницы») — обложка, тексты, преимущества, галерея, форма заявки, попап, несколько страниц — и опубликовать. Использовать, когда пользователь просит «сделать сайт», «лендинг», «страницу с формой заявки», «сайт для бизнеса».
---

# Сайт из блоков (retensy «Страницы»)

Сайт — JSON-модель: тема, общие шапка и подвал, страницы с блоками, попапы. Правится операциями `site_edit`
(всё или ничего, с проверкой схемы на сервере), публикуется `site_publish`. Тот же сайт пользователь потом правит
мышкой в кабинете — модель общая.

## Порядок

1. `site_schema` — какие блоки и поля бывают (`model`) и какие операции есть (`ops`); `site_templates` — готовые
   секции из библиотеки.
2. `site_create {title}` → `id`. Для правки существующего — `site_list`, `site_get {siteId}`.
3. Первый `site_edit` с `init`: `starter` — готовый лендинг (шапка, обложка, текст, преимущества, форма, подвал),
   `blank` — пустая главная или `mini-landing` — мини-лендинг «как Taplink» (см. ниже). Только `init` без `ops` —
   создать черновик из шаблона; то же сразу при создании — `site_create {title, template}`. На сайте с черновиком
   `init` игнорируется. Заполни тексты, не выдумывай факты о бизнесе — спрашивай.
4. Картинки — `site_upload_asset {siteId, path|url}` → `assets/…` в поля `image`, `logo`, `icon`, `style.bg.image`.
5. `site_get` — проверь модель, `site_publish` — сайт открыт по `url`.
6. После публикации: заявки — `site_leads`, куда их слать — `site_lead_settings` (бот уведомлений, почта, вебхук,
   вебхук-сценарий бота, amoCRM, «Интеграция» — `coreDelivery {connectionId, kind, params?}`: любое подключение из
   `coreConnections`, действие — `kind` из `integration_catalog`; запуск автоматизаций по заявке — сценарий с триггером
   `TRIGGER_SITE_FORM {siteId, formId}`, скилл build-bot-funnel); свой домен — `site_domains` (`add` → пользователь ставит A-запись на `dnsTarget`
   → `check`); неудачная публикация — `site_rollback {revision}` из `site_get → versions[]`.

## Правила модели

- Значения по экранам — `{d, t?, m?}` (десктоп ≥1024, планшет 640–1023, телефон <640); без `t`/`m` берётся больший.
- `props`, `style`, `theme` в операциях — JSON Merge Patch: объекты сливаются, `null` удаляет ключ, массивы
  (кнопки, ссылки, поля формы, фото) передаются целиком.
- Ссылки (`action`): `{kind:"url", href}` (https/tel/mailto/tg/#якорь), `{kind:"page", pageId}`,
  `{kind:"anchor", blockId}`, `{kind:"popup", popupId}`.
- Текст с разметкой (Rich): только `<b> <i> <u> <s> <br> <a href> <span style="color:#…">`.
- Цвета — `#rrggbb`. Шрифты: inter, montserrat, roboto, pt-sans, pt-serif, rubik, oswald.
- `revision` из ответа передавай в следующий `site_edit` — сервер не даст перезаписать правки из кабинета (409).

## Zero-блок — свободная вёрстка (как Zero Block в Tilda)

Блок `type: "zero"` — артборд, на котором элементы стоят по координатам. Для дизайнерских экранов, где готовых
блоков мало.

- Добавить: `add_block {container, type: "zero", props: {height: {d: 600, m: 720}}}` → id блока в `results`.
- Элементы: `add_element {blockId, kind, frame, props, style?, link?, anim?}`, `kind`: `text`, `image`, `button`,
  `shape`, `video`, `html`, `group`. `frame` — по экранам: `{d: {x, y, w, h}, m?: {…}}`; `h: "auto"` у текста — высота
  по содержимому. Нет `t`/`m` — кадр выводится из большего экрана в масштабе; задай `m`, если на телефоне нужна
  другая раскладка. `container: "window"` + `axisX/axisY` — привязка к краям окна, а не к сетке.
- Правка — `update_element` (Merge Patch), порядок слоёв — `move_element {delta}`, группы — `group_elements` /
  `ungroup_element`; у элемента в группе кадр — относительно группы (`parent`).
- Целиком переписать блок проще кодом: `get_block_code {blockId}` → в `results[i].code` разметка `<zero …>…</zero>`,
  поправь и верни `set_block_code {blockId, code}`; новый блок из кода — `add_block_code {container, code}`. У
  обычных блоков код — JSON `{type, variant, props, style}`. Тот же код пользователь видит во вкладке «Код» редактора.

## Мини-лендинг и блок «Кнопки мессенджеров»

`init: "mini-landing"` (или `site_create {template: "mini-landing"}`) — одна страница без шапки и подвала, колонка
640px, на весь экран блок `type: "messengers"`. Его `props`:

- `avatar?` (`assets/…`), `title?`, `text?`;
- `bots: [{botId, label?, start?}]` — боты владельца по порядку, кнопки собираются при публикации; пусто — все
  активные боты (Telegram, MAX, Instagram). `start` — метка старта (латиница, цифры, `_`, `-`);
- `links: [{label, action, style: primary|secondary|link}]` — свои кнопки (до 10): `action` —
  `{kind:"url", href}` (только http(s), mailto:, tel:, относительные и `#якорь`; `javascript:`/`data:`/`vbscript:` бэкенд отклоняет),
  `{kind:"phone", phone}`, `{kind:"email", email}`, `{kind:"page"|"anchor"|"popup"|"bot", …}`;
- `colors: "brand"` (цвета мессенджеров) | `"theme"` (основной цвет темы).

Блок ставится и на обычный сайт: `add_block {container, type: "messengers"}`.

## Папки, дизайны, шаблоны

- Папки страниц (для навигации в кабинете): `add_folder {name}` → id в `results`; `rename_folder {folderId, name}`,
  `remove_folder {folderId}`. Страницу в папку — `update_page {pageId, patch: {folder: folderId}}`.
- Дизайны — отдельные экраны-макеты из Zero-кадров (не страницы сайта): `add_design {name}` → id;
  `update_design {designId, name}`, `remove_design {designId}`. Кадр: `add_design_frame {designId, name, w, h}` →
  в `results` `blockId` Zero-кадра — дальше на нём работают `add_element`/`update_element`/`get_block_code` и др.
- Шаблоны: `site_templates` → `{categories, templates: [{id, category, title, description?, blocks}]}` (`blocks` —
  сколько блоков вставится). Вставка — `add_template {container, templateId, after?}`: блоки шаблона
  встают в страницу/попап, дальше правь их тексты обычными `update_block`. Быстрее, чем собирать блоки с нуля.

## Тариф

- HTML-блок и HTML-элемент Zero публикуются только на платном тарифе: на бесплатном `site_publish` вернёт 422 с
  путями этих элементов — замени их обычными блоками или предложи тариф.
- Число своих доменов ограничено тарифом (`site_domains add` → 402 со ссылкой на смену тарифа — передай её
  пользователю, оплата только в браузере); www-пара корневого домена не в счёт.
- На бесплатном тарифе адрес на pages.retensy.com закрыт от поисковиков (noindex).

## Пример: лендинг кофейни с попапом заявки

```json
[
  {"op": "set_theme", "theme": {"colors": {"primary": "#b5651d"}, "fonts": {"heading": "pt-serif", "body": "inter"}}},
  {"op": "add_popup", "name": "Бронь столика"},
  {"op": "add_block", "container": "<id главной>", "type": "cover", "after": -1,
   "props": {"title": "Кофе, ради которого приходят", "subtitle": "Обжариваем сами, с 8:00 до 22:00",
             "buttons": [{"label": "Забронировать столик", "style": "primary", "action": {"kind": "popup", "popupId": "<id из results>"}}],
             "height": {"d": "screen", "m": "auto"}},
   "style": {"bg": {"image": "assets/cafe-x1y2.jpg", "overlay": 0.5}, "textColor": "#ffffff"}}
]
```

Порядок важен: id созданного попапа приходит в `results` — если он нужен в той же правке, сделай два вызова
`site_edit` (сначала `add_popup`, потом блок с кнопкой).
