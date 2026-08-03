"""Нормализация загруженного фото профиля.

Что бы пользователь ни принёс (PNG с прозрачностью, повёрнутый снимок с
телефона, панорама), на выходе всегда одно и то же: квадрат 256x256 в JPEG.
Единый формат снимает с фронта заботу о пропорциях, а пересохранение
попутно отбрасывает EXIF — включая геометки и модель камеры.
"""

from __future__ import annotations

import io

from PIL import Image, ImageOps

# Сторона квадрата итогового изображения (px). Хватает и для аватарки 34px
# в топбаре, и для 72px на странице профиля на экране с retina.
AVATAR_SIZE_PX = 256

# Качество JPEG: на 256x256 разница с 95 незаметна, а вес втрое меньше.
AVATAR_JPEG_QUALITY = 85

# MIME сохранённого изображения — на выходе всегда JPEG.
AVATAR_MIME = "image/jpeg"

# Максимальный размер загружаемого файла (5 МБ).
AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024


class AvatarImageError(ValueError):
    """Загруженный файл не является изображением или повреждён."""


def process_avatar_image(raw: bytes) -> bytes:
    """Приводит загруженный файл к квадратному JPEG ``AVATAR_SIZE_PX``.

    Порядок: проверка, что это вообще изображение → поворот по EXIF-ориентации
    (иначе снимок с телефона ляжет набок) → склейка прозрачности на белый фон
    (JPEG альфа-канал не хранит) → центральный кроп до квадрата с масштабом.

    :param raw: байты загруженного файла.
    :returns: байты JPEG.
    :raises AvatarImageError: файл не удалось прочитать как изображение.
    """
    # verify() ловит битые и не-графические файлы до распаковки пикселей,
    # но оставляет файловый объект непригодным для чтения — дальше открываем
    # заново поверх тех же байтов.
    try:
        Image.open(io.BytesIO(raw)).verify()
    except Exception as exc:
        raise AvatarImageError("Файл не является изображением") from exc

    try:
        source = Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise AvatarImageError("Файл не является изображением") from exc

    try:
        image = ImageOps.exif_transpose(source)
        image = _flatten_to_rgb(image)
        image = ImageOps.fit(
            image,
            (AVATAR_SIZE_PX, AVATAR_SIZE_PX),
            method=Image.Resampling.LANCZOS,
        )
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=AVATAR_JPEG_QUALITY)
    except Exception as exc:
        raise AvatarImageError("Не удалось обработать изображение") from exc
    finally:
        source.close()

    return buffer.getvalue()


def _flatten_to_rgb(image: Image.Image) -> Image.Image:
    """Убирает альфа-канал, подкладывая под изображение белый фон.

    Без этого прозрачные области PNG уехали бы в JPEG чёрными.
    """
    if image.mode == "RGB":
        return image

    has_alpha = image.mode in ("RGBA", "LA") or (
        image.mode == "P" and "transparency" in image.info
    )
    if not has_alpha:
        return image.convert("RGB")

    rgba = image.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.split()[-1])
    return background
