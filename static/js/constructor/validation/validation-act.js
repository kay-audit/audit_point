/**
 * Валидация структуры и состава акта
 *
 * Проверяет базовые бизнес-правила на уровне акта как документа.
 */
import { AppState } from '../state/state-core.js';
import { TreeUtils } from '../tree/tree-utils.js';
import { ValidationCore } from './validation-core.js';

export const ValidationAct = {
    /**
     * Проверяет наличие хотя бы одного раздела в структуре акта
     * @returns {Object} Результат валидации с полями valid, message, isWarning
     */
    validateStructure() {
        if (!AppState.treeData?.children) {
            return ValidationCore.failure('Структура акта пуста');
        }

        const validation = ValidationCore.validateArrayNotEmpty(
            AppState.treeData.children,
            'Разделы акта'
        );

        if (!validation.valid) {
            return ValidationCore.failure('Добавьте хотя бы один раздел в акт');
        }

        // Базовые секции 1-6 (1-5 + обязательный пункт Process Mining) обязаны
        // присутствовать и быть protected/неудаляемыми. Защищает от случаев,
        // когда seed/миграция/DevTools-манипуляция оставила акт без корректной
        // базовой структуры.
        const expectedIds = ['1', '2', '3', '4', '5', '6'];
        const rootChildren = AppState.treeData.children;
        const missing = expectedIds.filter(
            id => !rootChildren.some(child => child.id === id)
        );
        if (missing.length > 0) {
            return ValidationCore.failure(
                `Базовая структура повреждена: отсутствуют разделы ${missing.join(', ')}`
            );
        }
        const unprotected = expectedIds.filter(id => {
            const child = rootChildren.find(c => c.id === id);
            return !child.protected || child.deletable !== false;
        });
        if (unprotected.length > 0) {
            return ValidationCore.failure(
                `Базовая структура повреждена: разделы ${unprotected.join(', ')} не защищены от изменения`
            );
        }

        return ValidationCore.success();
    },

    /**
     * Проверяет наличие назначенных ТБ для leaf-узлов раздела 5
     * @returns {Object} Результат валидации с полями valid, message, isWarning
     */
    validateTb() {
        // Находим раздел 5 по id (как validateStructure): поиск по number
        // молча пропускал проверку, пока нумерация не сгенерирована
        const section5 = (AppState.treeData?.children || []).find(
            c => c.id === '5'
        );
        if (!section5?.children?.length) return ValidationCore.success();

        // Собираем leaf-узлы без назначенного ТБ
        const missingTb = [];
        const collectMissing = (node) => {
            if (TreeUtils.isUnderSection5(node)) {
                if (TreeUtils.isTbLeaf(node) && (!node.tb || node.tb.length === 0)) {
                    const name = node.number ? `${node.number}. ${node.label}` : node.label;
                    missingTb.push(`- ${name}`);
                }
            }
            (node.children || []).forEach(c => collectMissing(c));
        };
        section5.children.forEach(c => collectMissing(c));

        if (missingTb.length > 0) {
            return ValidationCore.warning(
                `Не назначен ТБ для пунктов:\n${missingTb.join('\n')}\nВы можете продолжить сохранение.`
            );
        }

        return ValidationCore.success();
    }
};

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ValidationAct = ValidationAct;
