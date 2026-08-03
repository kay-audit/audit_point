/**
 * Санитайзер несогласованных данных контента акта (M.13-фронт).
 *
 * Последний рубеж для уже испорченных данных в БД: бэкенд новые висячие
 * ссылки отбивает кросс-валидатором на PUT и фильтрует сирот при сохранении,
 * но записи, испорченные до появления этих гардов, могли остаться.
 *
 * Правила:
 *  (а) записи словарей tables/textBlocks/violations отбрасываются, если ни один
 *      узел дерева реально не ссылается на эту запись через своё поле-ссылку
 *      (обратная сверка, находка #21: раньше проверялось только существование
 *      узла с таким id — фантомная запись, чей "хозяин" на деле ссылается на
 *      другую запись словаря, могла уцелеть). Само по себе значение
 *      entry.nodeId условием дропа НЕ является — см. (в);
 *  (б) листовой узел (tableId/textBlockId/violationId) без записи в словаре —
 *      удаляется ЦЕЛИКОМ из дерева (зеркало бэкового _strip_dangling_refs):
 *      снять только ссылку мало — пустой узел-зомби всё равно отрисуется в
 *      экспорте («Таблица N» без данных) и не вычистится пересохранением;
 *  (в) устаревший бэк-референс (§5.10e): на запись ссылается один или
 *      несколько живых узлов дерева, но её entry.nodeId не совпадает НИ С
 *      ОДНИМ из них — указывает на другой узел, на несуществующий или
 *      отсутствует вовсе. Это рассинхрон, а не мусор: не отбрасываем, а ЛЕЧИМ
 *      (entry.nodeId = id ПЕРВОГО в документном порядке ссылающегося узла).
 *      Если entry.nodeId уже совпадает с одним из ссылающихся узлов (при
 *      битых данных их может быть несколько) — он и есть валидный владелец,
 *      трогать нельзя (находка №4: раньше при битом дубле ссылки владельцем
 *      «назначался» ПОСЛЕДНИЙ по документу узел из-за обхода через LIFO-стек
 *      без разворота детей — здоровое значение entry.nodeId переписывалось
 *      на чужой узел). Источник истины — ссылка узла дерева, а не
 *      денормализованный обратный указатель записи. Раньше «мёртвый» nodeId
 *      уводил запись под правило (а), и каскад (а)→(б) сносил заодно живой
 *      узел — потеря целой таблицы/нарушения из-за починяемого поля.
 *
 * Применяется в loadActContent ПОСЛЕ получения контента (включая
 * восстановленный черновик) и ДО присвоения в AppState.
 */

import { BLOCK_TYPES, LEAF_BLOCK_TYPES } from '../block-types.js';

// [dictName, refField] для каждого листового типа — из реестра block-types.js
// (не хардкод): добавление типа-блока не требует правки этого санитайзера.
const DICT_REFS = LEAF_BLOCK_TYPES.map((t) => [BLOCK_TYPES[t].dictName, BLOCK_TYPES[t].idProp]);

/**
 * Чистит несогласованные данные контента акта на месте.
 *
 * @param {Object} content Контент акта ({tree, tables, textBlocks, violations, ...})
 * @returns {{changed: boolean, droppedEntries: Object<string, string[]>,
 *            removedNodes: Array<{id:string,type:string}>,
 *            healedNodeIds: Object<string, Array<{id:string,from:string,to:string}>>}}
 *   Отчёт: changed — было ли что-то исправлено; droppedEntries — id отброшенных
 *   записей по словарям; removedNodes — {id,type} удалённых узлов-зомби (B-38:
 *   структурно, т.к. отчёт уходит в серверный лог); healedNodeIds — записи с
 *   вылеченным по правилу (в) nodeId (было → стало).
 */
export function sanitizeActContent(content) {
    const report = {
        changed: false,
        droppedEntries: { tables: [], textBlocks: [], violations: [] },
        removedNodes: [],
        healedNodeIds: { tables: [], textBlocks: [], violations: [] },
    };

    if (!content || !content.tree || typeof content.tree !== 'object') {
        return report;
    }

    // (а) и (б) взаимозависимы: вырезание зомби-узла уносит и его поддерево,
    // осиротив записи словарей у потомков; отброшенная запись делает ссылку
    // другого узла висячей. Поэтому повторяем оба правила до стабилизации —
    // обратный индекс и список {node, parent} строятся заново по ТЕКУЩЕМУ
    // (уже обрезанному) дереву. Каждый результативный проход строго что-то
    // удаляет (id-узлов/записей конечно) → цикл завершается.
    for (;;) {
        const linked = [];
        // Обратный индекс (находка #21, Вариант Б): для каждого словаря — id
        // записей, на которые РЕАЛЬНО ссылается хотя бы один узел через своё
        // поле-ссылку (node[refField]). Значение — СПИСОК id ссылающихся узлов
        // в ДОКУМЕНТНОМ ПОРЯДКЕ (находка №4): ссылающихся узлов может
        // оказаться несколько (битые данные — дубль ссылки), и владельцем
        // должен считаться узел, на который реально указывает entry.nodeId
        // (если он входит в список), а не первый/последний по порядку обхода.
        // Перестраивается каждый проход по ТЕКУЩЕМУ дереву.
        const referrers = Object.fromEntries(DICT_REFS.map(([dictName]) => [dictName, new Map()]));
        // DFS сверху вниз, дети в естественном (документном) порядке: стек
        // LIFO обходит в обратном порядке, если пушить детей как есть, —
        // поэтому пушим их в РЕВЕРСЕ, чтобы pop() возвращал первого ребёнка
        // первым (находка №4: раньше порядок был обратным, и «первым
        // встреченным» оказывался последний по документу узел).
        const stack = [{ node: content.tree, parent: null }];
        while (stack.length) {
            const { node, parent } = stack.pop();
            if (!node || typeof node !== 'object') continue;
            linked.push({ node, parent });
            for (const [dictName, refField] of DICT_REFS) {
                const ref = node[refField];
                // Узел без id владельцем быть не может (лечить entry.nodeId
                // нечем, да и сам узел неадресуем), поэтому такие ссылки не
                // регистрируем: запись без опознаваемого владельца — сирота
                // по (а), и каскад (б) заодно вынесет безымянный узел.
                if (ref && node.id) {
                    if (!referrers[dictName].has(ref)) referrers[dictName].set(ref, []);
                    referrers[dictName].get(ref).push(node.id);
                }
            }
            if (Array.isArray(node.children)) {
                for (let i = node.children.length - 1; i >= 0; i--) {
                    stack.push({ node: node.children[i], parent: node });
                }
            }
        }

        let changedThisPass = false;

        // (а) сироты словарей: ни один узел (текущего) дерева не ссылается на
        //     entryId — находка #21, в т.ч. записи потомков удалённых на
        //     прошлом проходе зомби-узлов (их узлов в дереве уже нет, значит
        //     и ссылок на записи не осталось). Форма записи не object (или
        //     сама запись отсутствует) — тоже сирота (находка №2): запись-
        //     примитив (строка/число) не пережила бы entry.nodeId = ... ниже
        //     (TypeError в strict mode ESM), поэтому дропаем её как мусор, не
        //     пытаясь лечить.
        // (в) рассинхрон: ссылающиеся узлы есть, но entry.nodeId не совпадает
        //     ни с одним из них — лечим на первого в документном порядке
        //     (§5.10e, находка №4).
        for (const [dictName] of DICT_REFS) {
            const dict = content[dictName];
            if (!dict || typeof dict !== 'object') continue;
            for (const [entryId, entry] of Object.entries(dict)) {
                const isPlainEntry = !!entry && typeof entry === 'object' && !Array.isArray(entry);
                const owners = referrers[dictName].get(entryId);
                if (!isPlainEntry || !owners || owners.length === 0) {
                    delete dict[entryId];
                    report.droppedEntries[dictName].push(entryId);
                    report.changed = true;
                    changedThisPass = true;
                } else if (!owners.includes(entry.nodeId)) {
                    // entry.nodeId не входит в число реальных владельцев —
                    // либо мёртвый/пустой, либо указывает на узел, который
                    // ссылается на ДРУГУЮ запись. Лечим на первого владельца
                    // по документу; если entry.nodeId уже совпадает с одним
                    // из owners (в т.ч. не первым — битый дубль ссылки),
                    // ветка не выполняется, значение не трогаем (находка №4).
                    //
                    // Лечение идемпотентно и не трогает ни дерево, ни ссылки
                    // узлов, поэтому changedThisPass НЕ поднимаем: повторный
                    // проход по этой записи уже ничего не изменит, а инвариант
                    // «результативный проход строго что-то удаляет» (условие
                    // завершения цикла ниже) сохраняется.
                    report.healedNodeIds[dictName].push({
                        id: entryId,
                        from: entry.nodeId,
                        to: owners[0],
                    });
                    entry.nodeId = owners[0];
                    report.changed = true;
                }
            }
        }

        // (б) узлы-зомби: листовая ссылка указывает на отсутствующую запись
        //     словаря (в т.ч. после (а)) → удаляем узел целиком из родителя.
        for (const { node, parent } of linked) {
            if (!parent || !Array.isArray(parent.children)) continue;
            const dangling = DICT_REFS.some(([dictName, refField]) => {
                const ref = node[refField];
                return ref && !(content[dictName] && content[dictName][ref]);
            });
            if (dangling) {
                const idx = parent.children.indexOf(node);
                if (idx !== -1) {
                    parent.children.splice(idx, 1);
                    // B-38: {id,type} — тип узла помогает диагностике в логе.
                    report.removedNodes.push({
                        id: node.id || '(без id)',
                        type: node.type || '(без типа)',
                    });
                    report.changed = true;
                    changedThisPass = true;
                }
            }
        }

        if (!changedThisPass) break;
    }

    return report;
}
