"""Канонические имена ChatTool и client-actions чата.

Single source of truth для строковых идентификаторов, которые иначе разбросаны
по orchestrator, action_handlers, button_translator и whitelist в blocks.py.
Если переименование нужно — меняй ТОЛЬКО здесь.

Имена клиентских actions дублируются в
``static/js/shared/chat/chat-client-actions.js``: фронт не импортирует Python,
синхронизируй вручную.
"""
from __future__ import annotations

from typing import Final

# ── Имена ChatTool (атрибут name= в ChatTool(...)) ───────────────────────────

TOOL_FORWARD_TO_KNOWLEDGE_AGENT: Final[str] = "chat.forward_to_knowledge_agent"
TOOL_NOTIFY: Final[str] = "chat.notify"
TOOL_LIST_PAGES: Final[str] = "chat.list_pages"
TOOL_OPEN_ACT_PAGE: Final[str] = "acts.open_act_page"
TOOL_CREATE_ACT: Final[str] = "acts.create_act"
TOOL_ADD_PROCESSES_TO_ACT: Final[str] = "acts.add_processes_to_act"
TOOL_OPEN_ADMIN_PANEL: Final[str] = "admin.open_admin_panel"
TOOL_OPEN_CK_FIN_RES_PAGE: Final[str] = "ck_fin_res.open_ck_fin_res_page"
TOOL_OPEN_CK_CLIENT_EXP_PAGE: Final[str] = "ck_client_exp.open_ck_client_exp_page"


# ── Имена client-actions (поле action в ClientActionBlock) ───────────────────

ACTION_OPEN_URL: Final[str] = "open_url"
ACTION_NOTIFY: Final[str] = "notify"
ACTION_TRIGGER_SDK: Final[str] = "trigger_sdk"


# ── Имена событий audit-лога жизненного цикла чата ───────────────────────────
# Используются как значение колонки `action` в таблице chat_audit_log.

AUDIT_CONVERSATION_CREATED: Final[str] = "conversation_created"
AUDIT_CONVERSATION_DELETED: Final[str] = "conversation_deleted"
AUDIT_MESSAGE_SENT: Final[str] = "message_sent"
AUDIT_FILE_UPLOADED: Final[str] = "file_uploaded"
AUDIT_FILE_DELETED: Final[str] = "file_deleted"
# Обратная связь по сообщению ассистента (лайк/дизлайк):
AUDIT_FEEDBACK_SUBMITTED: Final[str] = "feedback_submitted"
AUDIT_FEEDBACK_CLEARED: Final[str] = "feedback_cleared"
