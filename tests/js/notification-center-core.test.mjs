/**
 * Тесты чистого ядра центра уведомлений (notification-center-core.js).
 *
 * Покрывают:
 *   - pickBadgeSeverity — приоритет error > warning > info; пусто → info;
 *     учёт и живых, и персистентных; нормализация неизвестных severity.
 *   - pickBadgeSeverityWithServer — цвет = max(живые, серверная severity);
 *     локальный снимок персистентных в расчёте не участвует, null/пусто не влияют.
 *   - computeBadge — скрытие при сумме 0, суммирование непрочитанных + живых.
 *   - mergeFeed — порядок (живые сверху), нормализация формы и kind, проброс
 *     children/count у живых групп однотипных замечаний.
 *   - countPersistedUnread — подсчёт непрочитанных.
 *   - resolvePollIntervalMs — секунды→мс, фолбэк и нижняя граница.
 *   - formatBadgeCount — клампинг к "max+" и нормализация мусора к "0".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSeverity,
  pickBadgeSeverity,
  pickBadgeSeverityWithServer,
  computeBadge,
  mergeFeed,
  countPersistedUnread,
  countUnreadLive,
  resolvePollIntervalMs,
  formatBadgeCount,
} from '../../static/js/shared/notifications-center/notification-center-core.js';

// ── normalizeSeverity ───────────────────────────────────────────────────────

test('normalizeSeverity: известные уровни проходят как есть', () => {
  assert.equal(normalizeSeverity('error'), 'error');
  assert.equal(normalizeSeverity('warning'), 'warning');
  assert.equal(normalizeSeverity('info'), 'info');
});

test('normalizeSeverity: success/неизвестное/пустое → info', () => {
  assert.equal(normalizeSeverity('success'), 'info');
  assert.equal(normalizeSeverity('whatever'), 'info');
  assert.equal(normalizeSeverity(undefined), 'info');
  assert.equal(normalizeSeverity(null), 'info');
});

// ── pickBadgeSeverity ───────────────────────────────────────────────────────

test('pickBadgeSeverity: пустой/невалидный вход → info', () => {
  assert.equal(pickBadgeSeverity([]), 'info');
  assert.equal(pickBadgeSeverity(null), 'info');
  assert.equal(pickBadgeSeverity(undefined), 'info');
});

test('pickBadgeSeverity: error важнее warning важнее info', () => {
  assert.equal(pickBadgeSeverity([{ severity: 'info' }, { severity: 'warning' }]), 'warning');
  assert.equal(pickBadgeSeverity([{ severity: 'warning' }, { severity: 'error' }]), 'error');
  assert.equal(pickBadgeSeverity([{ severity: 'info' }, { severity: 'info' }]), 'info');
});

test('pickBadgeSeverity: учитывает и живые, и персистентные вместе', () => {
  const live = [{ severity: 'warning' }];
  const persisted = [{ severity: 'error' }];
  assert.equal(pickBadgeSeverity([...live, ...persisted]), 'error');
});

test('pickBadgeSeverity: неизвестный severity трактуется как info', () => {
  assert.equal(pickBadgeSeverity([{ severity: 'success' }]), 'info');
  // success среди warning не повышает критичность
  assert.equal(pickBadgeSeverity([{ severity: 'success' }, { severity: 'warning' }]), 'warning');
});

// ── pickBadgeSeverityWithServer ───────────────────────────────────────────────
//
// С отказом от подмешивания локального снимка персистентных в цвет (снимок
// тянется только при открытом меню и может не обновляться при закрытом —
// см. notification-center.js: _loadPersisted/_pollTick) функция принимает
// только живые элементы + серверную severity; персистентного массива в
// сигнатуре больше нет — снимок структурно не может повлиять на цвет.

test('pickBadgeSeverityWithServer: серверная severity важнее меньшего максимума живых', () => {
  const live = [{ severity: 'warning' }];
  assert.equal(pickBadgeSeverityWithServer(live, 'error'), 'error');
});

test('pickBadgeSeverityWithServer: живые важнее, если сервер сообщает меньшую критичность', () => {
  const live = [{ severity: 'error' }];
  assert.equal(pickBadgeSeverityWithServer(live, 'info'), 'error');
});

test('pickBadgeSeverityWithServer: null/undefined серверная severity → цвет только по живым', () => {
  assert.equal(pickBadgeSeverityWithServer([{ severity: 'warning' }], null), 'warning');
  assert.equal(pickBadgeSeverityWithServer([{ severity: 'warning' }], undefined), 'warning');
  // совсем пусто и нет серверной → info
  assert.equal(pickBadgeSeverityWithServer([], null), 'info');
});

test('pickBadgeSeverityWithServer: невалидный массив живых не падает', () => {
  assert.equal(pickBadgeSeverityWithServer(null, 'warning'), 'warning');
  assert.equal(pickBadgeSeverityWithServer(undefined, null), 'info');
});

// ── computeBadge ────────────────────────────────────────────────────────────

test('computeBadge: 0+0 → скрыт, count 0', () => {
  assert.deepEqual(computeBadge(0, 0), { count: 0, hidden: true });
});

test('computeBadge: суммирует непрочитанные персистентные и живые', () => {
  assert.deepEqual(computeBadge(3, 2), { count: 5, hidden: false });
  assert.deepEqual(computeBadge(0, 4), { count: 4, hidden: false });
  assert.deepEqual(computeBadge(2, 0), { count: 2, hidden: false });
});

test('computeBadge: отрицательные/нечисловые нормализуются к 0', () => {
  assert.deepEqual(computeBadge(-5, 3), { count: 3, hidden: false });
  assert.deepEqual(computeBadge(NaN, NaN), { count: 0, hidden: true });
  assert.deepEqual(computeBadge(undefined, 1), { count: 1, hidden: false });
});

// ── mergeFeed ───────────────────────────────────────────────────────────────

test('mergeFeed: живые идут сверху, затем персистентные', () => {
  const live = [{ id: 'L1', title: 'live', severity: 'warning' }];
  const persisted = [{ id: 'P1', title: 'persisted', severity: 'info', is_read: false }];
  const feed = mergeFeed(live, persisted);
  assert.equal(feed.length, 2);
  assert.equal(feed[0].kind, 'live');
  assert.equal(feed[0].id, 'L1');
  assert.equal(feed[1].kind, 'persisted');
  assert.equal(feed[1].id, 'P1');
});

test('mergeFeed: сохраняет порядок внутри каждой группы', () => {
  const live = [{ id: 'L1' }, { id: 'L2' }];
  const persisted = [{ id: 'P1' }, { id: 'P2' }];
  const feed = mergeFeed(live, persisted);
  assert.deepEqual(feed.map((x) => x.id), ['L1', 'L2', 'P1', 'P2']);
});

test('mergeFeed: нормализует severity и заполняет дефолты', () => {
  const feed = mergeFeed(
    [{ id: 'L1', severity: 'success' }],
    [{ id: 'P1', severity: undefined, title: 'T', body: 'B', link: '/x', element_ref: 'e', is_read: true }],
  );
  // живой success → info, source по умолчанию 'tables'
  assert.equal(feed[0].severity, 'info');
  assert.equal(feed[0].source, 'tables');
  assert.equal(feed[0].title, '');
  // персистентный: severity → info, поля проброшены, is_read булев
  assert.equal(feed[1].severity, 'info');
  assert.equal(feed[1].title, 'T');
  assert.equal(feed[1].body, 'B');
  assert.equal(feed[1].link, '/x');
  assert.equal(feed[1].element_ref, 'e');
  assert.equal(feed[1].is_read, true);
});

test('mergeFeed: живые получают is_read (дефолт false), но не link/element_ref; персистентные без onClick', () => {
  const feed = mergeFeed(
    [{ id: 'L1', onClick: () => {} }],
    [{ id: 'P1' }],
  );
  assert.equal('link' in feed[0], false);
  assert.equal('element_ref' in feed[0], false);
  // Живой без состояния — непрочитан по умолчанию (вечно горит).
  assert.equal(feed[0].is_read, false);
  assert.equal(typeof feed[0].onClick, 'function');
  assert.equal('onClick' in feed[1], false);
  assert.equal(feed[1].is_read, false);
});

test('mergeFeed: живой с is_read=true и обработчиками действий пробрасывает их', () => {
  const onMarkRead = () => {};
  const onDelete = () => {};
  const feed = mergeFeed(
    [{ id: 'L1', severity: 'warning', is_read: true, onMarkRead, onDelete }],
    [],
  );
  assert.equal(feed[0].is_read, true);
  assert.equal(feed[0].onMarkRead, onMarkRead);
  assert.equal(feed[0].onDelete, onDelete);
});

test('mergeFeed: живая группа доносит children и count до рендера', () => {
  const children = [{ id: 'c1' }, { id: 'c2' }];
  const feed = mergeFeed([{ id: 'G1', severity: 'warning', count: 2, children }], []);

  // Ядро пересобирает элемент по явному списку полей — без этого проброса
  // группа доехала бы до _buildItem обычной строкой без вложенных записей.
  assert.equal(feed[0].count, 2);
  assert.equal(feed[0].children, children);
});

test('mergeFeed: обычная живая запись получает children/count = null', () => {
  const feed = mergeFeed([{ id: 'L1' }], [{ id: 'P1' }]);

  // Рендер решает «группа или нет» по Array.isArray(children) — не-массив
  // обязан оставаться не-массивом, иначе одиночная запись станет пустой группой.
  assert.equal(feed[0].children, null);
  assert.equal(feed[0].count, null);
  // Персистентные групп не образуют — полей нет вовсе.
  assert.equal('children' in feed[1], false);
});

test('mergeFeed: мусор в count/children группой запись не делает', () => {
  const feed = mergeFeed([{ id: 'L1', count: '5', children: { length: 2 } }], []);
  assert.equal(feed[0].count, null);
  assert.equal(feed[0].children, null);
});

// ── countUnreadLive ─────────────────────────────────────────────────────────

test('countUnreadLive: считает живые с is_read !== true', () => {
  const live = [
    { id: '1' },                 // нет is_read → непрочитано (вечно горит)
    { id: '2', is_read: false }, // непрочитано
    { id: '3', is_read: true },  // прочитано → не считается
  ];
  assert.equal(countUnreadLive(live), 2);
});

test('countUnreadLive: пусто/не массив → 0', () => {
  assert.equal(countUnreadLive([]), 0);
  assert.equal(countUnreadLive(null), 0);
  assert.equal(countUnreadLive(undefined), 0);
});

test('mergeFeed: пустые/невалидные входы → []', () => {
  assert.deepEqual(mergeFeed([], []), []);
  assert.deepEqual(mergeFeed(null, null), []);
  assert.deepEqual(mergeFeed(undefined, undefined), []);
});

test('mergeFeed: пропускает falsy-элементы', () => {
  const feed = mergeFeed([null, { id: 'L1' }], [undefined, { id: 'P1' }]);
  assert.deepEqual(feed.map((x) => x.id), ['L1', 'P1']);
});

// ── countPersistedUnread ────────────────────────────────────────────────────

test('countPersistedUnread: считает все с is_read !== true', () => {
  const items = [
    { id: '1', is_read: false },
    { id: '2', is_read: true },
    { id: '3' }, // нет is_read → непрочитано
  ];
  assert.equal(countPersistedUnread(items), 2);
});

test('countPersistedUnread: пусто/невалидно → 0', () => {
  assert.equal(countPersistedUnread([]), 0);
  assert.equal(countPersistedUnread(null), 0);
  assert.equal(countPersistedUnread(undefined), 0);
});

// ── resolvePollIntervalMs ─────────────────────────────────────────────────────

test('resolvePollIntervalMs: валидные секунды → миллисекунды', () => {
  assert.equal(resolvePollIntervalMs(30), 30000);
  assert.equal(resolvePollIntervalMs(60), 60000);
  assert.equal(resolvePollIntervalMs('45'), 45000);
});

test('resolvePollIntervalMs: невалидное/неположительное → дефолт', () => {
  assert.equal(resolvePollIntervalMs(undefined), 30000);
  assert.equal(resolvePollIntervalMs(null), 30000);
  assert.equal(resolvePollIntervalMs('x'), 30000);
  assert.equal(resolvePollIntervalMs(0), 30000);
  assert.equal(resolvePollIntervalMs(-5), 30000);
});

test('resolvePollIntervalMs: ниже минимума поднимается до minMs', () => {
  // 2с < 5с (минимум по умолчанию)
  assert.equal(resolvePollIntervalMs(2), 5000);
});

test('resolvePollIntervalMs: кастомные defaultMs/minMs', () => {
  assert.equal(resolvePollIntervalMs(undefined, { defaultMs: 10000 }), 10000);
  assert.equal(resolvePollIntervalMs(1, { minMs: 3000 }), 3000);
  assert.equal(resolvePollIntervalMs(120, { minMs: 3000, defaultMs: 10000 }), 120000);
});

// ── formatBadgeCount ──────────────────────────────────────────────────────────

test('formatBadgeCount: значения в пределах max возвращаются как есть', () => {
  assert.equal(formatBadgeCount(0), '0');
  assert.equal(formatBadgeCount(99), '99');
});

test('formatBadgeCount: превышение max клампится к "99+"', () => {
  assert.equal(formatBadgeCount(100), '99+');
  assert.equal(formatBadgeCount(150), '99+');
});

test('formatBadgeCount: отрицательное → "0", дробное усечается, NaN → "0"', () => {
  assert.equal(formatBadgeCount(-3), '0');
  assert.equal(formatBadgeCount(5.7), '5');
  assert.equal(formatBadgeCount(NaN), '0');
});
