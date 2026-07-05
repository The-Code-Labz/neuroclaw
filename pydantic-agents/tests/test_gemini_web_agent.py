"""Tests for gemini_web_agent.agent — MIME check, image memory tools,
and mocked versions of gemini_search and gemini_edit_image."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import gemini_web_agent.agent as agent_mod


@pytest.fixture(autouse=True)
def reset_memory():
    """Reset module-level memory state between every test."""
    agent_mod._image_memory.clear()
    yield
    agent_mod._image_memory.clear()


# ── _get_mime ──────────────────────────────────────────────────────────────────

def test_get_mime_png(tmp_path):
    f = tmp_path / "img.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    assert agent_mod._get_mime(str(f)) == "image/png"


def test_get_mime_jpeg(tmp_path):
    f = tmp_path / "img.jpg"
    f.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
    assert agent_mod._get_mime(str(f)) == "image/jpeg"


def test_get_mime_unknown(tmp_path):
    f = tmp_path / "img.webp"
    f.write_bytes(b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 100)
    assert agent_mod._get_mime(str(f)) is None


def test_get_mime_missing_file():
    assert agent_mod._get_mime("/does/not/exist.png") is None


# ── gemini_remember_image ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_remember_stores_abs_path(tmp_path):
    f = tmp_path / "test.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n")
    result = await agent_mod.gemini_remember_image(str(f), "hero")
    assert "hero" in result
    assert str(f) in result
    assert agent_mod._image_memory["hero"] == str(f)


@pytest.mark.asyncio
async def test_remember_rejects_empty_label(tmp_path):
    f = tmp_path / "test.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n")
    result = await agent_mod.gemini_remember_image(str(f), "")
    assert result.startswith("Error:")
    assert "empty" in result


@pytest.mark.asyncio
async def test_remember_rejects_whitespace_label(tmp_path):
    f = tmp_path / "test.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n")
    result = await agent_mod.gemini_remember_image(str(f), "   ")
    assert result.startswith("Error:")


@pytest.mark.asyncio
async def test_remember_rejects_missing_file():
    result = await agent_mod.gemini_remember_image("/no/such/file.png", "x")
    assert result.startswith("Error:")
    assert "not found" in result


# ── gemini_recall_image ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_recall_returns_stored_path(tmp_path):
    f = tmp_path / "img.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n")
    await agent_mod.gemini_remember_image(str(f), "bg")
    result = await agent_mod.gemini_recall_image("bg")
    assert result == str(f)


@pytest.mark.asyncio
async def test_recall_missing_label():
    result = await agent_mod.gemini_recall_image("nonexistent")
    assert result.startswith("Error:")
    assert "nonexistent" in result


@pytest.mark.asyncio
async def test_recall_empty_label():
    result = await agent_mod.gemini_recall_image("")
    assert result.startswith("Error:")
    assert "empty" in result


# ── _wait_for_text_response ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_wait_for_text_response_stable_text():
    """Two identical polls should resolve with the answer."""
    page = MagicMock()
    page.wait_for_selector = AsyncMock(side_effect=Exception("skip"))

    async def mock_qsa(sel):
        el = MagicMock()
        el.inner_text = AsyncMock(return_value="Paris is the capital of France.")
        return [el] if "p" in sel else []

    page.query_selector_all = mock_qsa

    with patch.object(agent_mod, "_wait_for_stop_button_gone", new=AsyncMock()):
        result = await agent_mod._wait_for_text_response(page)

    assert result.startswith("answer: Paris is the capital of France.")


@pytest.mark.asyncio
async def test_wait_for_text_response_refusal():
    """Refusal phrases should be returned as REFUSAL:<text>."""
    page = MagicMock()
    page.wait_for_selector = AsyncMock(side_effect=Exception("skip"))

    async def mock_qsa(sel):
        el = MagicMock()
        el.inner_text = AsyncMock(return_value="I can't help with that request.")
        return [el] if "p" in sel else []

    page.query_selector_all = mock_qsa

    with patch.object(agent_mod, "_wait_for_stop_button_gone", new=AsyncMock()):
        result = await agent_mod._wait_for_text_response(page)

    assert result.startswith("REFUSAL:")


# ── gemini_search ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_gemini_search_no_profile(monkeypatch):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: False)
    result = await agent_mod.gemini_search("test query")
    assert result.startswith("Error:")
    assert "gemini_setup" in result


@pytest.mark.asyncio
async def test_gemini_search_session_expired(monkeypatch):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: True)

    async def fake_ensure(page):
        raise RuntimeError("session_expired")

    page = MagicMock()
    page.goto = AsyncMock()

    with patch.object(agent_mod, "_get_gen_context", new=AsyncMock(return_value=(MagicMock(), MagicMock()))), \
         patch.object(agent_mod, "_get_or_open_page", new=AsyncMock(return_value=page)), \
         patch.object(agent_mod, "_ensure_gemini_ready", new=fake_ensure):
        result = await agent_mod.gemini_search("what is python")

    assert "session expired" in result


@pytest.mark.asyncio
async def test_gemini_search_returns_answer(monkeypatch):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: True)
    page = MagicMock()
    page.goto = AsyncMock()

    with patch.object(agent_mod, "_get_gen_context", new=AsyncMock(return_value=(MagicMock(), MagicMock()))), \
         patch.object(agent_mod, "_get_or_open_page", new=AsyncMock(return_value=page)), \
         patch.object(agent_mod, "_ensure_gemini_ready", new=AsyncMock()), \
         patch.object(agent_mod, "_submit_prompt", new=AsyncMock()), \
         patch.object(agent_mod, "_wait_for_text_response", new=AsyncMock(return_value="answer: Python is a language.")):
        result = await agent_mod.gemini_search("what is python")

    assert result == "answer: Python is a language."


@pytest.mark.asyncio
async def test_gemini_search_timeout_resets_context(monkeypatch):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: True)
    page = MagicMock()
    page.goto = AsyncMock()
    reset_called = []

    async def fake_reset():
        reset_called.append(True)

    with patch.object(agent_mod, "_get_gen_context", new=AsyncMock(return_value=(MagicMock(), MagicMock()))), \
         patch.object(agent_mod, "_get_or_open_page", new=AsyncMock(return_value=page)), \
         patch.object(agent_mod, "_ensure_gemini_ready", new=AsyncMock()), \
         patch.object(agent_mod, "_submit_prompt", new=AsyncMock()), \
         patch.object(agent_mod, "_wait_for_text_response", new=AsyncMock(side_effect=asyncio.TimeoutError())), \
         patch.object(agent_mod, "_reset_gen_context", new=fake_reset):
        result = await agent_mod.gemini_search("slow query")

    assert "timed out" in result
    assert len(reset_called) == 1


# ── gemini_edit_image ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_edit_image_no_profile(monkeypatch):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: False)
    result = await agent_mod.gemini_edit_image("/some/img.png", "make it blue")
    assert result.startswith("Error:")
    assert "gemini_setup" in result


@pytest.mark.asyncio
async def test_edit_image_file_not_found(monkeypatch):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: True)
    result = await agent_mod.gemini_edit_image("/does/not/exist.png", "edit it")
    assert result.startswith("Error:")
    assert "not found" in result


@pytest.mark.asyncio
async def test_edit_image_unsupported_format(monkeypatch, tmp_path):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: True)
    f = tmp_path / "img.webp"
    f.write_bytes(b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 100)
    result = await agent_mod.gemini_edit_image(str(f), "edit it")
    assert result.startswith("Error:")
    assert "unsupported" in result


@pytest.mark.asyncio
async def test_edit_image_upload_failed(monkeypatch, tmp_path):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: True)
    f = tmp_path / "img.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    page = MagicMock()
    page.goto = AsyncMock()

    async def fail_upload(page, path):
        raise RuntimeError("upload_failed")

    with patch.object(agent_mod, "_get_gen_context", new=AsyncMock(return_value=(MagicMock(), MagicMock()))), \
         patch.object(agent_mod, "_get_or_open_page", new=AsyncMock(return_value=page)), \
         patch.object(agent_mod, "_ensure_gemini_ready", new=AsyncMock()), \
         patch.object(agent_mod, "_upload_file_to_gemini", new=fail_upload):
        result = await agent_mod.gemini_edit_image(str(f), "make it blue")

    assert "could not attach" in result


@pytest.mark.asyncio
async def test_edit_image_success(monkeypatch, tmp_path):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: True)
    f = tmp_path / "img.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    out = tmp_path / "result.png"
    out.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    page = MagicMock()
    page.goto = AsyncMock()
    page.keyboard = MagicMock()
    page.keyboard.type = AsyncMock()
    page.keyboard.press = AsyncMock()
    inp = MagicMock()
    inp.click = AsyncMock()

    with patch.object(agent_mod, "_get_gen_context", new=AsyncMock(return_value=(MagicMock(), MagicMock()))), \
         patch.object(agent_mod, "_get_or_open_page", new=AsyncMock(return_value=page)), \
         patch.object(agent_mod, "_ensure_gemini_ready", new=AsyncMock()), \
         patch.object(agent_mod, "_upload_file_to_gemini", new=AsyncMock()), \
         patch.object(agent_mod, "_find_input", new=AsyncMock(return_value=inp)), \
         patch.object(agent_mod, "_wait_for_and_save_image", new=AsyncMock(return_value=str(out))):
        result = await agent_mod.gemini_edit_image(str(f), "make background white")

    assert result.startswith("path:")
    assert "make background white" in result


@pytest.mark.asyncio
async def test_edit_image_timeout_resets_context(monkeypatch, tmp_path):
    monkeypatch.setattr(agent_mod, "_profile_exists", lambda: True)
    f = tmp_path / "img.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    page = MagicMock()
    page.goto = AsyncMock()
    page.keyboard = MagicMock()
    page.keyboard.type = AsyncMock()
    page.keyboard.press = AsyncMock()
    inp = MagicMock()
    inp.click = AsyncMock()
    reset_called = []

    async def fake_reset():
        reset_called.append(True)

    with patch.object(agent_mod, "_get_gen_context", new=AsyncMock(return_value=(MagicMock(), MagicMock()))), \
         patch.object(agent_mod, "_get_or_open_page", new=AsyncMock(return_value=page)), \
         patch.object(agent_mod, "_ensure_gemini_ready", new=AsyncMock()), \
         patch.object(agent_mod, "_upload_file_to_gemini", new=AsyncMock()), \
         patch.object(agent_mod, "_find_input", new=AsyncMock(return_value=inp)), \
         patch.object(agent_mod, "_wait_for_and_save_image", new=AsyncMock(side_effect=asyncio.TimeoutError())), \
         patch.object(agent_mod, "_reset_gen_context", new=fake_reset):
        result = await agent_mod.gemini_edit_image(str(f), "add snow")

    assert "timed out" in result
    assert len(reset_called) == 1
