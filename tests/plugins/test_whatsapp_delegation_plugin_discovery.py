"""Bundled-plugin discovery/registration smoke test for whatsapp-delegation.

Mirrors tests/plugins/test_disk_cleanup_plugin.py's TestBundledDiscovery
pattern: bundled plugins are discovered but NOT loaded without explicit
opt-in via plugins.enabled.
"""

import yaml

import pytest


@pytest.fixture(autouse=True)
def _isolate_env(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    yield hermes_home


def test_discovered_but_not_loaded_by_default(_isolate_env):
    from hermes_cli import plugins as pmod

    mgr = pmod.PluginManager()
    mgr.discover_and_load()
    loaded = mgr._plugins.get("whatsapp-delegation")
    assert loaded is not None
    assert loaded.manifest.source == "bundled"
    assert not loaded.enabled


def test_registers_owner_and_delegated_toolsets_when_enabled(_isolate_env):
    (_isolate_env / "config.yaml").write_text(
        yaml.safe_dump({"plugins": {"enabled": ["whatsapp-delegation"]}})
    )
    from hermes_cli import plugins as pmod

    mgr = pmod.PluginManager()
    mgr.discover_and_load()
    loaded = mgr._plugins["whatsapp-delegation"]
    assert loaded.enabled, loaded.error

    from tools.registry import registry

    owner_tools = {
        "start_delegated_conversation",
        "send_delegated_message",
        "answer_delegated_conversation",
        "close_delegated_conversation",
        "get_delegated_conversation_status",
        "list_delegated_conversations",
    }
    delegated_tools = {
        "ask_owner",
        "notify_owner_progress",
        "report_delegated_conversation_result",
    }
    for name in owner_tools:
        entry = registry.get_entry(name)
        assert entry is not None, f"{name} not registered"
        assert entry.toolset == "whatsapp_delegation"
    for name in delegated_tools:
        entry = registry.get_entry(name)
        assert entry is not None, f"{name} not registered"
        assert entry.toolset == "whatsapp_delegated_session"
