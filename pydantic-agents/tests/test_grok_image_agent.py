"""Tests for grok_image_agent.agent — credential resolver, mime detection,
memory tools, vision pipeline, generation pipeline, and edit/compose tools."""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import grok_image_agent.agent as agent_mod


@pytest.fixture(autouse=True)
def reset_memory():
    """Reset module-level memory state between every test."""
    agent_mod._memory.clear()
    agent_mod._last_image = None
    yield
    agent_mod._memory.clear()
    agent_mod._last_image = None


# ── Credential resolver ────────────────────────────────────────────────────────


def test_resolve_from_hermes_auth(tmp_path, monkeypatch):
    auth = {
        "credential_pool": {
            "xai-oauth": [
                {"last_status": "ok", "access_token": "tok123", "base_url": "https://api.x.ai/v1"}
            ]
        }
    }
    hermes_dir = tmp_path / ".hermes"
    hermes_dir.mkdir()
    (hermes_dir / "auth.json").write_text(json.dumps(auth))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    result = agent_mod.resolve_xai_credentials()
    assert result is not None
    assert result.bearer == "tok123"
    assert result.base_url == "https://api.x.ai/v1"


def test_resolve_falls_back_to_env(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)  # no auth.json
    monkeypatch.setenv("XAI_API_KEY", "env-key-abc")
    result = agent_mod.resolve_xai_credentials()
    assert result is not None
    assert result.bearer == "env-key-abc"
    assert result.base_url == "https://api.x.ai/v1"


def test_resolve_returns_none_if_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    result = agent_mod.resolve_xai_credentials()
    assert result is None


def test_resolve_malformed_auth_falls_back(tmp_path, monkeypatch):
    hermes_dir = tmp_path / ".hermes"
    hermes_dir.mkdir()
    (hermes_dir / "auth.json").write_text("not valid json{{{")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("XAI_API_KEY", "fallback-key")
    result = agent_mod.resolve_xai_credentials()
    assert result is not None
    assert result.bearer == "fallback-key"


# ── MIME detection ─────────────────────────────────────────────────────────────


def test_get_mime_png(tmp_path):
    f = tmp_path / "img.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    assert agent_mod._get_mime(str(f)) == "image/png"


def test_get_mime_jpeg(tmp_path):
    f = tmp_path / "img.jpg"
    f.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
    assert agent_mod._get_mime(str(f)) == "image/jpeg"


def test_get_mime_pdf_returns_none(tmp_path):
    f = tmp_path / "doc.pdf"
    f.write_bytes(b"%PDF-1.4" + b"\x00" * 100)
    assert agent_mod._get_mime(str(f)) is None


def test_get_mime_missing_file_returns_none():
    assert agent_mod._get_mime("/nonexistent/definitely_not_here.png") is None


def test_get_mime_empty_file_returns_none(tmp_path):
    f = tmp_path / "empty.png"
    f.write_bytes(b"")
    assert agent_mod._get_mime(str(f)) is None


# ── Memory tools ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_remember_and_recall_by_label(tmp_path):
    img_path = str(tmp_path / "logo.png")
    result = await agent_mod.grok_remember_image(img_path, "logo")
    assert "Remembered 'logo'" in result
    recalled = await agent_mod.grok_recall_image("logo")
    assert recalled == img_path


@pytest.mark.asyncio
async def test_recall_last_image():
    agent_mod._last_image = "/fake/path/generated.png"
    result = await agent_mod.grok_recall_image("")
    assert result == "/fake/path/generated.png"


@pytest.mark.asyncio
async def test_recall_unknown_label():
    result = await agent_mod.grok_recall_image("nonexistent")
    assert result == "Error: no image remembered as 'nonexistent'"


@pytest.mark.asyncio
async def test_recall_no_memory_yet():
    result = await agent_mod.grok_recall_image("")
    assert result == "Error: no image in memory yet"


@pytest.mark.asyncio
async def test_recall_no_memory_with_label():
    result = await agent_mod.grok_recall_image("missing")
    assert result == "Error: no image remembered as 'missing'"


# ── Vision helper ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_describe_missing_file_raises():
    client = AsyncMock()
    with pytest.raises(ValueError, match="image not found"):
        await agent_mod._describe_image_from_path(client, "/nonexistent/img.png")


@pytest.mark.asyncio
async def test_describe_bad_mime_raises(tmp_path):
    f = tmp_path / "doc.pdf"
    f.write_bytes(b"%PDF-1.4" + b"\x00" * 100)
    client = AsyncMock()
    with pytest.raises(ValueError, match="unsupported file type"):
        await agent_mod._describe_image_from_path(client, str(f))


@pytest.mark.asyncio
async def test_describe_success_returns_description(tmp_path):
    f = tmp_path / "img.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    client = AsyncMock()
    client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="A blue square on white"))]
    )
    result = await agent_mod._describe_image_from_path(client, str(f))
    assert result == "A blue square on white"


@pytest.mark.asyncio
async def test_describe_calls_grok_43(tmp_path):
    f = tmp_path / "img.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    client = AsyncMock()
    client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="description"))]
    )
    await agent_mod._describe_image_from_path(client, str(f))
    call_kwargs = client.chat.completions.create.call_args.kwargs
    assert call_kwargs["model"] == "grok-4.3"
    content = call_kwargs["messages"][0]["content"]
    types = [part["type"] for part in content]
    assert "text" in types
    assert "image_url" in types


# ── Generation helper ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_generate_saves_b64_to_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_mod, "OUTPUT_DIR", str(tmp_path))
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
    b64 = base64.b64encode(png_bytes).decode()
    client = AsyncMock()
    client.images.generate.return_value = MagicMock(
        data=[MagicMock(b64_json=b64, url=None)]
    )
    saved = await agent_mod._generate_and_save(client, "a blue square", "standard")
    assert saved.endswith(".png")
    assert Path(saved).read_bytes() == png_bytes
    client.images.generate.assert_called_once_with(
        model="grok-imagine-image", prompt="a blue square", n=1
    )


@pytest.mark.asyncio
async def test_generate_uses_hd_model(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_mod, "OUTPUT_DIR", str(tmp_path))
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
    client = AsyncMock()
    client.images.generate.return_value = MagicMock(
        data=[MagicMock(b64_json=base64.b64encode(png_bytes).decode(), url=None)]
    )
    await agent_mod._generate_and_save(client, "a prompt", "hd")
    assert (
        client.images.generate.call_args.kwargs["model"] == "grok-imagine-image-quality"
    )


@pytest.mark.asyncio
async def test_generate_no_data_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_mod, "OUTPUT_DIR", str(tmp_path))
    client = AsyncMock()
    client.images.generate.return_value = MagicMock(
        data=[MagicMock(b64_json=None, url=None)]
    )
    with pytest.raises(ValueError, match="No image data"):
        await agent_mod._generate_and_save(client, "prompt", "standard")


# ── grok_image_edit ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_edit_no_credentials(monkeypatch):
    monkeypatch.setattr(agent_mod, "resolve_xai_credentials", lambda: None)
    result = await agent_mod.grok_image_edit("make it red", "/any/path.png")
    assert result.startswith("Error: no xAI credentials")


@pytest.mark.asyncio
async def test_edit_missing_file(monkeypatch):
    monkeypatch.setattr(
        agent_mod,
        "resolve_xai_credentials",
        lambda: agent_mod.XaiCredentials("tok", "https://api.x.ai/v1"),
    )
    with patch("grok_image_agent.agent.AsyncOpenAI"):
        result = await agent_mod.grok_image_edit("make it red", "/nonexistent/img.png")
    assert "image not found" in result


@pytest.mark.asyncio
async def test_edit_success_returns_path_and_updates_last(tmp_path, monkeypatch):
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    src = tmp_path / "source.png"
    src.write_bytes(png_bytes)
    monkeypatch.setattr(agent_mod, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_mod,
        "resolve_xai_credentials",
        lambda: agent_mod.XaiCredentials("tok", "https://api.x.ai/v1"),
    )

    out_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50).decode()
    mock_client = AsyncMock()
    mock_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="a png image"))]
    )
    mock_client.images.generate.return_value = MagicMock(
        data=[MagicMock(b64_json=out_b64, url=None)]
    )

    with patch("grok_image_agent.agent.AsyncOpenAI", return_value=mock_client):
        result = await agent_mod.grok_image_edit("make it red", str(src))

    assert result.startswith("path:")
    assert "description: make it red" in result
    assert agent_mod._last_image is not None


@pytest.mark.asyncio
async def test_edit_generation_prompt_contains_description(tmp_path, monkeypatch):
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    src = tmp_path / "source.png"
    src.write_bytes(png_bytes)
    monkeypatch.setattr(agent_mod, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_mod,
        "resolve_xai_credentials",
        lambda: agent_mod.XaiCredentials("tok", "https://api.x.ai/v1"),
    )

    out_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50).decode()
    mock_client = AsyncMock()
    mock_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="a blue circle on white"))]
    )
    mock_client.images.generate.return_value = MagicMock(
        data=[MagicMock(b64_json=out_b64, url=None)]
    )

    with patch("grok_image_agent.agent.AsyncOpenAI", return_value=mock_client):
        await agent_mod.grok_image_edit("add a red border", str(src))

    gen_prompt = mock_client.images.generate.call_args.kwargs["prompt"]
    assert "a blue circle on white" in gen_prompt
    assert "add a red border" in gen_prompt


# ── grok_image_compose ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_compose_no_credentials(monkeypatch):
    monkeypatch.setattr(agent_mod, "resolve_xai_credentials", lambda: None)
    result = await agent_mod.grok_image_compose("merge", ["/a.png", "/b.png"])
    assert result.startswith("Error: no xAI credentials")


@pytest.mark.asyncio
async def test_compose_two_images_uses_ordinals(tmp_path, monkeypatch):
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    img1 = tmp_path / "a.png"
    img2 = tmp_path / "b.png"
    img1.write_bytes(png_bytes)
    img2.write_bytes(png_bytes)
    monkeypatch.setattr(agent_mod, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_mod,
        "resolve_xai_credentials",
        lambda: agent_mod.XaiCredentials("tok", "https://api.x.ai/v1"),
    )

    out_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50).decode()
    mock_client = AsyncMock()
    mock_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="desc"))]
    )
    mock_client.images.generate.return_value = MagicMock(
        data=[MagicMock(b64_json=out_b64, url=None)]
    )

    with patch("grok_image_agent.agent.AsyncOpenAI", return_value=mock_client):
        result = await agent_mod.grok_image_compose(
            "merge them", [str(img1), str(img2)]
        )

    assert result.startswith("path:")
    gen_prompt = mock_client.images.generate.call_args.kwargs["prompt"]
    assert "First image:" in gen_prompt
    assert "Second image:" in gen_prompt
    assert "merge them" in gen_prompt


@pytest.mark.asyncio
async def test_compose_first_image_error_returns_early(tmp_path, monkeypatch):
    monkeypatch.setattr(
        agent_mod,
        "resolve_xai_credentials",
        lambda: agent_mod.XaiCredentials("tok", "https://api.x.ai/v1"),
    )
    with patch("grok_image_agent.agent.AsyncOpenAI"):
        result = await agent_mod.grok_image_compose(
            "merge", ["/nonexistent/a.png", "/nonexistent/b.png"]
        )
    assert "image not found" in result


@pytest.mark.asyncio
async def test_compose_updates_last_image(tmp_path, monkeypatch):
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    img1 = tmp_path / "a.png"
    img2 = tmp_path / "b.png"
    img1.write_bytes(png_bytes)
    img2.write_bytes(png_bytes)
    monkeypatch.setattr(agent_mod, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_mod,
        "resolve_xai_credentials",
        lambda: agent_mod.XaiCredentials("tok", "https://api.x.ai/v1"),
    )

    out_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50).decode()
    mock_client = AsyncMock()
    mock_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content="desc"))]
    )
    mock_client.images.generate.return_value = MagicMock(
        data=[MagicMock(b64_json=out_b64, url=None)]
    )

    with patch("grok_image_agent.agent.AsyncOpenAI", return_value=mock_client):
        await agent_mod.grok_image_compose("merge", [str(img1), str(img2)])

    assert agent_mod._last_image is not None
