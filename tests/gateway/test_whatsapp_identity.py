"""Tests for gateway.whatsapp_identity alias resolution path."""

import json

from gateway.whatsapp_identity import canonical_whatsapp_identifier, expand_whatsapp_aliases


def test_aliases_resolve_on_modern_platforms_layout(tmp_path, monkeypatch):
    tmp_home = tmp_path / "hermes-home"
    mapping_dir = tmp_home / "platforms" / "whatsapp" / "session"
    mapping_dir.mkdir(parents=True, exist_ok=True)
    (mapping_dir / "lid-mapping-999999999999999.json").write_text(
        json.dumps("15551234567@s.whatsapp.net"),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(tmp_home))

    assert expand_whatsapp_aliases("999999999999999@lid") == {
        "999999999999999",
        "15551234567",
    }


def test_canonical_identifier_accepts_human_formatted_phone_number():
    assert canonical_whatsapp_identifier("+55 34 8426-9133") == "553484269133"


def test_canonical_identifier_falls_back_when_alias_expansion_is_empty(monkeypatch):
    monkeypatch.setattr("gateway.whatsapp_identity.expand_whatsapp_aliases", lambda _value: set())
    assert canonical_whatsapp_identifier("553484269133") == "553484269133"

