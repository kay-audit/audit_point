/**
 * Загрузка файлов через Drag & Drop в контейнер блоков ОДНОГО поля.
 * Перетащенные картинки становятся image-блоками этого поля.
 */

import { ViolationManager } from './violation-core.js';
import { Notifications } from '../../shared/notifications.js';
import { AppConfig } from '../../shared/app-config.js';

// Расширение ViolationManager
Object.assign(ViolationManager.prototype, {
    /**
     * Настраивает обработчики Drag and Drop для файлов изображений
     * @param {HTMLElement} itemsContainer - Контейнер блоков поля
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} contentContainer - Контейнер содержимого поля
     */
    setupFileDragAndDrop(itemsContainer, violation, fieldKey, contentContainer) {
        // Режим просмотра: приём файлов не навешиваем (#1). Defense-in-depth —
        // в RO createBlocksField этот метод уже не вызывает.
        if (AppConfig.readOnlyMode?.isReadOnly) return;

        // Счетчик для отслеживания входов/выходов (для вложенных элементов)
        let dragCounter = 0;
        // Флаг активного файлового drag
        let isFileDragActive = false;

        // Обработчик входа файла в зону
        itemsContainer.addEventListener('dragenter', (e) => {
            // Проверяем, что это НЕ внутренний элемент
            const hasFiles = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files');
            const hasTextPlain = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('text/plain');

            // Если есть только text/plain и нет Files - это наш внутренний drag
            if (hasTextPlain && !hasFiles) {
                return;
            }

            // Не предотвращаем по умолчанию для внутренних элементов
            if (hasFiles) {
                e.preventDefault();
                e.stopPropagation();
                dragCounter++;
                isFileDragActive = true;
                itemsContainer.classList.add('drag-over-file');
            }
        });

        // Обработчик перемещения над зоной
        itemsContainer.addEventListener('dragover', (e) => {
            // Проверяем тип перетаскивания
            const hasFiles = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files');
            const hasTextPlain = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('text/plain');

            // Если это внутренний drag - не обрабатываем
            if (hasTextPlain && !hasFiles) {
                return;
            }

            // Проверяем, что это файлы
            if (hasFiles) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';

                // Вычисляем позицию для вставки файлов
                const position = this.calculateCursorPosition(e, itemsContainer);
                this.cursorInsertPosition = position;

                // Показываем индикатор позиции вставки — в т.ч. для пустого
                // контейнера (violation-6): mousemove во время drag не приходит.
                this.updateInsertIndicator(itemsContainer, position);
            }
        });

        // Обработчик выхода из зоны
        itemsContainer.addEventListener('dragleave', (e) => {
            // Проверяем тип перетаскивания
            const hasFiles = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files');
            const hasTextPlain = e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('text/plain');

            // Если это внутренний drag - не обрабатываем
            if (hasTextPlain && !hasFiles) {
                return;
            }

            if (hasFiles) {
                e.preventDefault();
                e.stopPropagation();
                dragCounter--;

                // Убираем подсветку только когда действительно покинули контейнер
                if (dragCounter === 0) {
                    itemsContainer.classList.remove('drag-over-file');
                    isFileDragActive = false;
                    this.cursorInsertPosition = null;
                    this.removeInsertIndicators(itemsContainer);
                }
            }
        });

        // Обработчик сброса файла
        itemsContainer.addEventListener('drop', (e) => {
            // Проверяем, есть ли файлы в событии
            const files = e.dataTransfer && e.dataTransfer.files;

            // Если нет файлов - это внутренний drop
            if (!files || files.length === 0) {
                return;
            }

            // Это файловый drop - обрабатываем
            e.preventDefault();
            e.stopPropagation();

            // Определяем позицию вставки
            const insertPosition = this.cursorInsertPosition !== null
                ? this.cursorInsertPosition
                : (violation?.[fieldKey]?.blocks?.length || 0);

            // Сбрасываем состояние
            dragCounter = 0;
            isFileDragActive = false;
            itemsContainer.classList.remove('drag-over-file');
            this.cursorInsertPosition = null;
            this.removeInsertIndicators(itemsContainer);

            // Обрабатываем каждый файл
            const imageFiles = [];

            // Сначала фильтруем только изображения
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                // Проверяем, что это изображение
                if (file.type.startsWith('image/')) {
                    imageFiles.push(file);
                }
            }

            if (imageFiles.length === 0) {
                Notifications.error('Не найдено изображений для добавления');
                return;
            }

            // Тип-валидация ДО чтения (H6/#26): MIME/число элементов/абсурдный
            // потолок; отказники отсеяны с Notifications.warning. Размер (#2) —
            // после ресайза в конвейере.
            const acceptedFiles = this.filterAcceptedImageFiles(imageFiles, violation, fieldKey);
            if (acceptedFiles.length === 0) return;

            // Диалог качества (Q3) → ресайз → вставка в порядке перетащенных (violation-4).
            this.promptQualityThenInsertImages(
                violation, fieldKey, contentContainer, insertPosition, acceptedFiles);
        });

        // Дополнительная защита: сбрасываем состояние при любом завершении drag
        const resetDragState = () => {
            if (isFileDragActive) {
                dragCounter = 0;
                isFileDragActive = false;
                itemsContainer.classList.remove('drag-over-file');
                this.cursorInsertPosition = null;
                this.removeInsertIndicators(itemsContainer);
            }
        };

        itemsContainer.addEventListener('dragend', resetDragState);

        // Сброс при промахе мимо зоны (drop где-то ещё на странице) —
        // общий на весь менеджер document-слушатель, а не свой на каждое
        // поле (#16). Ключ — нарушение+поле: у карточки десять независимых
        // зон приёма, повторная установка поля перезаписывает свою запись.
        // Снятие зон — removeViolation (удаление узла) и destroy() (switch акта).
        this._registerFileDropZone(`${violation.id}:${fieldKey}`, itemsContainer, resetDragState);
    }
});
