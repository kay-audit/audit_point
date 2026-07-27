"""
Оркестратор agent loop для AI-чата.

Управляет циклом: LLM → tool calls → результат → LLM → ... → финальный ответ.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from app.core.chat.block_id_generator import BlockIdGenerator
from app.core.chat.tools import (
    get_openai_tools,
    get_tools_by_domain,
)
from app.core.settings_registry import get as get_domain_settings
from app.domains.chat.services.circuit_breaker import get_breaker
from app.domains.chat.services.conversation_service import ConversationService
from app.domains.chat.services.llm_client import (
    build_fallback_client,
    build_llm_client,
)
from app.domains.chat.services.message_service import MessageService
from app.domains.chat.services.orchestrator_helpers import (
    BASE_SYSTEM_PROMPT,
    convert_param as _convert_param,
    safe_args as _safe_args,
)

# Re-export для обратной совместимости с тестами, которые импортируют
# ``_convert_param`` / ``_safe_args`` из этого модуля (исторически они жили
# здесь module-level). Сами функции переехали в ``orchestrator_helpers``.
__all__ = ["Orchestrator", "_convert_param", "_safe_args"]
from app.domains.chat.services.retry import retry_on_transient
from app.domains.chat.settings import ChatDomainSettings

logger = logging.getLogger("audit_workstation.domains.chat.orchestrator")


class Orchestrator:
    """Оркестратор agent loop для AI-чата."""

    def __init__(
        self,
        *,
        msg_service: MessageService,
        conv_service: ConversationService,
        settings: ChatDomainSettings | None = None,
    ):
        self.msg_service = msg_service
        self.conv_service = conv_service
        self.settings = settings or get_domain_settings("chat", ChatDomainSettings)
        self._retry_call = retry_on_transient(
            on_429=self.settings.retry.on_429,
            on_5xx=self.settings.retry.on_5xx,
            max_attempts=self.settings.retry.max_attempts,
            backoff_base=self.settings.retry.backoff_base_sec,
            connect_max_attempts=self.settings.retry.connect_max_attempts,
        )
        # Контекст для метрик: устанавливается в run перед
        # agent loop и читается в _execute_tool_call. Так избегаем менять
        # сигнатуру _execute_tool_call и передачу параметров через все
        # 5 callsite'ов внутри agent loop.
        self._current_conversation_id: str | None = None
        self._current_user_id: str | None = None
        self._current_act_id: int | None = None
        self._current_selected_node_id: str | None = None

    async def _completions_create(self, client, **kwargs):
        """Обёрнутый retry'ем вызов chat.completions.create."""
        model = kwargs.get("model", self.settings.model)
        stream = kwargs.get("stream", False)
        msg_count = len(kwargs.get("messages") or [])
        logger.info(
            "LLM вызов: профиль=%s, модель=%s, история=%d сообщений, "
            "stream=%s",
            self.settings.profile, model, msg_count, stream,
        )
        logger.debug(
            "LLM запрос: модель=%s, max_tokens=%s, stream=%s, "
            "temperature=%s",
            model, kwargs.get("max_tokens"), stream,
            kwargs.get("temperature"),
        )
        started = time.monotonic()
        try:
            wrapped = self._retry_call(client.chat.completions.create)
            result = await wrapped(**kwargs)
        except Exception:
            logger.exception(
                "LLM вызов завершился ошибкой после ретраев: модель=%s",
                model,
            )
            raise
        if not stream:
            usage = getattr(result, "usage", None)
            tokens_in = getattr(usage, "prompt_tokens", None) if usage else None
            tokens_out = (
                getattr(usage, "completion_tokens", None) if usage else None
            )
            finish_reason = None
            if getattr(result, "choices", None):
                finish_reason = getattr(result.choices[0], "finish_reason", None)
            logger.info(
                "LLM ответ получен за %.2fс: tokens_in=%s, tokens_out=%s, "
                "finish=%s",
                time.monotonic() - started, tokens_in, tokens_out,
                finish_reason,
            )
        return result

    async def _build_system_messages(
        self, domains: list[str] | None,
        selected_node_id: str | None = None,
    ) -> list[dict[str, str]]:
        """Собирает системный промпт: базовый + правило small-talk + доменные
        + контекст текущего пользователя (ФИО/роль/доступные акты).

        Контекст пользователя подгружается отдельным helper'ом из acts-домена
        (load_user_context): LLM узнаёт, кто с ним говорит, и может отвечать
        на «открой мой последний акт», «какие у меня проекты», понимать
        «я», «руководитель я» и т.п. без отдельного tool-вызова.
        """
        smalltalk_line = (
            "\n\nДля small-talk (приветствия, вопросы о тебе) давай "
            "локальный краткий текстовый ответ без вызова инструментов."
            if self.settings.smalltalk_mode == "local"
            else "\n\nДля small-talk также вызывай chat.forward_to_knowledge_agent."
        )
        base_prompt = BASE_SYSTEM_PROMPT + smalltalk_line

        # Контекст пользователя. Грузится всегда, даже для small-talk —
        # чтобы LLM знала, кто с ней говорит, при первом же сообщении.
        # Грузится только если есть username (т.е. мы в HTTP-контексте).
        if self._current_user_id:
            try:
                from app.domains.acts.integrations.chat_context import (
                    load_user_context,
                    format_user_context_for_prompt,
                )
                user_ctx = await load_user_context(
                    self._current_user_id,
                    current_act_id=self._current_act_id,
                )
                # Если есть selected_node_id (пользователь кликнул правой
                # кнопкой и выбрал «AI-ассистент» в контекстном меню) — это
                # узел дерева акта, на котором он работает прямо сейчас.
                # Сохраняем в ctx, чтобы formatter добавил строку «выбран
                # пользователем».
                if selected_node_id is not None:
                    user_ctx["selected_node_id"] = selected_node_id
                # По умолчанию (если не передан selected_node_id) берём
                # selectedNode из AppState фронта, если он вдруг прокинут —
                # на бэке его нет, используем сохранённый в self.
                elif getattr(self, "_current_selected_node_id", None):
                    user_ctx["selected_node_id"] = (
                        self._current_selected_node_id
                    )
                base_prompt += (
                    "\n\n" + await format_user_context_for_prompt(user_ctx)
                )
            except Exception as exc:
                logger.warning(
                    "Не удалось загрузить контекст пользователя %s: %s",
                    self._current_user_id, exc,
                )

        if domains:
            from app.core.domain_registry import get_domain
            domain_prompts = []
            for domain_name in domains:
                d = get_domain(domain_name)
                if d and d.chat_system_prompt:
                    domain_prompts.append(d.chat_system_prompt)
            if domain_prompts:
                base_prompt = base_prompt + "\n\n" + "\n\n".join(domain_prompts)

        # Раздел "Доступные страницы" — список NavItem всех известных доменов
        from app.core.domain_registry import get_all_domains
        available_pages: list[str] = []
        for d in get_all_domains():
            for nav in d.nav_items:
                if not nav.url:
                    continue
                line = f"- {nav.label} ({nav.url})"
                if nav.description:
                    line += f" — {nav.description}"
                available_pages.append(line)
        if available_pages:
            base_prompt += "\n\n## Доступные страницы\n" + "\n".join(
                available_pages,
            )

        base_prompt += (
            "\n\n## Открытие страниц\n"
            "- Когда пользователь спрашивает что ты умеешь, какие функции "
            "доступны, что есть в системе — вызови инструмент "
            "chat.list_pages. Не пиши свой текст перед или после — "
            "инструмент сам выдаст описание и кнопки.\n"
            "- Когда пользователь просит открыть конкретную страницу из "
            "списка — вызови соответствующий инструмент "
            "`<домен>.open_<...>` (например admin.open_admin_panel).\n"
            "- Для открытия конкретного акта по КМ-номеру или СЗ — вызови "
            "acts.open_act_page.\n"
            "\n## Создание актов\n"
            "- Когда пользователь говорит «создай акт», «заведи проверку», "
            "«оформи новый акт», «нужен новый КМ-…» и т.п. — вызови "
            "acts.create_act и собирай данные через диалог: задай уточняющие "
            "вопросы по недостающим обязательным полям, инструмент сам "
            "сообщит, чего не хватает. Когда всё будет — инструмент вернёт "
            "client_action с переходом на новый акт.\n"
            "- Создавать акты могут только пользователи с ролями Куратор, "
            "Руководитель или Админ. Если инструмент сообщает об отказе прав — "
            "объясни пользователю и предложи обратиться к администратору.\n"
        )

        return [{"role": "system", "content": base_prompt}]

    def _get_tools(self, domains: list[str] | None) -> list[dict]:
        """Возвращает tools в OpenAI-формате, опционально фильтруя по доменам."""
        if domains:
            tools_list = []
            for domain_name in domains:
                tools_list.extend(get_tools_by_domain(domain_name))
            return [t.to_openai_tool() for t in tools_list]
        return get_openai_tools()

    @staticmethod
    def _format_block_full(block: dict) -> str | None:
        """Конвертирует блок контента в текст (полный режим)."""
        block_type = block.get("type", "")
        if block_type == "text":
            return block.get("content", "") or None
        if block_type == "code":
            lang = block.get("language", "")
            return f"```{lang}\n{block.get('content', '')}\n```"
        if block_type == "file":
            fname = block.get("filename", "файл")
            size = block.get("size")
            if size:
                try:
                    size_mb = int(size) / (1024 * 1024)
                    size_str = f"{size_mb:.1f} МБ"
                except (TypeError, ValueError):
                    size_str = str(size)
            else:
                size_str = ""
            return f"[Прикреплён файл: {fname}" + (f", {size_str}" if size_str else "") + "]"
        if block_type == "image":
            fname = block.get("filename", "изображение")
            return f"[Прикреплено изображение: {fname}]"
        return None

    @staticmethod
    def _format_block_shallow(block: dict) -> str | None:
        """Конвертирует блок контента в текст (shallow режим — без бинарных данных).

        file/image блоки заменяются на placeholder без base64/бинарного контента.
        """
        block_type = block.get("type", "")
        if block_type == "text":
            return block.get("content", "") or None
        if block_type == "code":
            lang = block.get("language", "")
            return f"```{lang}\n{block.get('content', '')}\n```"
        if block_type in ("file", "image"):
            fname = block.get("filename", "файл" if block_type == "file" else "изображение")
            size = block.get("size")
            if size:
                try:
                    size_mb = int(size) / (1024 * 1024)
                    size_str = f"{size_mb:.1f} МБ"
                except (TypeError, ValueError):
                    size_str = str(size)
            else:
                size_str = ""
            label = "файл" if block_type == "file" else "изображение"
            parts = [fname]
            if size_str:
                parts.append(size_str)
            parts.append("не загружен в этом ходу")
            return f"[{label}: {', '.join(parts)}]"
        return None

    async def _get_history_messages(
        self, conversation_id: str,
    ) -> list[dict[str, str]]:
        """
        Загружает историю из БД и конвертирует в формат OpenAI messages.

        Извлекает текст из блоков контента:
        - text → текст
        - code → markdown fenced code block
        - file/image → placeholder (только для сообщений вне ``history_full_context_depth``)

        Блоки reasoning и error сохранены в истории только для отображения
        в UI; в контекст модели они не попадают (чтобы не засорять контекст
        служебной информацией).

        Lazy-loading: последние ``history_full_context_depth`` сообщений
        передаются с полным контентом; более старые — с placeholder'ами
        вместо file/image-блоков, чтобы не расходовать RAM на base64.
        """
        history = await self.msg_service.load_history_for_llm(conversation_id)

        # Ограничиваем историю по настройкам
        if len(history) > self.settings.max_history_length:
            history = history[-self.settings.max_history_length:]

        depth = self.settings.history_full_context_depth
        cutoff = max(0, len(history) - depth)

        messages: list[dict[str, str]] = []

        for idx, msg in enumerate(history):
            role = msg.get("role", "user")
            content_blocks = msg.get("content", [])
            full_mode = idx >= cutoff  # True — полный контент, False — shallow

            # Собираем текст из блоков
            text_parts: list[str] = []
            if isinstance(content_blocks, list):
                for block in content_blocks:
                    if not isinstance(block, dict):
                        continue
                    if full_mode:
                        part = self._format_block_full(block)
                    else:
                        part = self._format_block_shallow(block)
                    if part:
                        text_parts.append(part)
            elif isinstance(content_blocks, str):
                text_parts.append(content_blocks)

            content = "\n".join(text_parts)
            if content:
                messages.append({"role": role, "content": content})

        return messages

    async def _build_user_content(
        self,
        user_message: str,
        file_blocks: list[dict] | None,
        conversation_id: str | None = None,
    ) -> str:
        """Строит содержимое user-сообщения: текст + извлечённый контент файлов."""
        if not file_blocks:
            return user_message

        from app.db.connection import get_db
        from app.domains.chat.repositories.file_repository import FileRepository
        from app.domains.chat.services.file_extraction import extract_text_async

        parts = [user_message]
        async with get_db() as conn:
            file_repo = FileRepository(conn)
            for fb in file_blocks:
                file_id = fb.get("file_id")
                if not file_id:
                    continue
                # Получаем данные через репозиторий с проверкой conversation_id
                if conversation_id:
                    row = await file_repo.get_file_content(
                        file_id=file_id,
                        conversation_id=conversation_id,
                    )
                else:
                    row = await file_repo.get_file_content(
                        file_id=file_id,
                        conversation_id="",
                    )
                if not row:
                    continue
                text = await extract_text_async(
                    row["file_data"], row["mime_type"], row["filename"],
                )
                parts.append(f"\n--- Файл: {row['filename']} ---\n{text}")

        return "\n".join(parts)

    def _get_openai_client(self):
        """Возвращает AsyncOpenAI клиент согласно профильным настройкам."""
        return build_llm_client(self.settings)

    def _get_fallback_client(self):
        """Возвращает fallback-клиент или None, если fallback не настроен."""
        return build_fallback_client(self.settings)

    def _has_fallback(self) -> bool:
        """True если все необходимые fallback-настройки заданы."""
        return (
            self.settings.fallback_profile is not None
            and bool(self.settings.fallback_api_base)
            and self.settings.fallback_api_key is not None
            and bool(self.settings.fallback_api_key.get_secret_value())
        )

    def _fallback_is_gigachat(self) -> bool:
        """True если fallback-профиль — gigachat (нельзя streaming)."""
        return self.settings.fallback_profile == "gigachat"

    @staticmethod
    def _is_provider_failure(exc: BaseException) -> bool:
        """Считается ли исключение сбоем primary-провайдера.

        Условия (true → инкремент circuit breaker, может тригерить fallback):
          - openai.APIConnectionError / APITimeoutError (транспорт)
          - asyncio.TimeoutError (наш request_timeout)
          - openai.APIStatusError со status_code >= 500

        4xx (auth, rate-limit, validation) — это клиентские ошибки,
        НЕ считаются сбоем провайдера. Логика retry на 429 уже есть
        в retry_on_transient; здесь её дублировать нельзя.
        """
        try:
            from openai import (
                APIConnectionError,
                APIStatusError,
                APITimeoutError,
            )
        except ImportError:  # pragma: no cover
            return False

        if isinstance(exc, APITimeoutError):
            return True
        if isinstance(exc, APIConnectionError):
            return True
        if isinstance(exc, asyncio.TimeoutError):
            return True
        if isinstance(exc, APIStatusError):
            code = getattr(exc, "status_code", None)
            return code is not None and 500 <= code < 600
        return False

    def _get_circuit_breaker(self):
        """Возвращает singleton-breaker с актуальной конфигурацией.

        ``external_recovery`` включается, когда настроен fallback и активен
        фоновый health-probe: тогда breaker не делает таймерный переход
        open→half_open (живой запрос не становится пробой), а восстановление
        primary берёт на себя ``LLMHealthProbe`` через ``probe_succeeded()``.
        """
        return get_breaker(
            failure_threshold=self.settings.circuit_breaker_failure_threshold,
            recovery_timeout_sec=(
                self.settings.circuit_breaker_recovery_timeout_sec
            ),
            external_recovery=(
                self.settings.health_probe.enabled and self._has_fallback()
            ),
        )

    async def _llm_call_with_fallback(
        self,
        client,
        *,
        force_non_streaming: bool = False,
        **kwargs,
    ) -> tuple[Any, bool, Any]:
        """Тонкий wrapper: делегирует в ``llm_call.call_llm_with_fallback``.

        Pure-функция получает ссылку на ``self`` и зовёт circuit-breaker,
        fallback-клиента и ``_completions_create`` через методы класса —
        существующие patch'и тестов продолжают работать.
        """
        from app.domains.chat.services.llm_call import call_llm_with_fallback
        return await call_llm_with_fallback(
            self, client,
            force_non_streaming=force_non_streaming,
            **kwargs,
        )

    def _adjust_kwargs_for_fallback(
        self, kwargs: dict, *, force_non_streaming: bool,
    ) -> dict:
        """Перестраивает kwargs LLM-вызова под fallback-провайдера.

        Подменяет model на fallback_model (если задан). Если fallback —
        GigaChat и ``force_non_streaming`` True (или kwargs содержит
        stream=True) — выключает streaming, иначе GigaChat-proxy отдаст
        422 EventException.
        """
        out = dict(kwargs)
        if self.settings.fallback_model:
            out["model"] = self.settings.fallback_model
        if self._fallback_is_gigachat():
            if force_non_streaming or out.get("stream"):
                out.pop("stream", None)
        return out

    async def _save_assistant_message(
        self,
        *,
        conversation_id: str,
        content_blocks: list[dict],
        token_usage: dict | None,
        message_id: str,
    ) -> None:
        """Сохраняет сообщение ассистента с отдельным соединением из пула.

        Оркестратор работает в рамках обработки POST и может пережить часть
        dependency-соединений, поэтому для сохранения берём свежее соединение.

        ``message_id`` обязан совпадать с id, который оркестратор использовал
        в ``_parse_client_action_result`` для построения детерминированного
        ``block_id``. Иначе после reload фронт увидит «новый» message id и
        повторно исполнит уже отработанные client_action-блоки.
        """
        from app.db.connection import get_db
        from app.domains.chat.repositories.conversation_repository import (
            ConversationRepository,
        )
        from app.domains.chat.repositories.message_repository import (
            MessageRepository,
        )

        async with get_db() as conn:
            msg_service = MessageService(
                msg_repo=MessageRepository(conn),
                conv_repo=ConversationRepository(conn),
                settings=self.settings,
            )
            await msg_service.save_assistant_message(
                conversation_id=conversation_id,
                content=content_blocks,
                model=self.settings.model,
                token_usage=token_usage if token_usage else None,
                message_id=message_id,
            )

    def _parse_client_action_result(
        self,
        raw: str,
        *,
        block_id_gen: BlockIdGenerator,
    ) -> dict | None:
        """Если result tool'а — JSON-блок client_action, возвращает dict.

        Иначе возвращает None (это обычный текстовый результат tool'а).

        ``block_id`` всегда переписывается на детерминированный
        ``f"{message_id}:client_action:{index}"`` через ``block_id_gen``
        (даже если handler выставил свой uuid): это гарантирует, что при
        перезагрузке вкладки и реплее истории фронт получит ТОТ ЖЕ id и
        пропустит повторное исполнение через
        ``sessionStorage['chat:executedActions']``.
        """
        try:
            obj = json.loads(raw)
        except (ValueError, TypeError):
            return None
        if not isinstance(obj, dict):
            return None
        if obj.get("type") != "client_action":
            return None
        # Минимальная валидация
        if "action" not in obj:
            return None
        obj["block_id"] = block_id_gen.next("client_action")
        return obj

    def _parse_buttons_result(self, raw: str) -> dict | None:
        """Если result tool'а — JSON-блок buttons, возвращает dict.

        Иначе None.
        """
        try:
            obj = json.loads(raw)
        except (ValueError, TypeError):
            return None
        if not isinstance(obj, dict):
            return None
        if obj.get("type") != "buttons":
            return None
        if not isinstance(obj.get("buttons"), list):
            return None
        return obj

    def _parse_blocks_list_result(
        self,
        raw: str,
        *,
        block_id_gen: BlockIdGenerator,
    ) -> list[dict] | None:
        """Если result tool'а — JSON-список блоков, возвращает список dict.

        Иначе None.

        Для каждого client_action внутри списка ``block_id`` переписывается
        детерминированно через ``block_id_gen``. См. doc-string
        :meth:`_parse_client_action_result`.
        """
        try:
            obj = json.loads(raw)
        except (ValueError, TypeError):
            return None
        if not isinstance(obj, list):
            return None
        if not all(isinstance(b, dict) and "type" in b for b in obj):
            return None
        for b in obj:
            if b.get("type") != "client_action":
                continue
            b["block_id"] = block_id_gen.next("client_action")
        return obj

    async def _translate_buttons(self, buttons: list[dict]) -> list[dict]:
        """Транслирует серверные action_id в клиентские действия.

        Делегирует общему хелперу ``button_translator.translate_buttons``,
        чтобы оркестратор, раннер и resume-эндпоинт использовали один и
        тот же код.
        """
        from app.domains.chat.services.button_translator import translate_buttons
        return await translate_buttons(buttons)

    async def _record_tool_metric(
        self,
        *,
        tool_name: str,
        status: str,
        latency_ms: int,
        error_message: str | None = None,
    ) -> None:
        """Пишет одну метрику выполнения tool'а через DI-фабрику.

        Сбой записи метрик НЕ должен ломать tool-loop: исключения
        проглатываются, ошибка логируется warning'ом.
        """
        try:
            # Lazy-import: deps зависит от services, импорт на module-level
            # создал бы цикл и завязал бы orchestrator на DI-инфраструктуру.
            from app.domains.chat.deps import (
                get_tool_metrics_batcher,
                get_tool_metrics_repository,
            )
            from app.domains.chat.repositories.chat_tool_metrics_repository import (
                ChatToolMetricRecord,
            )

            batcher = get_tool_metrics_batcher()
            if batcher is not None:
                await batcher.add(
                    ChatToolMetricRecord(
                        tool_name=tool_name,
                        status=status,
                        latency_ms=int(latency_ms),
                        username=self._current_user_id,
                        conversation_id=self._current_conversation_id,
                        error_message=error_message,
                    )
                )
                return
            # Fallback: батчер не инициализирован (тесты, dev без lifespan).
            agen = get_tool_metrics_repository()
            repo = await agen.__anext__()
            try:
                await repo.record(
                    tool_name=tool_name,
                    status=status,
                    latency_ms=latency_ms,
                    username=self._current_user_id,
                    conversation_id=self._current_conversation_id,
                    error_message=error_message,
                )
            finally:
                # Закрываем async-generator, освобождая соединение в пул.
                try:
                    await agen.aclose()
                except Exception:
                    pass
        except Exception:
            logger.warning(
                "Не удалось записать tool-метрику",
                extra={"tool_name": tool_name},
                exc_info=True,
            )

    async def _execute_tool_call(
        self, tool_name: str, arguments: dict,
    ) -> str:
        """Тонкий wrapper над ``tool_executor.execute_tool_call``.

        Сохранён как метод класса, потому что тесты массово зовут
        ``orchestrator._execute_tool_call(...)`` напрямую.
        """
        from app.domains.chat.services.tool_executor import execute_tool_call
        return await execute_tool_call(self, tool_name, arguments)

    async def run(
        self,
        *,
        conversation_id: str,
        user_message: str,
        message_id: str,
        domains: list[str] | None = None,
        file_blocks: list[dict] | None = None,
        user_id: str | None = None,
        agent_mode: str = "off",
        current_act_id: int | None = None,
        selected_node_id: str | None = None,
    ) -> dict[str, Any]:
        """Полный (не стриминговый) agent loop.

        Тонкий wrapper над ``agent_loop.run_agent_loop`` — фиксирует контекст
        для метрик (``_current_conversation_id`` / ``_current_user_id``,
        читается в ``_record_tool_metric``) и делегирует модульной функции.

        ``message_id`` обязателен и должен быть тем же id, что попадёт в БД
        через ``_save_assistant_message``: на нём строится детерминированный
        ``block_id`` ClientActionBlock (``f"{message_id}:client_action:{i}"``).

        ``agent_mode`` управляет поведением forward-тула:
        - "adaptive" — forward-тул доступен LLM; при вызове форвард идёт через
          bus-канал (AgentChannelService), ответ дозаполняется поллером;
        - "off" и любое другое — forward-тул скрыт от LLM.

        Возвращает dict с полями: response, sources, model, token_usage; на
        ошибку — dict с ``status="error"``; при форварде — дополнительно
        ``forwarded=True``.
        """
        from app.domains.chat.services.agent_loop import run_agent_loop

        # Фиксируем контекст для метрик; читается из _execute_tool_call.
        self._current_conversation_id = conversation_id
        self._current_user_id = user_id
        self._current_act_id = current_act_id
        self._current_selected_node_id = selected_node_id

        return await run_agent_loop(
            self,
            conversation_id=conversation_id,
            user_message=user_message,
            message_id=message_id,
            domains=domains,
            file_blocks=file_blocks,
            user_id=user_id,
            current_act_id=current_act_id,
            selected_node_id=selected_node_id,
        )

    def _fallback_response(self, user_message: str) -> dict[str, Any]:
        """Заглушка при отсутствии настроек LLM API."""
        from app.core.chat.tools import get_all_tools

        tools = get_all_tools()
        response_text = f'Вы написали: "{user_message}"'

        if tools:
            response_text += (
                f"\n\nДоступно инструментов: {len(tools)}. "
                "Для полноценной работы AI-ассистента настройте "
                "CHAT__API_BASE и CHAT__API_KEY в .env."
            )
        else:
            response_text += "\n\nИнструменты не зарегистрированы."

        response_text += (
            "\n\nAI-ассистент работает в режиме заглушки. "
            "Настройте подключение к LLM API для полноценных ответов."
        )

        return {"response": response_text, "sources": [], "status": "fallback"}
