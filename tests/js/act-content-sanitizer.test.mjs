/**
 * Тесты orphan-санитайзера контента акта (M.13-фронт).
 *
 * sanitizeActContent — последний рубеж для исторически испорченных данных
 * в БД: (а) отбрасывает записи словарей, чей nodeId не существует в дереве;
 * (б) удаляет листовой узел-зомби, ссылка которого не имеет записи в словаре
 * (зеркало бэкового _strip_dangling_refs); (в) лечит устаревший бэк-референс —
 * запись, на которую ссылается живой узел X, но её nodeId ≠ X.id (§5.10e).
 *
 * Критерий сироты в (а) — ТОЛЬКО отсутствие ссылающегося узла: мёртвый или
 * пустой nodeId при живом владельце чинится правилом (в), а не карается
 * удалением записи и каскадным вырезанием узла.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeActContent } from '../../static/js/constructor/state/act-content-sanitizer.js';

/** Согласованный контент: узлы дерева ↔ записи словарей. */
function makeCleanContent() {
  return {
    tree: {
      id: 'root',
      label: 'Акт',
      children: [
        { id: 'n1', type: 'table', tableId: 't1', children: [] },
        { id: 'n2', type: 'textblock', textBlockId: 'tb1', children: [] },
        {
          id: 'n3',
          type: 'item',
          children: [{ id: 'n4', type: 'violation', violationId: 'v1', children: [] }],
        },
      ],
    },
    tables: { t1: { id: 't1', nodeId: 'n1', grid: [] } },
    textBlocks: { tb1: { id: 'tb1', nodeId: 'n2', content: '' } },
    violations: { v1: { id: 'v1', nodeId: 'n4' } },
  };
}

/** id всех узлов поддерева. */
function nodeIdsOf(tree) {
  const ids = new Set();
  const stack = [tree];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.id) ids.add(n.id);
    (n.children || []).forEach((c) => stack.push(c));
  }
  return ids;
}

test('чистые данные → без изменений (changed=false, контент не тронут)', () => {
  const content = makeCleanContent();
  const reference = JSON.parse(JSON.stringify(content));

  const report = sanitizeActContent(content);

  assert.equal(report.changed, false);
  assert.deepEqual(content, reference);
  assert.deepEqual(report.droppedEntries, { tables: [], textBlocks: [], violations: [] });
  assert.deepEqual(report.removedNodes, []);
});

test('истинная сирота (мёртвый nodeId И никто не ссылается) отбрасывается', () => {
  const content = makeCleanContent();
  // Ни одного узла со ссылкой на t_orphan — лечить нечем, это мусор (в
  // отличие от мёртвого nodeId при живом ссылающемся узле, см. §5.10e ниже).
  content.tables.t_orphan = { id: 't_orphan', nodeId: 'нет_такого_узла', grid: [] };

  const report = sanitizeActContent(content);

  assert.equal(report.changed, true);
  assert.equal(content.tables.t_orphan, undefined);
  assert.deepEqual(report.droppedEntries.tables, ['t_orphan']);
  // Легитимная запись не задета
  assert.ok(content.tables.t1);
});

test('сироты текстблоков и нарушений отбрасываются', () => {
  const content = makeCleanContent();
  content.textBlocks.tb_orphan = { id: 'tb_orphan', nodeId: 'призрак' };
  content.violations.v_orphan = { id: 'v_orphan', nodeId: 'призрак' };

  const report = sanitizeActContent(content);

  assert.equal(report.changed, true);
  assert.equal(content.textBlocks.tb_orphan, undefined);
  assert.equal(content.violations.v_orphan, undefined);
  assert.deepEqual(report.droppedEntries.textBlocks, ['tb_orphan']);
  assert.deepEqual(report.droppedEntries.violations, ['v_orphan']);
});

test('запись без nodeId, на которую никто не ссылается, считается сиротой', () => {
  const content = makeCleanContent();
  content.tables.t_no_node = { id: 't_no_node', grid: [] };

  const report = sanitizeActContent(content);

  assert.equal(content.tables.t_no_node, undefined);
  assert.deepEqual(report.droppedEntries.tables, ['t_no_node']);
});

test('находка #21: nodeId указывает на существующий узел, но узел ссылается на другую запись — дропается (все 3 словаря)', () => {
  const content = makeCleanContent();
  // t_stale выдаёт себя за содержимое узла n1, но n1.tableId по-прежнему 't1' —
  // узел реально НЕ ссылается назад на t_stale (раньше хватало существования n1).
  content.tables.t_stale = { id: 't_stale', nodeId: 'n1', grid: [] };
  content.textBlocks.tb_stale = { id: 'tb_stale', nodeId: 'n2' };
  content.violations.v_stale = { id: 'v_stale', nodeId: 'n4' };

  const report = sanitizeActContent(content);

  assert.equal(content.tables.t_stale, undefined);
  assert.equal(content.textBlocks.tb_stale, undefined);
  assert.equal(content.violations.v_stale, undefined);
  assert.deepEqual(report.droppedEntries.tables, ['t_stale']);
  assert.deepEqual(report.droppedEntries.textBlocks, ['tb_stale']);
  assert.deepEqual(report.droppedEntries.violations, ['v_stale']);
  // Легитимные записи, на которые узлы реально ссылаются, не задеты.
  assert.ok(content.tables.t1);
  assert.ok(content.textBlocks.tb1);
  assert.ok(content.violations.v1);
  // Узлы-владельцы легитимных ссылок остаются на месте (не задеты правилом (б)).
  const ids = nodeIdsOf(content.tree);
  assert.ok(ids.has('n1') && ids.has('n2') && ids.has('n4'));
});

test('находка #21: nodeId ссылается на узел ДРУГОГО типа с тем же id записи — дропается', () => {
  const content = makeCleanContent();
  // t_wrong_type маскируется под запись узла n2 (textblock), но у n2 нет
  // поля tableId вовсе — обратной ссылки на t_wrong_type нет ни у одного узла.
  content.tables.t_wrong_type = { id: 't_wrong_type', nodeId: 'n2', grid: [] };

  const report = sanitizeActContent(content);

  assert.equal(content.tables.t_wrong_type, undefined);
  assert.deepEqual(report.droppedEntries.tables, ['t_wrong_type']);
  assert.ok(content.textBlocks.tb1, 'легитимный textBlock не задет');
});

test('узел-зомби (нет записи в словаре) удаляется целиком', () => {
  const content = makeCleanContent();
  delete content.tables.t1; // запись пропала, узел n1 ссылается в пустоту

  const report = sanitizeActContent(content);

  assert.equal(report.changed, true);
  assert.ok(!nodeIdsOf(content.tree).has('n1'), 'узел-зомби n1 не удалён');
  assert.deepEqual(report.removedNodes, [{ id: 'n1', type: 'table' }]);
  // Соседние валидные узлы на месте.
  assert.ok(nodeIdsOf(content.tree).has('n2'));
});

test('зомби-текстблок и зомби-нарушение (вложенный узел) удаляются', () => {
  const content = makeCleanContent();
  delete content.textBlocks.tb1;
  delete content.violations.v1;

  const report = sanitizeActContent(content);

  const ids = nodeIdsOf(content.tree);
  assert.ok(!ids.has('n2'), 'зомби-текстблок n2 не удалён');
  assert.ok(!ids.has('n4'), 'вложенный зомби-нарушение n4 не удалён');
  // Родительский item n3 (не лист) сохранён, его children пуст.
  assert.ok(ids.has('n3'));
  assert.deepEqual([...report.removedNodes].map((n) => n.id).sort(), ['n2', 'n4']);
});

test('§5.10e: nodeId записи мёртв, но узел на неё ссылается → лечится, каскад (а)→(б) НЕ срабатывает', () => {
  const content = makeCleanContent();
  // Запись указывает на несуществующий узел, а легитимный узел n1 — на неё.
  // Раньше это трактовалось как сирота: (а) сносила запись, следом (б) вырезала
  // живой узел n1 — потеря целой таблицы из-за починяемого бэк-референса.
  content.tables.t1.nodeId = 'призрак';

  const report = sanitizeActContent(content);

  assert.ok(content.tables.t1, 'запись с живым ссылающимся узлом не сирота');
  assert.equal(content.tables.t1.nodeId, 'n1', 'мёртвый nodeId вылечен по ссылающемуся узлу');
  assert.ok(nodeIdsOf(content.tree).has('n1'), 'узел-владелец остаётся в дереве');
  assert.deepEqual(report.droppedEntries.tables, []);
  assert.deepEqual(report.removedNodes, []);
  assert.deepEqual(report.healedNodeIds.tables, [{ id: 't1', from: 'призрак', to: 'n1' }]);
});

test('§5.10e: у записи нет nodeId вовсе, но узел на неё ссылается → лечится', () => {
  const content = makeCleanContent();
  delete content.violations.v1.nodeId;

  const report = sanitizeActContent(content);

  assert.ok(content.violations.v1, 'запись не отброшена');
  assert.equal(content.violations.v1.nodeId, 'n4');
  assert.deepEqual(report.healedNodeIds.violations, [{ id: 'v1', from: undefined, to: 'n4' }]);
  assert.deepEqual(report.droppedEntries.violations, []);
});

// ── §5.10e: правило (в) — лечение устаревшего бэк-референса ────────────────

test('§5.10e: nodeId записи указывает на ДРУГОЙ существующий узел → лечится, запись цела', () => {
  const content = makeCleanContent();
  // n1.tableId === 't1' (ссылка узла валидна), но сама запись t1 считает своим
  // узлом n2 — тоже существующий, но чужой. Оба условия правила (а) ложны, и
  // раньше запись проходила сверку с рассинхроном.
  content.tables.t1.nodeId = 'n2';

  const report = sanitizeActContent(content);

  assert.equal(report.changed, true);
  assert.ok(content.tables.t1, 'запись с валидной ссылкой узла не должна отбрасываться');
  assert.equal(content.tables.t1.nodeId, 'n1', 'nodeId вылечен по ссылающемуся узлу');
  assert.deepEqual(report.healedNodeIds.tables, [{ id: 't1', from: 'n2', to: 'n1' }]);
  assert.deepEqual(report.droppedEntries.tables, []);
  // Узел-владелец не задет правилом (б) — ссылка осталась разрешимой.
  assert.ok(nodeIdsOf(content.tree).has('n1'));
});

test('§5.10e: лечатся записи всех словарей (textBlocks/violations)', () => {
  const content = makeCleanContent();
  content.textBlocks.tb1.nodeId = 'n1';
  content.violations.v1.nodeId = 'n3';

  const report = sanitizeActContent(content);

  assert.equal(content.textBlocks.tb1.nodeId, 'n2');
  assert.equal(content.violations.v1.nodeId, 'n4');
  assert.deepEqual(report.healedNodeIds.textBlocks, [{ id: 'tb1', from: 'n1', to: 'n2' }]);
  assert.deepEqual(report.healedNodeIds.violations, [{ id: 'v1', from: 'n3', to: 'n4' }]);
  assert.deepEqual(report.droppedEntries, { tables: [], textBlocks: [], violations: [] });
});

test('§5.10e: второй проход по вылеченным данным ничего не меняет (идемпотентность)', () => {
  const content = makeCleanContent();
  content.tables.t1.nodeId = 'n2';

  sanitizeActContent(content);
  const afterFirst = JSON.parse(JSON.stringify(content));

  const second = sanitizeActContent(content);

  assert.equal(second.changed, false, 'повторный прогон не должен ничего править');
  assert.deepEqual(second.healedNodeIds, { tables: [], textBlocks: [], violations: [] });
  assert.deepEqual(content, afterFirst, 'контент после второго прохода идентичен');
});

test('§5.10e: ссылающийся узел БЕЗ id владельцем не считается — запись дропается, узел вынесен каскадом', () => {
  // Вырожденные данные: узел ссылается на запись, но сам без id — вылечить
  // entry.nodeId нечем (нечего подставить), и сам узел неадресуем.
  const content = {
    tree: {
      id: 'root', label: 'Акт',
      children: [{ type: 'table', tableId: 't1', children: [] }],
    },
    tables: { t1: { id: 't1', nodeId: 'n1', grid: [] } },
    textBlocks: {},
    violations: {},
  };

  const report = sanitizeActContent(content);

  assert.equal(content.tables.t1, undefined, 'запись без опознаваемого владельца — сирота');
  assert.deepEqual(report.droppedEntries.tables, ['t1']);
  assert.equal(content.tree.children.length, 0, 'безымянный узел вынесен каскадом (б)');
  assert.deepEqual(report.healedNodeIds.tables, []);
});

test('§5.10e: лечение не мешает правилу (а) — не ссылающаяся запись по-прежнему дропается', () => {
  const content = makeCleanContent();
  content.tables.t1.nodeId = 'n2';                                   // лечится
  content.tables.t_stale = { id: 't_stale', nodeId: 'n1', grid: [] }; // на неё никто не ссылается

  const report = sanitizeActContent(content);

  assert.equal(content.tables.t1.nodeId, 'n1');
  assert.equal(content.tables.t_stale, undefined);
  assert.deepEqual(report.droppedEntries.tables, ['t_stale']);
  assert.deepEqual(report.healedNodeIds.tables, [{ id: 't1', from: 'n2', to: 'n1' }]);
});

test('пустое/отсутствующее дерево → no-op', () => {
  assert.equal(sanitizeActContent(null).changed, false);
  assert.equal(sanitizeActContent({}).changed, false);
  assert.equal(sanitizeActContent({ tree: null, tables: { x: { nodeId: 'y' } } }).changed, false);
});

test('отсутствующие словари не ломают обход (б)', () => {
  const content = {
    tree: { id: 'root', children: [{ id: 'n1', type: 'table', tableId: 't1', children: [] }] },
  };

  const report = sanitizeActContent(content);

  assert.equal(report.changed, true);
  assert.ok(!nodeIdsOf(content.tree).has('n1'));
  assert.deepEqual(report.removedNodes, [{ id: 'n1', type: 'table' }]);
});

test('удаление зомби-узла вычищает осиротевшие записи его потомков', () => {
  // n1 — зомби (tableId без записи), но у него валидный потомок-нарушение n2.
  // После вырезания n1 поддерево с n2 исчезает → запись violations.v2
  // становится сиротой и должна быть вычищена этим же проходом.
  const content = {
    tree: {
      id: 'root', label: 'Акт',
      children: [
        {
          id: 'n1', type: 'table', tableId: 't_missing',
          children: [
            { id: 'n2', type: 'violation', violationId: 'v2', children: [] },
          ],
        },
      ],
    },
    tables: {},
    textBlocks: {},
    violations: { v2: { id: 'v2', nodeId: 'n2' } },
  };

  const report = sanitizeActContent(content);

  const ids = nodeIdsOf(content.tree);
  assert.ok(!ids.has('n1'), 'зомби-узел n1 не удалён');
  assert.ok(!ids.has('n2'), 'потомок зомби n2 не удалён');
  // Осиротевшая запись потомка вычищена (а не оставлена бэкенду).
  assert.equal(content.violations.v2, undefined);
  assert.ok(report.removedNodes.some((n) => n.id === 'n1'));
  assert.deepEqual(report.droppedEntries.violations, ['v2']);
});
