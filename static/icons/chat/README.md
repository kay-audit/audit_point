# Иконки чата

Одна иконка = один `.svg` файл.

## Конвенция имени

```
<что-изображает>-<размер>.svg
```

Примеры:
- `file-generic-24.svg` — общий документ
- `file-spreadsheet-24.svg` — таблица (xlsx, xls)
- `file-archive-24.svg` — архив (zip, rar, 7z, gz, tar)
- `file-image-24.svg` — изображение
- `file-code-24.svg` — исходный код
- `file-presentation-24.svg` — презентация

`<размер>` — это viewBox и width/height (по умолчанию 24).

## Цвет

Иконки используют `stroke="currentColor"`, поэтому цвет берётся из CSS
класса модификатора (например `.chat-block-file-icon--pdf` ставит
`color: #dc2626` и весь stroke рендерится красным).

## Как добавить новую иконку

1. Положить `<имя>-<размер>.svg` в эту папку
2. В `static/js/shared/chat/chat-renderer.js` → `_getFileIconSvg()`
   добавить запись в `ICON_URLS` и `ICON_FORM`
3. Hard refresh страницы (Ctrl+Shift+R)

## Как перерисовать

Просто открой нужный `.svg` в редакторе, поменяй `<path d="...">`, сохрани.
Браузер подхватит новую версию после hard refresh.
