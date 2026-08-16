"""Unit tests for plugins.whatsapp_delegation.store.

No gateway/session mocking needed -- DelegatedConversationStore takes an
explicit path, so these exercise the on-disk TTL/create/close semantics
directly against a temp file.
"""

import time

import pytest

from plugins.whatsapp_delegation.store import (
    MAX_TTL_SECONDS,
    MIN_TTL_SECONDS,
    STATUS_ACTIVE,
    STATUS_CLOSED,
    STATUS_EXPIRED,
    DelegatedConversationStore,
)


@pytest.fixture
def store(tmp_path):
    return DelegatedConversationStore(path=tmp_path / "delegated-conversations.json")


def test_create_and_get_roundtrip(store):
    record = store.create(
        contact="+19175395595",
        objective="ask if joao is coming tomorrow",
        ttl_seconds=3600,
        owner="15551234567",
        owner_chat_id="15551234567@s.whatsapp.net",
    )
    assert record.status == STATUS_ACTIVE
    assert record.id

    fetched = store.get(record.id)
    assert fetched is not None
    assert fetched.contact == "19175395595"
    assert fetched.owner == "15551234567"


def test_get_active_for_contact_matches_canonical_identity(store):
    store.create(
        contact="+19175395595",
        objective="obj",
        ttl_seconds=3600,
        owner="15551234567",
        owner_chat_id="chat",
    )
    active = store.get_active_for_contact("19175395595@s.whatsapp.net")
    assert active is not None
    assert active.contact == "19175395595"


def test_ttl_bounds_enforced(store):
    with pytest.raises(ValueError):
        store.create(
            contact="+19175395595",
            objective="obj",
            ttl_seconds=MIN_TTL_SECONDS - 1,
            owner="owner",
            owner_chat_id="chat",
        )
    with pytest.raises(ValueError):
        store.create(
            contact="+19175395595",
            objective="obj",
            ttl_seconds=MAX_TTL_SECONDS + 1,
            owner="owner",
            owner_chat_id="chat",
        )


def test_objective_and_contact_required(store):
    with pytest.raises(ValueError):
        store.create(contact="", objective="obj", ttl_seconds=60, owner="o", owner_chat_id="c")
    with pytest.raises(ValueError):
        store.create(contact="+1555", objective="  ", ttl_seconds=60, owner="o", owner_chat_id="c")


def test_duplicate_active_delegation_for_same_contact_rejected(store):
    store.create(
        contact="+19175395595", objective="first", ttl_seconds=3600,
        owner="owner", owner_chat_id="chat",
    )
    with pytest.raises(ValueError):
        store.create(
            contact="+19175395595", objective="second", ttl_seconds=3600,
            owner="owner", owner_chat_id="chat",
        )


def test_expiry_is_lazy_and_sticky(store):
    record = store.create(
        contact="+19175395595", objective="obj", ttl_seconds=MIN_TTL_SECONDS,
        owner="owner", owner_chat_id="chat",
    )
    # Force it into the past directly on disk (simulates time passing).
    data = store._read()  # noqa: SLF001 - white-box test of the sweep
    data[record.contact]["expires_at"] = time.time() - 1
    store._write(data)  # noqa: SLF001

    assert store.get_active_for_contact(record.contact) is None
    fetched = store.get(record.id)
    assert fetched.status == STATUS_EXPIRED

    # Once expired, a NEW delegation to the same contact is allowed again.
    store.create(
        contact="+19175395595", objective="second", ttl_seconds=3600,
        owner="owner", owner_chat_id="chat",
    )


def test_close_sets_status_and_outcome(store):
    record = store.create(
        contact="+19175395595", objective="obj", ttl_seconds=3600,
        owner="owner", owner_chat_id="chat",
    )
    closed = store.close(record.id, reason="completed_by_agent", outcome="completed")
    assert closed.status == STATUS_CLOSED
    assert closed.outcome == "completed"
    assert store.get_active_for_contact(record.contact) is None


def test_pending_question_set_and_clear(store):
    record = store.create(
        contact="+19175395595", objective="obj", ttl_seconds=3600,
        owner="owner", owner_chat_id="chat",
    )
    store.set_pending_question(record.id, "what time works?")
    assert store.get(record.id).pending_question == "what time works?"
    store.clear_pending_question(record.id)
    assert store.get(record.id).pending_question is None


def test_list_for_owner_scopes_by_owner_and_excludes_closed_by_default(store):
    a = store.create(contact="+1111", objective="a", ttl_seconds=3600, owner="owner-a", owner_chat_id="c")
    store.create(contact="+2222", objective="b", ttl_seconds=3600, owner="owner-b", owner_chat_id="c")
    assert [r.id for r in store.list_for_owner("owner-a")] == [a.id]

    store.close(a.id, reason="done")
    assert store.list_for_owner("owner-a") == []
    assert [r.id for r in store.list_for_owner("owner-a", include_closed=True)] == [a.id]
