/**
 * Чистые (DOM-независимые) хелперы для замены по текстблокам (B2). Вынесены из
 * find-bar.js, чтобы арифметика счётчика/навигации, текст подтверждения,
 * группировка совпадений по цели и снимок/восстановление контента блоков
 * тестировались в node без реального DOM/Range.
 *
 * Живая замена (мутация DOM + persist) остаётся в FindBar: она принципиально
 * DOM-зависима и отложена в Playwright. Здесь — только чистая логика вокруг неё.
 */

/**
 * Склоняет русское слово по числу (стандартное правило количественных
 * числительных): n%10==1 && n%100!=11 → форма «один»; n%10 in 2..4 &&
 * n%100 not in 12..14 → форма «два-четыре»; иначе — форма «пять-много».
 * @param {number} n Число, с которым согласуется слово.
 * @param {[string, string, string]} forms Формы [один, два-четыре, пять-много]
 *   (напр. `['совпадение', 'совпадения', 'совпадений']`).
 * @returns {string} Форма слова, согласованная с `n`.
 */
export function pluralRu(n, forms) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
    return forms[2];
}

/**
 * Текст подтверждения «Заменить всё» (с корректным склонением). Единица счёта —
 * «фрагмент», а не «блок»: цели теперь смешанные (текстблоки И rich-поля
 * нарушений), «блок» — доменное имя именно текстблока и вводил бы в заблуждение.
 * @param {number} matchCount Число совпадений.
 * @param {number} fragmentCount Число затронутых фрагментов (текстблоков/полей нарушений).
 * @returns {string}
 */
export function buildReplaceAllConfirmMessage(matchCount, fragmentCount) {
    const matchWord = pluralRu(matchCount, ['совпадение', 'совпадения', 'совпадений']);
    const fragmentWord = pluralRu(fragmentCount, ['фрагменте', 'фрагментах', 'фрагментах']);
    return `Заменить ${matchCount} ${matchWord} в ${fragmentCount} ${fragmentWord}?`;
}

/**
 * Форматирует индикатор счётчика совпадений «k / N». При переполнении (capped)
 * итог показывается как «N+» (напр. «5000+»); при отсутствии совпадений — «0 / 0».
 * @param {number} currentIdx Индекс текущего совпадения (−1 — нет текущего).
 * @param {number} total Всего найдено совпадений.
 * @param {boolean} capped Достигнут ли жёсткий лимит (buildAllMatches.capped).
 * @param {number} [max=5000] Значение лимита для метки «N+».
 * @returns {string}
 */
export function formatMatchCounter(currentIdx, total, capped, max = 5000) {
    if (!total || total <= 0) return '0 / 0';
    const totalLabel = capped ? `${max}+` : String(total);
    const cur = currentIdx >= 0 ? currentIdx + 1 : 0;
    return `${cur} / ${totalLabel}`;
}

/**
 * Нормализует индекс в диапазон [0, len) с заворачиванием (для prev/next по
 * кольцу). Пустой список → −1.
 * @param {number} idx Возможно отрицательный/за пределами индекс.
 * @param {number} len Длина списка.
 * @returns {number}
 */
export function wrapIndex(idx, len) {
    if (!len || len <= 0) return -1;
    return ((idx % len) + len) % len;
}

/**
 * Группирует плоский список совпадений (в порядке документа) по targetId,
 * сохраняя порядок появления целей и порядок совпадений внутри цели.
 * @param {Array<{targetId:string}>} matches Плоский список (buildAllMatches).
 * @returns {Map<string, Array>} targetId → совпадения этой цели (в DOM-порядке).
 */
export function groupMatchesByTarget(matches) {
    const groups = new Map();
    for (const m of (matches || [])) {
        if (!m || m.targetId == null) continue;
        let bucket = groups.get(m.targetId);
        if (!bucket) {
            bucket = [];
            groups.set(m.targetId, bucket);
        }
        bucket.push(m);
    }
    return groups;
}

/**
 * Снимает контент указанных блоков ДО пакетной замены (для одношагового undo).
 * `store` — map-подобный источник (в бою `AppState.textBlocks`), читается как
 * `store[id].content`. Отсутствующие блоки пропускаются.
 * @param {Iterable<string>} ids Идентификаторы затронутых блоков.
 * @param {Object} store Источник блоков (`{[id]: {content}}`).
 * @returns {Map<string, string>} id → исходный content.
 */
export function snapshotTextBlockContents(ids, store) {
    const snap = new Map();
    for (const id of ids) {
        const tb = store ? store[id] : null;
        if (tb && typeof tb.content === 'string') {
            snap.set(id, tb.content);
        }
    }
    return snap;
}

/**
 * Восстанавливает снятый снимок обратно в `store[id].content` (запись через
 * Proxy → dirty-tracking в бою) и вызывает `onEach(id)` для перерисовки блока.
 * Чистая логика записи/обхода — DOM-перерисовка инжектится колбэком.
 * @param {Map<string, string>} snapshot id → исходный content.
 * @param {Object} store Приёмник блоков (`{[id]: {content}}`).
 * @param {(id:string)=>void} [onEach] Колбэк на каждый восстановленный id.
 * @returns {number} Число восстановленных блоков.
 */
export function applySnapshotRestore(snapshot, store, onEach) {
    let restored = 0;
    if (!snapshot) return restored;
    for (const [id, content] of snapshot) {
        const tb = store ? store[id] : null;
        if (!tb) continue;
        tb.content = content;
        restored++;
        if (typeof onEach === 'function') onEach(id);
    }
    return restored;
}

/**
 * Снимок контента ЦЕЛЕЙ-ПОВЕРХНОСТЕЙ нарушения (rich-полей) для одношагового
 * undo replace-all — параллель snapshotTextBlockContents, но модель поля НЕ в
 * AppState.textBlocks: читаем её через саму цель (target.getContent(), которая
 * делегирует в поверхность). По id цели. Нестроковый/отсутствующий content
 * пропускается (симметрично snapshotTextBlockContents с `typeof ... === 'string'`).
 * @param {Iterable<{id:string, getContent:()=>*}>} targets Затронутые violation-цели.
 * @returns {Map<string, string>} id цели → исходный content поля.
 */
export function snapshotSurfaceContents(targets) {
    const snap = new Map();
    for (const t of (targets || [])) {
        if (!t || t.id == null || typeof t.getContent !== 'function') continue;
        const c = t.getContent();
        if (typeof c === 'string') snap.set(t.id, c);
    }
    return snap;
}

/**
 * Восстанавливает снимок violation-полей (см. snapshotSurfaceContents) с
 * divergence-guard — параллель ветки textblock в FindBar._undoReplaceAll:
 * поле возвращается к `before` ТОЛЬКО если его текущий content всё ещё равен
 * `after` (не редактировалось с момента замены). Цели пере-резолвит вызывающий
 * по СВЕЖЕМУ DOM (targetsById) — исчезнувшая/изменённая/не умеющая писать
 * (без setContent) цель пропускается, чтобы не затереть правки и не упасть.
 * Запись + ре-рендер + синк класса --empty инкапсулированы в target.setContent.
 * @param {Map<string, {before:string, after:string}>} undoMap Снимок «до/после».
 * @param {Map<string, {getContent:()=>*, setContent:(html:string)=>void}>} targetsById
 * @returns {{restored:number, skipped:number}}
 */
export function restoreSurfaceSnapshot(undoMap, targetsById) {
    let restored = 0;
    let skipped = 0;
    if (!undoMap) return { restored, skipped };
    for (const [id, snap] of undoMap) {
        const t = targetsById ? targetsById.get(id) : null;
        if (!t || typeof t.getContent !== 'function' || typeof t.setContent !== 'function'
            || t.getContent() !== snap.after) {
            skipped++;
            continue;
        }
        t.setContent(snap.before);
        restored++;
    }
    return { restored, skipped };
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ActSearchReplace = {
    pluralRu,
    buildReplaceAllConfirmMessage,
    formatMatchCounter,
    wrapIndex,
    groupMatchesByTarget,
    snapshotTextBlockContents,
    applySnapshotRestore,
    snapshotSurfaceContents,
    restoreSurfaceSnapshot,
};
