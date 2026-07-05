"""Tests for shared.image_delivery — local copy and Supabase upload paths."""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import shared.image_delivery as mod


@pytest.fixture()
def fake_image(tmp_path) -> Path:
    """A 4-byte PNG magic-byte file for testing."""
    p = tmp_path / "abc123.png"
    p.write_bytes(b"\x89PNG")
    return p


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Remove all delivery env vars before each test."""
    for var in (
        "NEUROCLAW_UPLOADS_DIR",
        "NEUROCLAW_DASHBOARD_URL",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_KEY",
        "SUPABASE_IMAGES_BUCKET",
    ):
        monkeypatch.delenv(var, raising=False)


# ── Not configured ─────────────────────────────────────────────────────────────

def test_not_configured_returns_local_path_only(fake_image, caplog):
    with caplog.at_level(logging.INFO, logger="shared.image_delivery"):
        r = mod.deliver_image(str(fake_image))
    assert r.local_path == str(fake_image)
    assert r.local_url is None
    assert r.public_url is None
    assert "not configured" in caplog.text


# ── Local copy ─────────────────────────────────────────────────────────────────

def test_local_copy_writes_file_to_images_subdir(fake_image, tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    monkeypatch.setenv("NEUROCLAW_UPLOADS_DIR", str(uploads))
    monkeypatch.setenv("NEUROCLAW_DASHBOARD_URL", "http://localhost:3141")

    r = mod.deliver_image(str(fake_image))

    dest = uploads / "images" / fake_image.name
    assert dest.exists()
    assert r.local_url == f"http://localhost:3141/uploads/images/{fake_image.name}"
    # local_path is promoted to destination after copy
    assert r.local_path == str(dest)


def test_local_copy_creates_images_dir_if_missing(fake_image, tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    assert not uploads.exists()
    monkeypatch.setenv("NEUROCLAW_UPLOADS_DIR", str(uploads))
    monkeypatch.setenv("NEUROCLAW_DASHBOARD_URL", "http://localhost:3141")

    mod.deliver_image(str(fake_image))

    assert (uploads / "images").is_dir()


def test_local_copy_collision_appends_suffix(fake_image, tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    images_dir = uploads / "images"
    images_dir.mkdir(parents=True)
    # Pre-create a file with the same name
    (images_dir / fake_image.name).write_bytes(b"old")

    monkeypatch.setenv("NEUROCLAW_UPLOADS_DIR", str(uploads))
    monkeypatch.setenv("NEUROCLAW_DASHBOARD_URL", "http://localhost:3141")

    r = mod.deliver_image(str(fake_image))

    # Original file untouched
    assert (images_dir / fake_image.name).read_bytes() == b"old"
    assert r.local_url is not None
    # URL uses the suffixed name (not the original)
    assert r.local_url != f"http://localhost:3141/uploads/images/{fake_image.name}"
    # Suffixed file actually exists
    suffixed_name = r.local_url.split("/")[-1]
    assert (images_dir / suffixed_name).exists()
    # local_path points to the suffixed destination
    assert r.local_path == str(images_dir / suffixed_name)


def test_local_copy_missing_dashboard_url_warns(fake_image, tmp_path, monkeypatch, caplog):
    uploads = tmp_path / "uploads"
    monkeypatch.setenv("NEUROCLAW_UPLOADS_DIR", str(uploads))
    # NEUROCLAW_DASHBOARD_URL not set

    with caplog.at_level(logging.WARNING, logger="shared.image_delivery"):
        r = mod.deliver_image(str(fake_image))

    assert r.local_url is None
    assert "NEUROCLAW_DASHBOARD_URL is missing" in caplog.text
    # File was still copied, local_path promoted to destination
    dest = uploads / "images" / fake_image.name
    assert dest.exists()
    assert r.local_path == str(dest)


def test_local_copy_error_returns_none_local_url(fake_image, monkeypatch, caplog):
    monkeypatch.setenv("NEUROCLAW_UPLOADS_DIR", "/nonexistent/path/that/cannot/be/created")
    monkeypatch.setenv("NEUROCLAW_DASHBOARD_URL", "http://localhost:3141")

    # Override mkdir to always fail
    with patch.object(Path, "mkdir", side_effect=PermissionError("denied")):
        with caplog.at_level(logging.WARNING, logger="shared.image_delivery"):
            r = mod.deliver_image(str(fake_image))

    assert r.local_url is None
    assert "Local image copy failed" in caplog.text
    # local_path stays as original since copy failed
    assert r.local_path == str(fake_image)


# ── Supabase upload ────────────────────────────────────────────────────────────

def test_supabase_upload_returns_public_url(fake_image, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-key")

    mock_client = MagicMock()
    mock_client.storage.from_().get_public_url.return_value = (
        "https://test.supabase.co/storage/v1/object/public/neuroclaw-images/abc123.png"
    )

    mock_supabase = MagicMock()
    mock_supabase.create_client = MagicMock(return_value=mock_client)

    with patch.dict("sys.modules", {"supabase": mock_supabase}):
        r = mod.deliver_image(str(fake_image))

    assert r.public_url == (
        "https://test.supabase.co/storage/v1/object/public/neuroclaw-images/abc123.png"
    )
    mock_client.storage.from_().upload.assert_called_once()
    # Verify upsert flag present in call
    call_args = mock_client.storage.from_().upload.call_args
    options = call_args[0][2] if len(call_args[0]) > 2 else call_args[1].get("file_options", {})
    assert options.get("upsert") == "true"


def test_supabase_upload_failure_logs_warning(fake_image, monkeypatch, caplog):
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-key")

    mock_client = MagicMock()
    mock_client.storage.from_().upload.side_effect = Exception("bucket not found")

    mock_supabase = MagicMock()
    mock_supabase.create_client = MagicMock(return_value=mock_client)

    with patch.dict("sys.modules", {"supabase": mock_supabase}):
        with caplog.at_level(logging.WARNING, logger="shared.image_delivery"):
            r = mod.deliver_image(str(fake_image))

    assert r.public_url is None
    assert "Supabase upload failed" in caplog.text
    assert "bucket not found" in caplog.text


def test_supabase_import_error_logs_warning(fake_image, monkeypatch, caplog):
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-key")

    with patch.dict("sys.modules", {"supabase": None}):
        with caplog.at_level(logging.WARNING, logger="shared.image_delivery"):
            r = mod.deliver_image(str(fake_image))

    assert r.public_url is None
    assert "supabase package not installed" in caplog.text


def test_supabase_missing_key_skips_upload(fake_image, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    # SUPABASE_SERVICE_KEY not set

    mock_create = MagicMock()
    mock_supabase = MagicMock()
    mock_supabase.create_client = mock_create

    with patch.dict("sys.modules", {"supabase": mock_supabase}):
        r = mod.deliver_image(str(fake_image))

    mock_create.assert_not_called()
    assert r.public_url is None


def test_custom_bucket_name(fake_image, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-key")
    monkeypatch.setenv("SUPABASE_IMAGES_BUCKET", "my-custom-bucket")

    mock_client = MagicMock()
    mock_client.storage.from_().get_public_url.return_value = "https://test.supabase.co/..."

    mock_supabase = MagicMock()
    mock_supabase.create_client = MagicMock(return_value=mock_client)

    with patch.dict("sys.modules", {"supabase": mock_supabase}):
        mod.deliver_image(str(fake_image))

    mock_client.storage.from_.assert_called_with("my-custom-bucket")
