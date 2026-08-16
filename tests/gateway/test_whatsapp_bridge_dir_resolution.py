"""Tests for resolve_whatsapp_bridge_dir() — read-only install tree handling.

Regression coverage for #49561: in the Docker image the install tree
(/opt/hermes/scripts/whatsapp-bridge) is read-only, so `npm install` fails
with EACCES. The resolver must detect the read-only install dir and mirror the
bridge source into a writable HERMES_HOME location instead.
"""
from pathlib import Path

from gateway.platforms import whatsapp_common


def _seed_install_tree(install_bridge: Path) -> None:
    """Create a minimal fake bridge source tree."""
    install_bridge.mkdir(parents=True, exist_ok=True)
    (install_bridge / "bridge.js").write_text("// bridge\n")
    (install_bridge / "bridge_helpers.js").write_text("// helper\n")
    (install_bridge / "package.json").write_text('{"name": "whatsapp-bridge"}\n')


def _make_install_readonly(monkeypatch, install_bridge: Path) -> None:
    """Force the write probe to fail even when tests run as root."""
    real_touch = Path.touch

    def fake_touch(self, *args, **kwargs):
        if self.name == ".write_test" and install_bridge in self.parents:
            raise PermissionError("read-only install tree")
        return real_touch(self, *args, **kwargs)

    monkeypatch.setattr(Path, "touch", fake_touch)


def _configure_paths(monkeypatch, install_root: Path, hermes_home: Path) -> None:
    monkeypatch.setattr(
        whatsapp_common, "__file__",
        str(install_root / "gateway" / "platforms" / "whatsapp_common.py"),
    )
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: hermes_home)


def test_readonly_install_mirrors_to_hermes_home(tmp_path, monkeypatch):
    """A read-only install tree is mirrored into a writable HERMES_HOME."""
    install_root = tmp_path / "install"
    install_bridge = install_root / "scripts" / "whatsapp-bridge"
    _seed_install_tree(install_bridge)

    hermes_home = tmp_path / "hermes_home"
    hermes_home.mkdir()

    _configure_paths(monkeypatch, install_root, hermes_home)
    _make_install_readonly(monkeypatch, install_bridge)

    resolved = whatsapp_common.resolve_whatsapp_bridge_dir()

    expected = hermes_home / "scripts" / "whatsapp-bridge"
    assert resolved == expected
    # Source was mirrored, not symlinked.
    assert (expected / "bridge.js").read_text() == "// bridge\n"
    assert (expected / "package.json").exists()


def test_existing_current_mirror_is_not_rewritten(tmp_path, monkeypatch):
    """A mirror whose source manifest matches the image is left intact."""
    install_root = tmp_path / "install"
    install_bridge = install_root / "scripts" / "whatsapp-bridge"
    _seed_install_tree(install_bridge)
    hermes_home = tmp_path / "hermes_home"
    hermes_home.mkdir()
    _configure_paths(monkeypatch, install_root, hermes_home)
    _make_install_readonly(monkeypatch, install_bridge)

    mirror = whatsapp_common.resolve_whatsapp_bridge_dir()
    bridge_mtime = (mirror / "bridge.js").stat().st_mtime_ns

    assert whatsapp_common.resolve_whatsapp_bridge_dir() == mirror
    assert (mirror / "bridge.js").stat().st_mtime_ns == bridge_mtime


def test_stale_mirror_refreshes_source_and_removes_old_managed_asset(tmp_path, monkeypatch):
    """An image source change refreshes imports and removes renamed assets."""
    install_root = tmp_path / "install"
    install_bridge = install_root / "scripts" / "whatsapp-bridge"
    _seed_install_tree(install_bridge)
    (install_bridge / "obsolete.js").write_text("// old import\n")
    hermes_home = tmp_path / "hermes_home"
    hermes_home.mkdir()
    _configure_paths(monkeypatch, install_root, hermes_home)
    _make_install_readonly(monkeypatch, install_bridge)
    mirror = whatsapp_common.resolve_whatsapp_bridge_dir()

    (install_bridge / "bridge_helpers.js").write_text("// refreshed helper\n")
    (install_bridge / "new_helper.js").write_text("// renamed import\n")
    (install_bridge / "obsolete.js").unlink()
    (install_bridge / "bridge.js").write_text("// refreshed entrypoint\n")

    assert whatsapp_common.resolve_whatsapp_bridge_dir() == mirror
    assert (mirror / "bridge.js").read_text() == "// refreshed entrypoint\n"
    assert (mirror / "bridge_helpers.js").read_text() == "// refreshed helper\n"
    assert (mirror / "new_helper.js").read_text() == "// renamed import\n"
    assert not (mirror / "obsolete.js").exists()


def test_refresh_preserves_node_modules_and_never_touches_session_state(tmp_path, monkeypatch):
    """Refresh changes source only, retaining npm state and credentials."""
    install_root = tmp_path / "install"
    install_bridge = install_root / "scripts" / "whatsapp-bridge"
    _seed_install_tree(install_bridge)
    # Even an accidental install-tree credential is not a bridge source asset.
    (install_bridge / "creds.json").write_text("install-credential\n")
    hermes_home = tmp_path / "hermes_home"
    hermes_home.mkdir()
    _configure_paths(monkeypatch, install_root, hermes_home)
    _make_install_readonly(monkeypatch, install_bridge)
    mirror = whatsapp_common.resolve_whatsapp_bridge_dir()
    assert not (mirror / "creds.json").exists()
    node_module = mirror / "node_modules" / "example" / "index.js"
    node_module.parent.mkdir(parents=True)
    node_module.write_text("installed dependency\n")
    mirror_credential = mirror / "creds.json"
    mirror_credential.write_text("mirror-credential\n")
    session_dir = hermes_home / "whatsapp" / "session"
    session_dir.mkdir(parents=True)
    session_credential = session_dir / "creds.json"
    session_credential.write_text("session-credential\n")

    (install_bridge / "bridge.js").write_text("// refreshed bridge\n")
    whatsapp_common.resolve_whatsapp_bridge_dir()

    assert node_module.read_text() == "installed dependency\n"
    assert mirror_credential.read_text() == "mirror-credential\n"
    assert session_credential.read_text() == "session-credential\n"
