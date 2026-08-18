"""Persistence for delegated WhatsApp conversations.

A delegated conversation lets an authorized WhatsApp owner (someone in
``WHATSAPP_ALLOWED_USERS``) grant Hermes a narrow, time-boxed mandate to
converse with a third-party contact who is NOT authorized to use Hermes
normally. The grant record here is the single source of truth consulted by:

- ``gateway/run.py`` (via the ``pre_gateway_dispatch`` hook in
  :mod:`plugins.whatsapp_delegation`) to decide whether an inbound message
  from a non-allowlisted WhatsApp sender should be admitted into a
  restricted session instead of the normal unauthorized-DM path;
- ``scripts/whatsapp-bridge/delegated_gate.js`` (the Node bridge), which
  reads this same JSON file directly to decide whether to forward a
  stranger's message to the Python gateway at all;
- ``plugins/platforms/whatsapp/adapter.py``'s ``toolsets_for_source``
  override, to resolve the minimal toolset for a delegated session.

Storage lives in the SAME directory the Baileys bridge already reads its
``lid-mapping-*.json`` files from -- ``$HERMES_HOME/whatsapp/session/``,
the exact path a running bridge process was launched with via
``--session`` (see ``WhatsAppAdapter._session_path`` in
``plugins/platforms/whatsapp/adapter.py``). Python is the sole writer;
the bridge only ever reads it. This deliberately avoids introducing any
new infrastructure (no Redis/Postgres) -- it is the same
atomic-JSON-file-with-a-process-lock pattern ``gateway/pairing.py`` uses
for pairing codes.
"""

from __future__ import annotations

import dataclasses
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from gateway.whatsapp_identity import canonical_whatsapp_identifier
from hermes_constants import get_hermes_dir
from utils import atomic_json_write

# TTL bounds: a delegation MUST expire, and cannot be granted "forever" by
# accident (min 1 minute -- long enough to be useful, short enough that a
# typo doesn't leave a stray grant around for a day) or open-ended (max 24h).
MIN_TTL_SECONDS = 60
MAX_TTL_SECONDS = 24 * 3600
DEFAULT_TTL_SECONDS = 3600

STATUS_ACTIVE = "ACTIVE"
STATUS_CLOSED = "CLOSED"
STATUS_EXPIRED = "EXPIRED"

_STORE_DIR = get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")
_STORE_PATH = _STORE_DIR / "delegated-conversations.json"


@dataclasses.dataclass
class DelegatedConversation:
    id: str
    contact: str  # canonical WhatsApp identifier (gateway.whatsapp_identity)
    objective: str
    status: str
    created_at: float
    expires_at: float
    owner: str  # canonical WhatsApp identifier of the owner who created it
    owner_chat_id: str  # raw chat_id to deliver owner notifications to
    closed_reason: Optional[str] = None
    outcome: Optional[str] = None
    pending_question: Optional[str] = None
    pending_question_at: Optional[float] = None
    last_activity_at: Optional[float] = None

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "DelegatedConversation":
        known = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})

    @property
    def is_active(self) -> bool:
        return self.status == STATUS_ACTIVE


class DelegatedConversationStore:
    """Atomic, RLock-guarded JSON store for delegated WhatsApp conversations.

    Keyed by canonical contact identifier so lookups by contact are O(1) and
    match exactly the identity ``gateway.session.build_session_key`` uses for
    WhatsApp DMs -- a phone/LID alias flip can never desync the grant from
    the session it's meant to cover.
    """

    def __init__(self, path: Optional[Path] = None):
        self._path = path or _STORE_PATH
        self._lock = threading.RLock()

    # -- raw file I/O --------------------------------------------------

    def _read(self) -> dict:
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            return {}

    def _write(self, data: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json_write(self._path, data, mode=0o600)

    @staticmethod
    def _sweep_expired_locked(data: dict) -> list[dict]:
        """Mark ACTIVE records past their TTL as EXPIRED in place.

        Returns the raw records that just made that transition. An empty
        list is falsy, so every existing ``if self._sweep_expired_locked(data):``
        call site below keeps working unchanged under this widened return type.
        """
        now = time.time()
        newly_expired = []
        for record in data.values():
            if record.get("status") == STATUS_ACTIVE and record.get("expires_at", 0) < now:
                record["status"] = STATUS_EXPIRED
                newly_expired.append(record)
        return newly_expired

    # -- create / read ---------------------------------------------------

    def create(
        self,
        *,
        contact: str,
        objective: str,
        ttl_seconds: float,
        owner: str,
        owner_chat_id: str,
    ) -> DelegatedConversation:
        contact_canonical = canonical_whatsapp_identifier(contact)
        if not contact_canonical:
            raise ValueError("contact must resolve to a WhatsApp identifier")
        objective = (objective or "").strip()
        if not objective:
            raise ValueError("objective is required")
        try:
            ttl = float(ttl_seconds)
        except (TypeError, ValueError):
            raise ValueError("ttl_seconds must be a number")
        if not (MIN_TTL_SECONDS <= ttl <= MAX_TTL_SECONDS):
            raise ValueError(
                f"ttl_seconds must be between {MIN_TTL_SECONDS} and "
                f"{MAX_TTL_SECONDS} (got {ttl_seconds})"
            )
        now = time.time()
        conversation_id = secrets.token_hex(8)
        record = DelegatedConversation(
            id=conversation_id,
            contact=contact_canonical,
            objective=objective,
            status=STATUS_ACTIVE,
            created_at=now,
            expires_at=now + ttl,
            owner=canonical_whatsapp_identifier(owner) or owner,
            owner_chat_id=owner_chat_id,
            last_activity_at=now,
        )
        with self._lock:
            data = self._read()
            self._sweep_expired_locked(data)
            existing = data.get(contact_canonical)
            if existing and existing.get("status") == STATUS_ACTIVE:
                raise ValueError(
                    "A delegated conversation is already active for this "
                    f"contact (id={existing.get('id')}). Close it first."
                )
            data[contact_canonical] = record.to_dict()
            self._write(data)
        return record

    def get(self, conversation_id: str) -> Optional[DelegatedConversation]:
        if not conversation_id:
            return None
        with self._lock:
            data = self._read()
            if self._sweep_expired_locked(data):
                self._write(data)
            for record in data.values():
                if record.get("id") == conversation_id:
                    return DelegatedConversation.from_dict(record)
        return None

    def get_active_for_contact(self, contact: str) -> Optional[DelegatedConversation]:
        canonical = canonical_whatsapp_identifier(contact)
        if not canonical:
            return None
        with self._lock:
            data = self._read()
            if self._sweep_expired_locked(data):
                self._write(data)
            record = data.get(canonical)
            if record and record.get("status") == STATUS_ACTIVE:
                return DelegatedConversation.from_dict(record)
        return None

    def list_for_owner(
        self, owner: str, *, include_closed: bool = False
    ) -> list[DelegatedConversation]:
        canonical_owner = canonical_whatsapp_identifier(owner) or owner
        with self._lock:
            data = self._read()
            if self._sweep_expired_locked(data):
                self._write(data)
            out = []
            for record in data.values():
                if record.get("owner") != canonical_owner:
                    continue
                if not include_closed and record.get("status") != STATUS_ACTIVE:
                    continue
                out.append(DelegatedConversation.from_dict(record))
        return out

    def sweep_expired(self) -> list[DelegatedConversation]:
        """Actively sweep every record for TTL expiry, returning the ones
        that just transitioned ACTIVE -> EXPIRED in this call.

        The sweep baked into every read method above is lazy and
        read-triggered: an expiry is only ever *detected* the next time
        something happens to read that exact contact, which may never
        happen again. This store has no event loop of its own to run a
        timer on, so a caller with one (the gateway hook) is expected to
        invoke this periodically to make expiry visible without depending
        on another read.
        """
        with self._lock:
            data = self._read()
            newly_expired = self._sweep_expired_locked(data)
            if newly_expired:
                self._write(data)
            return [DelegatedConversation.from_dict(record) for record in newly_expired]

    # -- mutate ------------------------------------------------------------

    def _mutate(
        self, conversation_id: str, fn: Callable[[dict], None]
    ) -> Optional[DelegatedConversation]:
        with self._lock:
            data = self._read()
            self._sweep_expired_locked(data)
            target_key = None
            for key, record in data.items():
                if record.get("id") == conversation_id:
                    target_key = key
                    break
            if target_key is None:
                return None
            record = data[target_key]
            fn(record)
            record["last_activity_at"] = time.time()
            self._write(data)
            return DelegatedConversation.from_dict(record)

    def close(
        self, conversation_id: str, *, reason: str, outcome: Optional[str] = None
    ) -> Optional[DelegatedConversation]:
        def _apply(record: dict) -> None:
            record["status"] = STATUS_CLOSED
            record["closed_reason"] = reason
            if outcome is not None:
                record["outcome"] = outcome

        return self._mutate(conversation_id, _apply)

    def set_pending_question(
        self, conversation_id: str, question: str
    ) -> Optional[DelegatedConversation]:
        def _apply(record: dict) -> None:
            record["pending_question"] = question
            record["pending_question_at"] = time.time()

        return self._mutate(conversation_id, _apply)

    def clear_pending_question(
        self, conversation_id: str
    ) -> Optional[DelegatedConversation]:
        def _apply(record: dict) -> None:
            record["pending_question"] = None
            record["pending_question_at"] = None

        return self._mutate(conversation_id, _apply)


_default_store: Optional[DelegatedConversationStore] = None
_default_store_lock = threading.Lock()


def get_store() -> DelegatedConversationStore:
    global _default_store
    if _default_store is None:
        with _default_store_lock:
            if _default_store is None:
                _default_store = DelegatedConversationStore()
    return _default_store
