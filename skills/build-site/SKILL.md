---
name: build-site
description: Собрать сайт или лендинг из блоков в сервисе retensy (раздел «Страницы») — обложка, тексты, преимущества, галерея, форма заявки, попап, несколько страниц — и опубликовать. Использовать, когда пользователь просит «сделать сайт», «лендинг», «страницу с формой заявки», «сайт для бизнеса».
---

# Сайт из блоков (retensy «Страницы»)

Сайт — JSON-модель: тема, общие шапка и подвал, страницы с блоками, попапы. Правится операциями `site_edit`
(всё или ничего, с проверкой схемы на сервере), публикуется `site_publish`. Тот же сайт пользователь потом правит
мышкой в кабинете — модель общая.

## Порядок

1. `site_schema` — какие блоки и поля бывают (`model`) и какие операции есть (`ops`).
2. `site_create {title}` → `id`. Для правки существующего — `site_list`, `site_get {siteId}`.
3. Первый `site_edit` с `init`: `starter` — готовый лендинг (шапка, обложка, текст, преимущества, форма, подвал) или
   `blank` — пустая главная. Заполни тексты, не выдумывай факты о бизнесе — спрашивай.
4. Картинки — `site_upload_asset {siteId, path|url}` → `assets/…` в поля `image`, `logo`, `icon`, `style.bg.image`.
5. `site_get` — проверь модель, `site_publish` — сайт открыт по `url`.
6. После публикации: заявки — `site_leads`, куда их слать — `site_lead_settings` (бот уведомлений, почта, вебхук,
   вебхук-сценарий бота, amoCRM); свой домен — `site_domains` (`add` → пользователь ставит A-запись на `dnsTarget`
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

## Тариф

- HTML-блок и HTML-элемент Zero публикуются только на платном тарифе: на бесплатном `site_publish` вернёт 422 с
  путями этих элементов — замени их обычными блоками или предложи тариф.
- Число своих доменов ограничено тарифом (`site_domains add` → 402 с `upgradeUrl`); www-пара корневого домена не в счёт.
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
