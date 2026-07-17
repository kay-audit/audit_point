/**
 * Реестр активной поверхности редактора + политика тулбара по типу поверхности.
 * Лист графа импортов: без app-импортов (не тянет textblock-core и пр.).
 */
export const SURFACE_POLICY = {
  textblock:      { footnotes: true,  fontSize: true, align: true, links: true, findReplace: true, improveText: true },
  violationField: { footnotes: false, fontSize: true, align: true, links: true, findReplace: true, improveText: true },
  // cell — Фаза 2
};

export const EditorRegistry = {
  _active: null,
  setActive(surface) { this._active = surface; },
  getActive() { return this._active; },
  clear() { this._active = null; },
  flushActive() { this._active?.commit?.(); },
};

window.EditorRegistry = EditorRegistry;
