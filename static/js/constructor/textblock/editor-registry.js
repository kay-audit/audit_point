/**
 * Реестр активной поверхности редактора + политика тулбара по типу поверхности.
 * Лист графа импортов: без app-импортов (не тянет textblock-core и пр.).
 *
 * capsuleLifecycle — капсульный жизненный цикл (heal-observer, гейт сносок,
 * copy/cut/paste/drop, tooltip) ведёт ИМЕННО EditorController. Текстблоки держат
 * капсулы своим путём (handleEditorFocus) и через EditorController не монтируются
 * → false. Будущий kind='cell' включит lifecycle одной строкой политики
 * (capsuleLifecycle:true), без правки контроллера.
 */
export const SURFACE_POLICY = {
  textblock:      { footnotes: true,  fontSize: true, align: true, links: true, lists: true, findReplace: true, improveText: true, capsuleLifecycle: false },
  violationField: { footnotes: false, fontSize: true, align: true, links: true, lists: true, findReplace: true, improveText: true, capsuleLifecycle: true },
  // cell — Фаза 2
};

export const EditorRegistry = {
  _active: null,
  setActive(surface) { this._active = surface; },
  getActive() { return this._active; },
  clear() { this._active = null; },
  // On-demand флаш активной поверхности перед сериализацией. V20: единый путь
  // сброса зависшей правки rich-поля нарушения для persistence-воронок —
  // вызывается из StorageManager._flushPendingEdits. Аналог flushActiveEditor
  // для текстблока, но по контракту EditableSurface (любой kind).
  flushActive() { this._active?.commit?.(); },
};

window.EditorRegistry = EditorRegistry;
