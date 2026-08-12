/**
 * Инициализация ViolationManager
 * Создание глобального экземпляра после загрузки всех модулей
 */

import { ViolationManager } from './violation-core.js';
// Расширения прототипа должны быть применены ДО инстанцирования и initialize():
// setupPasteHandler живёт в violation-paste.js (сброс активной зоны по ESC —
// через EscapeStack в violation-core.js), остальные
// методы — в соседних модулях. Импорт здесь делает модуль самодостаточным
// при импорте violationManager из любого места (не только из entry).
import './violation-mutations.js';
import './violation-field-surface.js';
import './violation-paste.js';
import './violation-blocks.js';
import './violation-rendering.js';
import './violation-drag-drop.js';
import './violation-file-upload.js';
// diff-аудит правок нарушений (#17): регистрирует pre-flush hook в ChangelogTracker.
import './violation-audit.js';

// Создаем глобальный экземпляр менеджера нарушений
export const violationManager = new ViolationManager();

// Инициализируем обработчики после загрузки всех расширений
violationManager.initialize();

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.violationManager = violationManager;
