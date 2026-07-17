/**
 * Контракт EditableSurface — seam для редактируемого текстового элемента.
 * Паттерн скопирован с доказанного seam'а SearchTarget (act-search-engine.js:65-103);
 * НЕ сливать с TextBlockSearchTarget — это разные seam'ы (редактирование vs поиск).
 */

import { textBlockManager } from './textblock-core.js';

/** @typedef {{id:string,kind:string,rich:boolean,element:HTMLElement,
 *   getContent():string,setContent:(html:string)=>void,commit:()=>void,persist:()=>void}} EditableSurface */

export class TextBlockSurface {
  constructor(editor, manager = textBlockManager) {
    this._editor = editor; this._manager = manager;
    this.id = editor && editor.dataset ? editor.dataset.textBlockId : null;
    this.kind = 'textblock'; this.rich = true;
  }
  get element() { return this._editor; }
  getContent() { const tb = this._manager.getTextBlock(this.id); return tb ? tb.content : ''; }
  setContent(html) { this._manager.saveContent(this.id, html); }
  commit() { this._manager.flushActiveEditor(); }
  persist() { this._manager.finalizeEdit(this._editor); }
}

window.TextBlockSurface = TextBlockSurface;
