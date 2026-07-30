/**
 * Валидация структуры дерева документа
 *
 * Проверяет глубину вложенности, возможность добавления узлов,
 * лимиты контента и отношения родитель-потомок.
 * НЕ содержит бизнес-логики акта.
 */
import { AppState } from '../state/state-core.js';
import { TreeUtils } from '../tree/tree-utils.js';
import { ValidationCore } from './validation-core.js';
import { AppConfig } from '../../shared/app-config.js';
import { getBlockType } from '../block-types.js';
import { getImageLimits, getStructureLimits } from '../violation/violation-image-validator.js';

// #8: тип узла → рантайм-ключ структурных лимитов (/acts/limits). Общий для
// _validateContentLimits (гейт кнопки «Добавить …») и canInsertSubtree (гейт
// вставки готового поддерева) — раньше _validateContentLimits знал только про
// textBlocks, из-за чего кнопка добавления нарушений/таблиц не учитывала
// сниженный админом рантайм-лимит и упиралась в захардкоженные 10.
const RUNTIME_LIMIT_KEY_BY_TYPE = {
    [AppConfig.nodeTypes.TEXTBLOCK]: 'textBlocksPerNode',
    [AppConfig.nodeTypes.VIOLATION]: 'violationsPerNode',
    [AppConfig.nodeTypes.TABLE]: 'tablesPerNode',
};

export const ValidationTree = {
    /**
     * Проверяет возможность добавления дочернего узла
     * @param {string} parentId - ID родительского узла
     * @returns {Object} Результат с полями valid, message, isWarning
     */
    canAddChild(parentId) {
        const depth = TreeUtils.getNodeDepth(parentId);

        // Неизвестный родитель: getNodeDepth даёт -1, что без guard'а
        // проходило проверку maxDepth и давало ложный success
        if (depth === -1) {
            return ValidationCore.failure(AppConfig.tree.validation.parentNotFound);
        }

        const maxDepth = AppConfig.tree.maxDepth;

        if (depth >= maxDepth) {
            return ValidationCore.failure(
                AppConfig.tree.validation.maxDepthExceeded(maxDepth)
            );
        }

        return ValidationCore.success();
    },

    /**
     * Проверяет возможность добавления соседнего узла.
     * На 0 уровне (родитель — root) штатно добавляется только пункт Process
     * Mining (через AppState.addProcessMiningSection из меню). Прямое добавление
     * обычного соседа на верхний уровень запрещено и здесь, на уровне состояния.
     * @param {string} nodeId
     * @returns {Object}
     */
    canAddSibling(nodeId) {
        const parent = AppState.findParentNode(nodeId);
        if (parent?.id === 'root') {
            return ValidationCore.failure(AppConfig.tree.validation.cannotAddFirstLevelSibling);
        }
        return ValidationCore.success();
    },

    /**
     * Проверяет возможность добавления контента к узлу дерева
     * @param {Object} node - Проверяемый узел
     * @param {string} contentType - Тип контента из AppConfig.nodeTypes
     * @returns {Object} Результат валидации
     */
    canAddContent(node, contentType) {
        // Проверка существования узла
        const existsCheck = ValidationCore.validateNodeExists(node);
        if (!existsCheck.valid) return existsCheck;

        // Проверка глубины (как в canAddChild). Контент-узлы (таблица/текстблок/
        // нарушение) не создают нового уровня иерархии, поэтому порог — глубина
        // самого узла > maxDepth (без +1). Узел вне дерева (depth -1) — отказ.
        const depth = TreeUtils.getNodeDepth(node.id);
        const maxDepth = AppConfig.tree.maxDepth;
        if (depth === -1) {
            return ValidationCore.failure(AppConfig.tree.validation.nodeNotFound);
        }
        if (depth > maxDepth) {
            return ValidationCore.failure(
                AppConfig.tree.validation.maxDepthExceeded(maxDepth)
            );
        }

        // Проверка типа узла
        const typeCheck = this._validateNodeType(node, contentType);
        if (!typeCheck.valid) return typeCheck;

        // Проверка лимитов
        const limitCheck = this._validateContentLimits(node, contentType);
        if (!limitCheck.valid) return limitCheck;

        return ValidationCore.success();
    },

    /**
     * Проверяет совместимость типа узла с добавляемым контентом
     * @private
     * @param {Object} node - Проверяемый узел
     * @param {string} contentType - Тип контента из AppConfig.nodeTypes
     * @returns {Object} Результат проверки
     */
    _validateNodeType(node, contentType) {
        const {TABLE, TEXTBLOCK, VIOLATION} = AppConfig.nodeTypes;
        const errors = AppConfig.content.errors;
        const typeName = AppConfig.content.typeNames[contentType];

        // Нельзя добавлять контент к информационным элементам
        if (node.type === TABLE) {
            return ValidationCore.failure(
                errors.cannotAddToTable(typeName)
            );
        }

        if (node.type === TEXTBLOCK) {
            return ValidationCore.failure(
                errors.cannotAddToTextBlock(typeName)
            );
        }

        if (node.type === VIOLATION) {
            return ValidationCore.failure(
                errors.cannotAddToViolation(typeName)
            );
        }

        return ValidationCore.success();
    },

    /**
     * Проверяет лимиты количества элементов контента в узле
     * @private
     * @param {Object} node - Проверяемый узел
     * @param {string} contentType - Тип контента из AppConfig.nodeTypes
     * @returns {Object} Результат проверки
     */
    _validateContentLimits(node, contentType) {
        if (!node.children) {
            return ValidationCore.success();
        }

        // Лимит per-type — из реестра типов блоков (block-types.js).
        const spec = getBlockType(contentType);
        const existingCount = TreeUtils.countChildrenByType(node, contentType);
        let limit = spec ? spec.limitPerNode : undefined;
        // #8: лимит — из рантайм-настроек (/acts/limits, синхронно с серверной
        // валидацией) для всех лимитируемых типов (текстблоки/нарушения/таблицы),
        // фолбэк — захардкоженный реестр block-types.
        const runtimeKey = RUNTIME_LIMIT_KEY_BY_TYPE[contentType];
        const runtime = runtimeKey ? getStructureLimits()[runtimeKey] : undefined;
        if (typeof runtime === 'number') limit = runtime;
        const limitName = AppConfig.content.limitNames[contentType];

        return ValidationCore.validateLimit(existingCount, limit, limitName);
    },

    /**
     * Проверяет лимиты блоков-на-узел при вставке ГОТОВОГО поддерева
     * (PERSIST-2/#7: undo восстановления удалённого блока, paste, drag-and-drop
     * перемещение). insertNodeAt/_performMove — мутаторы для таких вставок —
     * в отличие от addTextBlockToNode/addViolationToNode не зовут canAddContent,
     * поэтому без этой проверки узел мог получить N+1 блоков лимитируемого типа,
     * и сервер отклонял бы уже сохранение всего акта.
     *
     * Обобщено на все лимитируемые типы (текстблоки/нарушения/таблицы). Для
     * каждого типа берётся его effective-лимит: рантайм из /acts/limits
     * (getStructureLimits().{textBlocksPerNode|violationsPerNode|tablesPerNode}),
     * фолбэк — захардкоженный limitPerNode реестра block-types. Тип с лимитом
     * не-числом пропускается (поведение «лимит не задан → success»). Таблицы
     * считаются ВСЕ, включая закреплённые metrics/risk (паритет с add-путём).
     *
     * Для каждого типа проверяются две вещи:
     *  - целевой родитель: если сам корень поддерева node — этого типа, его +1
     *    не должен превысить лимит родителя (тот же лимит, что у «Добавить …»).
     *    Сам node ИСКЛЮЧАЕТСЯ из подсчёта родителя по id: для paste/undo node
     *    ещё не среди children родителя (id не совпадёт — no-op), а для drag
     *    reorder ВНУТРИ одного родителя node уже физически в его children (drag
     *    ещё не вырезал узел оттуда) — без исключения он засчитался бы дважды и
     *    лимит отказывал бы обычному reorder;
     *  - самосогласованность поддерева: число детей типа на каждом его узле не
     *    должно превышать ТЕКУЩИЙ лимит — поддерево скопировано/удалено раньше и
     *    могло стать невалидным, если лимит с тех пор снизился (буфер обмена в
     *    localStorage переживает перезагрузку страницы).
     *
     * Третий (опциональный) параметр — словарь нарушений вставляемого фрагмента
     * (§5.10b). Элементы дополнительного контента лежат не в узлах дерева, а в
     * записях словаря violations, которые едут рядом с поддеревом при paste/undo,
     * поэтому проверить их можно только имея этот словарь. Без параметра —
     * прежнее поведение (drag/move элементов не добавляет, словарь не нужен).
     *
     * @param {string} parentId - ID узла, в children которого встанет node
     * @param {Object} node - Вставляемый/перемещаемый узел (возможно, с поддеревом)
     * @param {Object} [violationsDict] - Словарь нарушений фрагмента
     *        (id записи → нарушение) для проверки лимита доп. элементов
     * @returns {Object} Результат с полями valid, message
     */
    canInsertSubtree(parentId, node, violationsDict = null) {
        const { TEXTBLOCK, VIOLATION, TABLE } = AppConfig.nodeTypes;
        const structure = getStructureLimits();

        const parent = AppState.findNodeById(parentId);

        for (const type of [TEXTBLOCK, VIOLATION, TABLE]) {
            // Effective-лимит: фолбэк из block-types, override рантайм-значением
            // из /acts/limits (как в _validateContentLimits add-пути).
            const spec = getBlockType(type);
            let limit = spec ? spec.limitPerNode : undefined;
            const runtime = structure[RUNTIME_LIMIT_KEY_BY_TYPE[type]];
            if (typeof runtime === 'number') limit = runtime;
            if (typeof limit !== 'number') continue;

            const limitName = AppConfig.content.limitNames[type];
            const fail = () => ValidationCore.failure(
                AppConfig.content.errors.limitReached(limitName, limit)
            );

            if (parent && node.type === type) {
                const existingCount = (parent.children || []).filter(
                    c => c.type === type && c.id !== node.id
                ).length;
                if (existingCount + 1 > limit) return fail();
            }

            const stack = [node];
            while (stack.length) {
                const current = stack.pop();
                if (!Array.isArray(current.children)) continue;
                if (TreeUtils.countChildrenByType(current, type) > limit) return fail();
                stack.push(...current.children);
            }
        }

        const itemsCheck = this._validateSubtreeContentItems(node, violationsDict);
        if (!itemsCheck.valid) return itemsCheck;

        return ValidationCore.success();
    },

    /**
     * Проверяет лимит числа элементов дополнительного контента у нарушений
     * вставляемого поддерева (§5.10b).
     *
     * До этого фронтовый гейт лимита стоял только на путях ДОБАВЛЕНИЯ элемента
     * (_insertContentItemsBulk), а paste/undo проносили готовые нарушения с уже
     * набитым additionalContent мимо него — финальным гейтом оставался бэкенд,
     * отклонявший сохранение всего акта.
     *
     * Проверка — та же самосогласованность, что у лимитов блоков-на-узел: у
     * фрагмента, скопированного/удалённого раньше, число элементов могло стать
     * невалидным, если админ с тех пор снизил лимит. Effective-лимит — из
     * getImageLimits().maxItemsPerViolation (рантайм /acts/limits с собственным
     * фолбэком DEFAULT_IMAGE_LIMITS внутри модуля).
     *
     * @private
     * @param {Object} node - Корень вставляемого поддерева
     * @param {Object|null} violationsDict - Словарь нарушений фрагмента
     * @returns {Object} Результат с полями valid, message
     */
    _validateSubtreeContentItems(node, violationsDict) {
        if (!violationsDict) return ValidationCore.success();

        const maxItems = getImageLimits().maxItemsPerViolation;
        if (typeof maxItems !== 'number') return ValidationCore.success();

        // Поле-ссылка нарушения — из реестра block-types, не хардкодом.
        const refField = getBlockType(AppConfig.nodeTypes.VIOLATION)?.idProp;
        if (!refField) return ValidationCore.success();

        const stack = [node];
        while (stack.length) {
            const current = stack.pop();
            if (!current || typeof current !== 'object') continue;
            const entry = current[refField] ? violationsDict[current[refField]] : null;
            const itemsCount = entry?.additionalContent?.items?.length || 0;
            if (itemsCount > maxItems) {
                return ValidationCore.failure(
                    AppConfig.content.errors.contentItemsLimitReached(maxItems)
                );
            }
            if (Array.isArray(current.children)) stack.push(...current.children);
        }

        return ValidationCore.success();
    }
};

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ValidationTree = ValidationTree;
