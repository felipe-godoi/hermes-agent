"""End-to-end-ish coverage for delegated WhatsApp conversations.

Exercises the whatsapp_delegation plugin's real pre_gateway_dispatch /
pre_tool_call callbacks and the WhatsAppAdapter.toolsets_for_source wiring
against gateway._handle_message, using the same bare-runner fixture pattern
as tests/gateway/test_pre_gateway_dispatch.py.

Covers the 7 scenarios called out in the feature brief:
  1. owner permitido -> funciona como antes
  2. unknown sender -> continua bloqueado
  3. delegated ativo -> mensagem aceita
  4. delegated expirado -> bloqueado
  5. delegated fechado -> bloqueado
  6. delegated -> sessao diferente do owner
  7. delegated -> nao recebe tools privilegiadas
"""

import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import MessageEvent, SendResult
from gateway.session import SessionSource, build_session_key
from plugins.whatsapp_delegation import (
    DELEGATED_TOOLSET,
    _on_pre_gateway_dispatch,
    _on_pre_tool_call,
    _tool_ask_owner,
    _tool_notify_owner_progress,
    _tool_report_delegated_conversation_result,
    _tool_start_delegated_conversation,
)
from plugins.whatsapp_delegation.store import DelegatedConversationStore

OWNER_ID = "15551234567@s.whatsapp.net"
CONTACT_ID = "19175395595@s.whatsapp.net"
CONTACT_CANONICAL = "19175395595"


@pytest.fixture
def delegation_store(tmp_path, monkeypatch):
    """Point the plugin's module-level singleton at a throwaway file.

    `get_store()` is imported by bare name in a few call sites, but its
    body reads the module-global `_default_store` dynamically each call,
    so patching that global (not the imported name) redirects every caller.
    """
    import plugins.whatsapp_delegation.store as store_module

    store = DelegatedConversationStore(path=tmp_path / "delegated-conversations.json")
    monkeypatch.setattr(store_module, "_default_store", store)
    return store


def _clear_auth_env(monkeypatch) -> None:
    for key in ("WHATSAPP_ALLOWED_USERS", "GATEWAY_ALLOWED_USERS", "WHATSAPP_ALLOW_ALL_USERS", "GATEWAY_ALLOW_ALL_USERS"):
        monkeypatch.delenv(key, raising=False)


def _make_event(sender: str, text: str = "hello") -> MessageEvent:
    return MessageEvent(
        text=text,
        message_id="m1",
        source=SessionSource(
            platform=Platform.WHATSAPP,
            user_id=sender,
            chat_id=sender,
            user_name="tester",
            chat_type="dm",
        ),
    )


def _make_whatsapp_adapter_for_intake():
    """Construct only the state the real bridge intake path needs."""
    from plugins.platforms.whatsapp.adapter import WhatsAppAdapter

    adapter = object.__new__(WhatsAppAdapter)
    adapter.platform = Platform.WHATSAPP
    adapter.config = PlatformConfig(
        enabled=True,
        extra={"dm_policy": "allowlist", "allow_from": [OWNER_ID]},
    )
    adapter._dm_policy = "allowlist"
    adapter._allow_from = {OWNER_ID}
    return adapter


def _write_lid_mapping(monkeypatch, tmp_path, *, phone: str, lid: str) -> None:
    """Make the shared identity resolver see the bridge's phone/LID mapping."""
    monkeypatch.setattr(
        "gateway.whatsapp_identity.get_hermes_dir", lambda *_args: tmp_path
    )
    (tmp_path / f"lid-mapping-{phone}.json").write_text(
        json.dumps(lid), encoding="utf-8"
    )
    (tmp_path / f"lid-mapping-{lid}_reverse.json").write_text(
        json.dumps(phone), encoding="utf-8"
    )


def _make_runner():
    from gateway.run import GatewayRunner

    config = GatewayConfig(platforms={Platform.WHATSAPP: PlatformConfig(enabled=True)})
    runner = object.__new__(GatewayRunner)
    runner.config = config
    adapter = SimpleNamespace(send=AsyncMock())
    runner.adapters = {Platform.WHATSAPP: adapter}
    runner.pairing_store = MagicMock()
    runner.pairing_store.is_approved.return_value = False
    runner.pairing_store._is_rate_limited.return_value = False
    runner.session_store = MagicMock()
    runner._running_agents = {}
    runner._update_prompt_pending = {}
    return runner, adapter


def _wire_real_hook(monkeypatch):
    """Route _handle_message's pre_gateway_dispatch invocation through the
    plugin's REAL callback (not a stub), same call signature invoke_hook uses.
    """

    def _invoke(name, **kwargs):
        if name == "pre_gateway_dispatch":
            result = _on_pre_gateway_dispatch(**kwargs)
            return [result] if result is not None else []
        return []

    monkeypatch.setattr("hermes_cli.plugins.invoke_hook", _invoke)


@pytest.mark.asyncio
async def test_owner_allowed_works_as_before(monkeypatch, delegation_store):
    """1. owner permitido -> funciona como antes."""
    _clear_auth_env(monkeypatch)
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", OWNER_ID)
    _wire_real_hook(monkeypatch)

    runner, _adapter = _make_runner()
    dispatched = {"called": False}

    async def _capture(event, source, _quick_key, _run_generation):
        dispatched["called"] = True
        return "ok"

    runner._handle_message_with_agent = _capture  # noqa: SLF001

    await runner._handle_message(_make_event(OWNER_ID))
    assert dispatched["called"] is True


@pytest.mark.asyncio
async def test_unknown_sender_still_blocked(monkeypatch, delegation_store):
    """2. unknown sender -> continua bloqueado (no delegation on file)."""
    _clear_auth_env(monkeypatch)
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", OWNER_ID)
    _wire_real_hook(monkeypatch)

    runner, _adapter = _make_runner()
    dispatched = {"called": False}

    async def _capture(event, source, _quick_key, _run_generation):
        dispatched["called"] = True
        return "ok"

    runner._handle_message_with_agent = _capture  # noqa: SLF001
    runner._get_unauthorized_dm_behavior = lambda *a, **k: "ignore"

    await runner._handle_message(_make_event("999999999@s.whatsapp.net"))
    assert dispatched["called"] is False


@pytest.mark.asyncio
async def test_active_delegation_admits_message(monkeypatch, delegation_store):
    """3. delegated ativo -> mensagem aceita, even though the contact is
    NOT in WHATSAPP_ALLOWED_USERS."""
    _clear_auth_env(monkeypatch)
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", OWNER_ID)
    _wire_real_hook(monkeypatch)

    delegation_store.create(
        contact=CONTACT_ID, objective="ask about tomorrow", ttl_seconds=3600,
        owner=OWNER_ID, owner_chat_id=OWNER_ID,
    )

    runner, _adapter = _make_runner()
    dispatched = {"called": False}

    async def _capture(event, source, _quick_key, _run_generation):
        dispatched["called"] = True
        return "ok"

    runner._handle_message_with_agent = _capture  # noqa: SLF001

    await runner._handle_message(_make_event(CONTACT_ID))
    assert dispatched["called"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "sender_id,chat_id",
    [
        ("553484269133@s.whatsapp.net", "553484269133@s.whatsapp.net"),
        ("77214955630717@lid", "77214955630717@lid"),
    ],
)
async def test_bridge_intake_admits_only_active_delegated_allowlist_contact(
    monkeypatch, tmp_path, delegation_store, sender_id, chat_id
):
    """The bridge adapter must build an event before the plugin hook can admit it.

    The owner is the sole normal allowlist entry.  Both bridge-shaped phone
    and mapped-LID deliveries must reach the existing restricted dispatch
    toolset; an unrelated unlisted contact remains dropped.
    """
    from gateway.run import GatewayRunner

    _clear_auth_env(monkeypatch)
    _write_lid_mapping(
        monkeypatch, tmp_path, phone="553484269133", lid="77214955630717"
    )
    delegation_store.create(
        contact="+55 34 8426-9133",
        objective="confirm appointment",
        ttl_seconds=3600,
        owner=OWNER_ID,
        owner_chat_id=OWNER_ID,
    )
    adapter = _make_whatsapp_adapter_for_intake()
    bridge_data = {
        "isGroup": False,
        "body": "hello",
        "messageId": "bridge-message-1",
        "senderId": sender_id,
        "from": sender_id,
        "chatId": chat_id,
        "chatName": "Delegated contact",
        "senderName": "Contact",
        "delegatedInbound": True,
    }

    event = await adapter._build_message_event(bridge_data)

    assert event is not None
    assert event.source.chat_id == chat_id
    runner = object.__new__(GatewayRunner)
    runner._adapter_for_source = lambda _source: adapter
    enabled_toolsets = GatewayRunner._resolve_enabled_toolsets_for_source(
        runner,
        {"platform_toolsets": {"whatsapp": ["terminal", "file"]}},
        event.source,
        "whatsapp",
    )
    assert DELEGATED_TOOLSET in enabled_toolsets
    assert "terminal" not in enabled_toolsets
    assert "file" not in enabled_toolsets

    bridge_data["senderId"] = "5511999999999@s.whatsapp.net"
    bridge_data["from"] = "5511999999999@s.whatsapp.net"
    bridge_data["chatId"] = "5511999999999@s.whatsapp.net"
    bridge_data.pop("delegatedInbound")
    assert await adapter._build_message_event(bridge_data) is None


@pytest.mark.asyncio
async def test_delegated_bridge_intake_and_plugin_emit_safe_trace_markers(
    monkeypatch, tmp_path, delegation_store, caplog
):
    """The bridge-marked delegated path is traceable without logging text or JIDs."""
    import logging

    _clear_auth_env(monkeypatch)
    delegation_store.create(
        contact=CONTACT_ID, objective="confirm appointment", ttl_seconds=3600,
        owner=OWNER_ID, owner_chat_id=OWNER_ID,
    )
    adapter = _make_whatsapp_adapter_for_intake()
    adapter.name = "whatsapp"
    bridge_data = {
        "isGroup": False,
        "body": "private reply body must never appear in logs",
        "messageId": "safe-message-id",
        "senderId": CONTACT_ID,
        "from": CONTACT_ID,
        "chatId": CONTACT_ID,
        "delegatedInbound": True,
    }

    with caplog.at_level(logging.INFO):
        event = await adapter._build_message_event(bridge_data)
        assert event is not None
        assert _on_pre_gateway_dispatch(event=event) == {"action": "delegate"}

    trace_lines = [record.getMessage() for record in caplog.records if "whatsapp-delegation-trace" in record.getMessage()]
    assert [line.split(" stage=", 1)[1].split(" ", 1)[0] for line in trace_lines] == [
        "adapter_bridge_message_received",
        "adapter_event_built",
        "plugin_delegation_lookup",
    ]
    joined = "\n".join(trace_lines)
    assert "private reply body" not in joined
    assert CONTACT_ID not in joined
    assert "jid:…9595" in joined
    assert "message_id=safe-message-id" in joined


@pytest.mark.asyncio
async def test_non_delegated_bridge_intake_remains_trace_quiet(
    monkeypatch, delegation_store, caplog
):
    """Ordinary rejected intake is unchanged and does not produce trace noise."""
    import logging

    _clear_auth_env(monkeypatch)
    adapter = _make_whatsapp_adapter_for_intake()
    adapter.name = "whatsapp"
    data = {
        "isGroup": False,
        "body": "ordinary unlisted message",
        "messageId": "ordinary-message-id",
        "senderId": "5511999999999@s.whatsapp.net",
        "chatId": "5511999999999@s.whatsapp.net",
    }
    with caplog.at_level(logging.INFO):
        assert await adapter._build_message_event(data) is None
    assert not [record for record in caplog.records if "whatsapp-delegation-trace" in record.getMessage()]


def test_plugin_traces_expired_bridge_marked_delegation_as_normal_dispatch(
    delegation_store, caplog
):
    """A grant expiring between bridge and hook is diagnosed without admission."""
    import logging

    event = _make_event("5511999999999@s.whatsapp.net")
    event.raw_message = {"delegatedInbound": True}
    with caplog.at_level(logging.INFO):
        assert _on_pre_gateway_dispatch(event=event) is None
    trace_lines = [record.getMessage() for record in caplog.records if "whatsapp-delegation-trace" in record.getMessage()]
    assert trace_lines == [
        "whatsapp-delegation-trace stage=plugin_delegation_lookup "
        "contact=jid:…9999 message_id=m1 active=false action=continue_normal_dispatch"
    ]


@pytest.mark.asyncio
async def test_expired_delegation_still_blocked(monkeypatch, delegation_store):
    """4. delegated expirado -> bloqueado."""
    _clear_auth_env(monkeypatch)
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", OWNER_ID)
    _wire_real_hook(monkeypatch)

    record = delegation_store.create(
        contact=CONTACT_ID, objective="obj", ttl_seconds=60,
        owner=OWNER_ID, owner_chat_id=OWNER_ID,
    )
    data = delegation_store._read()  # noqa: SLF001
    data[record.contact]["expires_at"] = 1.0  # far in the past
    delegation_store._write(data)  # noqa: SLF001

    runner, _adapter = _make_runner()
    dispatched = {"called": False}

    async def _capture(event, source, _quick_key, _run_generation):
        dispatched["called"] = True
        return "ok"

    runner._handle_message_with_agent = _capture  # noqa: SLF001
    runner._get_unauthorized_dm_behavior = lambda *a, **k: "ignore"

    await runner._handle_message(_make_event(CONTACT_ID))
    assert dispatched["called"] is False


@pytest.mark.asyncio
async def test_closed_delegation_still_blocked(monkeypatch, delegation_store):
    """5. delegated fechado -> bloqueado."""
    _clear_auth_env(monkeypatch)
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", OWNER_ID)
    _wire_real_hook(monkeypatch)

    record = delegation_store.create(
        contact=CONTACT_ID, objective="obj", ttl_seconds=3600,
        owner=OWNER_ID, owner_chat_id=OWNER_ID,
    )
    delegation_store.close(record.id, reason="done")

    runner, _adapter = _make_runner()
    dispatched = {"called": False}

    async def _capture(event, source, _quick_key, _run_generation):
        dispatched["called"] = True
        return "ok"

    runner._handle_message_with_agent = _capture  # noqa: SLF001
    runner._get_unauthorized_dm_behavior = lambda *a, **k: "ignore"

    await runner._handle_message(_make_event(CONTACT_ID))
    assert dispatched["called"] is False


def test_delegated_session_key_differs_from_owner_session(delegation_store):
    """6. delegated -> sessao diferente do owner.

    Session keys are derived purely from chat_id (build_session_key), so a
    delegated contact's session is structurally isolated from the owner's
    own DM session -- no shared history, no shared context.
    """
    owner_source = SessionSource(platform=Platform.WHATSAPP, chat_id=OWNER_ID, user_id=OWNER_ID, chat_type="dm")
    contact_source = SessionSource(platform=Platform.WHATSAPP, chat_id=CONTACT_ID, user_id=CONTACT_ID, chat_type="dm")

    owner_key = build_session_key(owner_source)
    contact_key = build_session_key(contact_source)

    assert owner_key != contact_key


def test_delegated_session_gets_minimal_toolset_owner_session_unaffected(delegation_store):
    """7a. delegated -> nao recebe tools privilegiadas (toolset resolution)."""
    from gateway.config import PlatformConfig
    from plugins.platforms.whatsapp.adapter import WhatsAppAdapter

    delegation_store.create(
        contact=CONTACT_ID, objective="obj", ttl_seconds=3600,
        owner=OWNER_ID, owner_chat_id=OWNER_ID,
    )

    adapter = object.__new__(WhatsAppAdapter)

    contact_source = SessionSource(platform=Platform.WHATSAPP, chat_id=CONTACT_ID, user_id=CONTACT_ID, chat_type="dm")
    owner_source = SessionSource(platform=Platform.WHATSAPP, chat_id=OWNER_ID, user_id=OWNER_ID, chat_type="dm")

    assert adapter.toolsets_for_source(contact_source) == [DELEGATED_TOOLSET]
    # A normal (non-delegated) source is unaffected -- falls back to the
    # platform's own toolset resolution.
    assert adapter.toolsets_for_source(owner_source) is None


def _fake_session_env(chat_id: str, platform: str = "whatsapp"):
    values = {"HERMES_SESSION_CHAT_ID": chat_id, "HERMES_SESSION_PLATFORM": platform}

    def _get(name, default=""):
        return values.get(name, default)

    return _get


def test_delegated_session_pre_tool_call_hard_blocks_privileged_tools(delegation_store, monkeypatch):
    """7b. delegated -> nao recebe tools privilegiadas (hard-block defense-in-depth).

    Even if toolset resolution were somehow misconfigured to include a
    privileged tool, pre_tool_call independently blocks anything outside the
    three delegated-session tools for any session whose own chat_id has an
    active delegation.
    """
    delegation_store.create(
        contact=CONTACT_ID, objective="obj", ttl_seconds=3600,
        owner=OWNER_ID, owner_chat_id=OWNER_ID,
    )

    monkeypatch.setattr(
        "gateway.session_context.get_session_env", _fake_session_env(CONTACT_ID)
    )

    blocked = _on_pre_tool_call(tool_name="terminal")
    assert blocked is not None
    assert blocked["action"] == "block"

    blocked_file = _on_pre_tool_call(tool_name="write_file")
    assert blocked_file is not None
    assert blocked_file["action"] == "block"

    allowed = _on_pre_tool_call(tool_name="ask_owner")
    assert allowed is None

    # A non-delegated session (e.g. the owner's normal chat) is unaffected.
    monkeypatch.setattr(
        "gateway.session_context.get_session_env", _fake_session_env(OWNER_ID)
    )
    assert _on_pre_tool_call(tool_name="terminal") is None


# ---------------------------------------------------------------------------
# Tool-handler integration: conversation_id resolution + outbound send
# ---------------------------------------------------------------------------


def _patch_live_gateway(monkeypatch):
    """Fake `_gateway_runner_ref()` returning a runner with a mocked WhatsApp
    adapter.send, the same seam _send_whatsapp uses in production."""
    send_mock = AsyncMock()
    runner = SimpleNamespace(
        adapters={Platform.WHATSAPP: SimpleNamespace(send=send_mock)},
        _gateway_loop=asyncio.get_running_loop(),
    )
    monkeypatch.setattr("gateway.run._gateway_runner_ref", lambda: runner)
    return send_mock


@pytest.mark.asyncio
async def test_ask_owner_resolves_conversation_from_session_chat_id_and_notifies_owner(
    monkeypatch, delegation_store
):
    delegation_store.create(
        contact=CONTACT_ID, objective="ask about tomorrow", ttl_seconds=3600,
        owner=OWNER_ID, owner_chat_id=OWNER_ID,
    )
    monkeypatch.setattr(
        "gateway.session_context.get_session_env", _fake_session_env(CONTACT_ID)
    )
    send_mock = _patch_live_gateway(monkeypatch)

    result = await _tool_ask_owner({"question": "what time works?"})
    assert '"success": true' in result
    send_mock.assert_awaited_once()
    assert send_mock.await_args.kwargs["chat_id"] == OWNER_ID
    assert "what time works?" in send_mock.await_args.kwargs["content"]

    pending = delegation_store.get_active_for_contact(CONTACT_ID)
    assert pending.pending_question == "what time works?"


@pytest.mark.asyncio
async def test_notify_owner_progress_requires_active_delegation(monkeypatch, delegation_store):
    # No delegation exists for this chat_id -- the tool must refuse, not
    # silently message whatever owner_chat_id happens to be lying around.
    monkeypatch.setattr(
        "gateway.session_context.get_session_env", _fake_session_env(CONTACT_ID)
    )
    _patch_live_gateway(monkeypatch)

    result = await _tool_notify_owner_progress({"update": "still waiting"})
    assert '"error"' in result


@pytest.mark.asyncio
async def test_report_delegated_conversation_result_closes_and_notifies_owner(
    monkeypatch, delegation_store
):
    record = delegation_store.create(
        contact=CONTACT_ID, objective="ask about tomorrow", ttl_seconds=3600,
        owner=OWNER_ID, owner_chat_id=OWNER_ID,
    )
    monkeypatch.setattr(
        "gateway.session_context.get_session_env", _fake_session_env(CONTACT_ID)
    )
    send_mock = _patch_live_gateway(monkeypatch)

    result = await _tool_report_delegated_conversation_result(
        {"summary": "he confirmed", "outcome": "completed"}
    )
    assert '"success": true' in result
    send_mock.assert_awaited_once()
    assert send_mock.await_args.kwargs["chat_id"] == OWNER_ID

    closed = delegation_store.get(record.id)
    assert closed.status == "CLOSED"
    assert closed.outcome == "completed"
    # Once closed, the contact's next message is no longer admitted.
    assert delegation_store.get_active_for_contact(CONTACT_ID) is None


@pytest.mark.asyncio
async def test_start_delegated_conversation_rejects_self_delegation(monkeypatch, delegation_store):
    monkeypatch.setattr(
        "gateway.session_context.get_session_env",
        lambda name, default="": {
            "HERMES_SESSION_PLATFORM": "whatsapp",
            "HERMES_SESSION_USER_ID": OWNER_ID,
            "HERMES_SESSION_CHAT_ID": OWNER_ID,
        }.get(name, default),
    )
    _patch_live_gateway(monkeypatch)

    result = await _tool_start_delegated_conversation(
        {"contact": OWNER_ID, "objective": "obj", "opening_message": "hi"}
    )
    assert '"error"' in result
    assert delegation_store.get_active_for_contact(OWNER_ID) is None


@pytest.mark.asyncio
async def test_start_delegated_conversation_creates_record_and_sends_opening_message(
    monkeypatch, delegation_store
):
    monkeypatch.setattr(
        "gateway.session_context.get_session_env",
        lambda name, default="": {
            "HERMES_SESSION_PLATFORM": "whatsapp",
            "HERMES_SESSION_USER_ID": OWNER_ID,
            "HERMES_SESSION_CHAT_ID": OWNER_ID,
        }.get(name, default),
    )
    send_mock = _patch_live_gateway(monkeypatch)

    result = await _tool_start_delegated_conversation(
        {"contact": CONTACT_ID, "objective": "ask about tomorrow", "opening_message": "hey, are you free tomorrow?"}
    )
    assert '"success": true' in result
    send_mock.assert_awaited_once()
    assert "tomorrow" in send_mock.await_args.kwargs["content"]

    active = delegation_store.get_active_for_contact(CONTACT_ID)
    assert active is not None
    assert active.owner == "15551234567"  # canonicalized form of OWNER_ID


@pytest.mark.asyncio
async def test_start_delegated_conversation_sends_on_gateway_loop_from_worker_thread(
    monkeypatch, delegation_store
):
    """The adapter's aiohttp session belongs to the gateway loop, not the agent worker."""
    gateway_loop = asyncio.new_event_loop()
    gateway_ready = threading.Event()
    gateway_thread = threading.Thread(
        target=lambda: (asyncio.set_event_loop(gateway_loop), gateway_ready.set(), gateway_loop.run_forever()),
        daemon=True,
    )
    gateway_thread.start()
    assert gateway_ready.wait(timeout=1)

    sent_on_loop = []

    async def loop_bound_send(*, chat_id, content):
        if asyncio.get_running_loop() is not gateway_loop:
            raise RuntimeError("Timeout context manager should be used inside a task")
        sent_on_loop.append((chat_id, content))
        return SimpleNamespace(success=True)

    runner = SimpleNamespace(
        adapters={Platform.WHATSAPP: SimpleNamespace(send=loop_bound_send)},
        _gateway_loop=gateway_loop,
    )
    monkeypatch.setattr("gateway.run._gateway_runner_ref", lambda: runner)
    monkeypatch.setattr(
        "gateway.session_context.get_session_env",
        lambda name, default="": {
            "HERMES_SESSION_PLATFORM": "whatsapp",
            "HERMES_SESSION_USER_ID": OWNER_ID,
            "HERMES_SESSION_CHAT_ID": OWNER_ID,
        }.get(name, default),
    )

    try:
        result = await asyncio.to_thread(
            lambda: asyncio.run(
                _tool_start_delegated_conversation(
                    {"contact": CONTACT_ID, "objective": "obj", "opening_message": "hello"}
                )
            )
        )
    finally:
        gateway_loop.call_soon_threadsafe(gateway_loop.stop)
        gateway_thread.join(timeout=1)
        gateway_loop.close()

    assert '"success": true' in result
    assert sent_on_loop == [(CONTACT_ID, "hello")]


@pytest.mark.asyncio
async def test_start_delegated_conversation_accepts_formatted_contact_number(
    monkeypatch, delegation_store
):
    monkeypatch.setattr(
        "gateway.session_context.get_session_env",
        lambda name, default="": {
            "HERMES_SESSION_PLATFORM": "whatsapp",
            "HERMES_SESSION_USER_ID": OWNER_ID,
            "HERMES_SESSION_CHAT_ID": OWNER_ID,
        }.get(name, default),
    )
    send_mock = _patch_live_gateway(monkeypatch)
    send_mock.return_value = SimpleNamespace(success=True)

    result = await _tool_start_delegated_conversation(
        {
            "contact": "+55 34 8426-9133",
            "objective": "ask about tomorrow",
            "opening_message": "hello",
        }
    )

    assert '"success": true' in result
    assert '"opening_message_status": "accepted"' in result
    assert send_mock.await_args.kwargs["chat_id"] == "553484269133@s.whatsapp.net"
    assert delegation_store.get_active_for_contact("553484269133") is not None


@pytest.mark.asyncio
async def test_start_delegated_conversation_surfaces_accepted_message_id(
    monkeypatch, delegation_store
):
    monkeypatch.setattr(
        "gateway.session_context.get_session_env",
        lambda name, default="": {
            "HERMES_SESSION_PLATFORM": "whatsapp",
            "HERMES_SESSION_USER_ID": OWNER_ID,
            "HERMES_SESSION_CHAT_ID": OWNER_ID,
        }.get(name, default),
    )
    send_mock = _patch_live_gateway(monkeypatch)
    send_mock.return_value = SendResult(success=True, message_id="baileys-local-key")

    result = await _tool_start_delegated_conversation(
        {"contact": CONTACT_ID, "objective": "obj", "opening_message": "hello"}
    )

    assert '"opening_message_status": "accepted"' in result
    assert '"opening_message_id": "baileys-local-key"' in result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "adapter_result",
    [
        False,
        {"success": False, "error": "rejected"},
        {"delivered": False, "error": "not delivered"},
        SimpleNamespace(success=False, error="rejected"),
        SimpleNamespace(delivered=False, error="not delivered"),
    ],
)
async def test_start_delegated_conversation_closes_record_when_adapter_rejects_opening_send(
    monkeypatch, delegation_store, adapter_result
):
    monkeypatch.setattr(
        "gateway.session_context.get_session_env",
        lambda name, default="": {
            "HERMES_SESSION_PLATFORM": "whatsapp",
            "HERMES_SESSION_USER_ID": OWNER_ID,
            "HERMES_SESSION_CHAT_ID": OWNER_ID,
        }.get(name, default),
    )
    send_mock = _patch_live_gateway(monkeypatch)
    send_mock.return_value = adapter_result

    result = await _tool_start_delegated_conversation(
        {"contact": CONTACT_ID, "objective": "obj", "opening_message": "hello"}
    )

    assert '"error"' in result
    assert '"success": true' not in result
    closed = delegation_store.list_for_owner(OWNER_ID, include_closed=True)
    assert len(closed) == 1
    assert closed[0].status == "CLOSED"
    assert closed[0].closed_reason == "opening_send_failed"
