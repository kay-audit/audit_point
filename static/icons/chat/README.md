# Иконки чата

Одна иконка = один `.svg` файл.

## Конвенция имени

```
<что-изображает>-<размер>.svg
```

Примеры:
- `file-generic-24.svg` — общий документ (doc, log, json, xml, yaml, yml)
- `file-spreadsheet-24.svg` — таблица (xls, csv)
- `file-archive-24.svg` — архив (zip, rar, 7z, gz, tar)
- `file-image-24.svg` — изображение (png, jpg, jpeg, gif, bmp, webp, svg)
- `file-code-24.svg` — исходный код (sql, ipynb, py, js, ts)
- `file-presentation-24.svg` — презентация (ppt)
- `file-docx-24.svg` — документ Word (docx)
- `file-xlsx-24.svg` — таблица Excel (xlsx)
- `file-pptx-24.svg` — презентация PowerPoint (pptx)
- `file-md-24.svg` — Markdown-документ (md)
- `file-txt-24.svg` — текстовый файл (txt)
- `file-pdf-24.svg` — PDF-документ (pdf)

`<размер>` — это viewBox и width/height (по умолчанию 24).

## Два вида иконок

В наборе сейчас два вида иконок по принципу выбора формата:

1. **С текстовым ярлыком внутри** — для конкретных офисных и текстовых
   форматов: `docx`, `xlsx`, `pptx`, `md`, `txt`, `pdf`. Этот формат
   виден даже в мелком масштабе иконки (24×24 px), что важно для чата.
   У четырёхбуквенных ярлыков ширина зафиксирована через
   `textLength="11" lengthAdjust="spacingAndGlyphs"`: без этого подпись
   упирается в обводку корпуса (внутренняя ширина — 12.5 единиц) и
   разъезжается там, где вместо Arial подставится другой шрифт.

2. **Общие по форме** — для групп форматов с близкой природой:
   `generic` (документы и данные), `spreadsheet` (таблицы), `presentation`
   (презентации), `image`, `code`, `archive`. Подходят, когда отдельная
   иконка под формат не нужна и форма уже передаёт тип.

Карта расширение → иконка живёт в
`static/js/shared/chat/chat-renderer.js` → `_ICON_FORM`.

## Цвет

Иконки используют `stroke="currentColor"`, поэтому цвет берётся из CSS
класса модификатора (например `.chat-block-file-icon--pdf` ставит
`color: #dc2626` и весь stroke рендерится красным). У иконок с
текстовым ярлыком подпись внутри тоже наследует `currentColor`.

## Как добавить новую иконку

1. Положить `<имя>-<размер>.svg` в эту папку
2. В `static/js/shared/chat/chat-renderer.js` → `_ICON_URLS` добавить
   пару `'<ключ>': '<имя>.svg'`, и в `_ICON_FORM` — расширение → ключ.
3. Если расширение новое и его нет в `chat-blocks.css` →
   `.chat-block-file-icon--<ext>` с нужным цветом.
4. Hard refresh страницы (Ctrl+Shift+R)

## Как перерисовать

Просто открой нужный `.svg` в редакторе, поменяй `<path d="...">`, сохрани.
Браузер подхватит новую версию после hard refresh.
