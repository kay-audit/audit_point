/**
 * Блок подписи в конце листа — зеркало build_signature (docx/builders/signature.py).
 *
 * В DOCX подпись печатается БЕЗУСЛОВНО (DocxFormatter.format зовёт билдер без
 * условий), а превью её не рисовало вовсе — лист обрывался на последнем узле
 * дерева. Здесь пинится содержательная часть: кого считать руководителем, как
 * сокращается ФИО и что выводится, когда руководителя нет. Геометрия (правый
 * tab-stop → space-between, отступ сверху) живёт в CSS и проверяется
 * tests/playwright/specs/32-document-parity.spec.ts.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewSignatureRenderer } from '../../static/js/constructor/preview/preview-signature-renderer.js';

/** Текст двух узлов блока: [метка, ФИО]. */
function render(metadata) {
  const root = PreviewSignatureRenderer.create(metadata);
  if (!root) return null;
  return {
    className: root.className,
    parts: root.children.map(child => child.textContent),
  };
}

test('метаданных нет — блок не рисуется (мягкая деградация)', () => {
  assert.equal(PreviewSignatureRenderer.create(null), null);
  assert.equal(PreviewSignatureRenderer.create(undefined), null);
});

test('ФИО руководителя сокращается до «Фамилия И.О.»', () => {
  const out = render({
    audit_team: [
      { role: 'Участник', full_name: 'Сидоров Сидор Сидорович' },
      { role: 'Руководитель', full_name: 'Иванов Иван Иванович' },
    ],
  });
  assert.equal(out.className, 'preview-signature');
  assert.deepEqual(out.parts, ['Руководитель аудиторской проверки', 'Иванов И.И.']);
});

test('два слова дают одну инициалу, одно слово остаётся как есть', () => {
  assert.equal(
    render({ audit_team: [{ role: 'Руководитель', full_name: 'Иванов Иван' }] }).parts[1],
    'Иванов И.',
  );
  assert.equal(
    render({ audit_team: [{ role: 'Руководитель', full_name: 'Иванов' }] }).parts[1],
    'Иванов',
  );
});

test('руководителя в составе нет — прочерк-заглушка, как в билдере', () => {
  const noLeader = render({ audit_team: [{ role: 'Куратор', full_name: 'Петров Пётр Петрович' }] });
  assert.equal(noLeader.parts[1], '_______________');
  // Пустой и отсутствующий состав — то же самое: метаданные есть, блок нужен.
  assert.equal(render({ audit_team: [] }).parts[1], '_______________');
  assert.equal(render({}).parts[1], '_______________');
});

test('первый по порядку руководитель и есть подписант', () => {
  const out = render({
    audit_team: [
      { role: 'Руководитель', full_name: 'Первый Пётр Петрович' },
      { role: 'Руководитель', full_name: 'Второй Семён Семёнович' },
    ],
  });
  assert.equal(out.parts[1], 'Первый П.П.');
});
