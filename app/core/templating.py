"""Singleton Jinja2Templates для всех роутов приложения.

Здесь же живут обе половины cache-busting статики: фильтр ``versioned``
собирает версионированный URL для шаблонов, ``VersionedStaticFiles`` отдаёт
по нему файл. Разносить их по модулям смысла нет — это один механизм.
"""

from functools import lru_cache

from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.core.config import get_settings


def _versioned(url: str, version: str) -> str:
    """Вставляет версию в ПУТЬ статики для cache-busting.

    ``/static/js/entries/constructor.js`` → ``/static/v16.0.0/js/entries/constructor.js``.

    Версия именно в пути, а не в ``?v=``, потому что фильтр применяется только
    к ~30 URL, написанным в шаблонах, а за точкой входа тянется граф из сотен
    ES-модулей с относительными ``import``'ами. Относительный импорт резолвится
    от URL импортирующего модуля, поэтому версия в пути наследуется всем графом
    (и ``@import`` внутри CSS) автоматически. Query-параметр таким свойством не
    обладает: он остаётся только на самом URL из шаблона, а зависимости
    приезжают из кеша — старые.

    Принимает как относительный путь, так и абсолютный URL (``url_for`` в
    Starlette отдаёт URL со схемой и хостом). Существующий query-параметр
    сохраняется. URL без сегмента ``/static/`` возвращается без изменений.
    """
    text = str(url)
    # Query и fragment отрезаем, чтобы искать сегмент только в пути.
    cut = len(text)
    for ch in ("?", "#"):
        pos = text.find(ch)
        if pos != -1:
            cut = min(cut, pos)
    path, suffix = text[:cut], text[cut:]

    marker = "/static/"
    idx = path.find(marker)
    if idx == -1:
        return text
    # Идемпотентность: повторное применение фильтра ничего не меняет.
    if path.startswith(f"{marker}v{version}/", idx):
        return text

    head = path[: idx + len(marker)]
    rest = path[idx + len(marker):]
    return f"{head}v{version}/{rest}{suffix}"


def _strip_static_version(path: str, root_path: str = "") -> tuple[str, bool]:
    """Срезает сегмент версии, идущий сразу за префиксом mount'а статики.

    ``("/static/v16.0.0/js/app.js", "/static")`` → ``("/static/js/app.js", True)``.

    Сегментом версии считается ``v`` + цифра: так реальные каталоги статики
    (``vendor/``) под шаблон не попадают. Возвращает пару
    ``(путь без версии, была ли версия)``.

    ``root_path`` внутри mount'а равен его префиксу (``/static``), а сам
    ``scope["path"]`` остаётся полным — поэтому версию ищем строго после
    префикса, а не в начале строки.
    """
    prefix = root_path if root_path and path.startswith(root_path) else ""
    head, sep, tail = path[len(prefix):].lstrip("/").partition("/")
    if sep and len(head) > 1 and head[0] == "v" and head[1].isdigit():
        return f"{prefix}/{tail}", True
    return path, False


class VersionedStaticFiles(StaticFiles):
    """StaticFiles, отдающий файлы и по ``/static/v<версия>/<путь>``.

    Версия в пути — чистый cache-buster: сервер её НЕ валидирует и НЕ
    сравнивает с текущей, просто отбрасывает сегмент и отдаёт файл с диска.
    Это осознанно — старая вкладка, у которой в пути прошлая версия,
    продолжает работать, а не получает 404.

    Почему подкласс, а не другие варианты:
      • отдельный mount с ASGI-обёрткой, срезающей сегмент, — лишний слой и
        дублирование конфигурации StaticFiles в двух местах;
      • маршрут-редирект — лишний round-trip на каждый из ~230 файлов графа
        модулей, то есть удвоение числа запросов на холодной загрузке.

    Path traversal безопасен: сегмент срезается ДО ``StaticFiles.get_path``,
    поэтому нормализация пути и проверка ``commonpath`` в ``lookup_path``
    остаются на месте — ``/static/v1/../../etc/passwd`` по-прежнему 404.

    ``immutable`` — политика кеша на версионированном пути (см.
    ``SECURITY__STATIC_IMMUTABLE``). Класс по умолчанию отдаёт вечный кеш,
    потому что в этом смысл версии в адресе; конкретное окружение решает за
    себя — mount в ``app/main.py`` передаёт значение из настроек явно.
    """

    def __init__(self, *args, immutable: bool = True, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._immutable = immutable

    def get_path(self, scope) -> str:
        stripped, _ = _strip_static_version(scope["path"], scope.get("root_path", ""))
        return super().get_path({**scope, "path": stripped})

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        _, is_versioned = _strip_static_version(
            scope["path"], scope.get("root_path", ""),
        )
        if is_versioned:
            # Адрес меняется с каждым релизом, поэтому вечный кеш безопасен и
            # снимает revalidation-запросы. Когда флаг выключен (DEV), кешировать
            # ответ по-прежнему разрешаем, но с нулевым временем свежести: браузер
            # обязан сходить на сервер и получит 304 по ETag, который StaticFiles
            # ставит сам. Явное `must-revalidate` нужно, чтобы кеш не отдавал
            # протухшее в оффлайне. Неверсионированный /static/... в обоих
            # случаях остаётся на дефолтных ETag/Last-Modified.
            response.headers["Cache-Control"] = (
                "public, max-age=31536000, immutable"
                if self._immutable
                else "public, max-age=0, must-revalidate"
            )
        return response


@lru_cache(maxsize=1)
def get_templates() -> Jinja2Templates:
    """Возвращает единственный экземпляр Jinja2Templates.

    Регистрирует глобал ``app_version`` и фильтр ``versioned`` для
    cache-busting статических ресурсов в шаблонах.
    """
    templates = Jinja2Templates(directory=str(get_settings().templates_dir))
    version = get_settings().app_version
    templates.env.globals["app_version"] = version
    # Для условных элементов шаблонов (кнопка «Выйти» видна только в ОТП-режиме).
    templates.env.globals["auth_enabled"] = get_settings().auth.enabled
    templates.env.filters["versioned"] = lambda u: _versioned(str(u), version)
    return templates
