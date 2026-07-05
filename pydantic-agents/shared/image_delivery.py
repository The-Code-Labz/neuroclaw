"""image_delivery.py — deliver generated images to local uploads dir and/or Supabase.

Exports:
    deliver_image(source_path: str) -> DeliveryResult
"""
from __future__ import annotations

import logging
import mimetypes
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class DeliveryResult:
    local_path: str
    local_url: Optional[str]
    public_url: Optional[str]


def deliver_image(source_path: str) -> DeliveryResult:
    """Copy image to uploads dir and/or upload to Supabase. Never raises.

    Returns DeliveryResult with local_path always set. local_url and public_url
    are None when the relevant config is absent or any step fails.
    """
    result = DeliveryResult(local_path=source_path, local_url=None, public_url=None)

    uploads_dir = os.environ.get("NEUROCLAW_UPLOADS_DIR", "").strip()
    dashboard_url = os.environ.get("NEUROCLAW_DASHBOARD_URL", "").strip()
    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    bucket = os.environ.get("SUPABASE_IMAGES_BUCKET", "neuroclaw-images").strip()

    if not uploads_dir and not supabase_url:
        logger.info("Image delivery not configured — returning file path only")
        return result

    # ── Local copy ────────────────────────────────────────────────────────────
    if uploads_dir:
        result = _copy_local(result, uploads_dir, dashboard_url)

    # ── Supabase upload ───────────────────────────────────────────────────────
    if supabase_url and supabase_key:
        result = _upload_supabase(result, supabase_url, supabase_key, bucket)

    return result


def _copy_local(result: DeliveryResult, uploads_dir: str, dashboard_url: str) -> DeliveryResult:
    try:
        dest_dir = Path(uploads_dir) / "images"
        dest_dir.mkdir(parents=True, exist_ok=True)

        src = Path(result.local_path)
        dest_filename = src.name
        dest_path = dest_dir / dest_filename

        # Collision-safe: insert 4-char UUID suffix if destination already exists
        if dest_path.exists():
            suffix = uuid.uuid4().hex[:4]
            dest_filename = f"{src.stem}_{suffix}{src.suffix}"
            dest_path = dest_dir / dest_filename

        shutil.copy2(str(src), str(dest_path))
        result.local_path = str(dest_path)

        if not dashboard_url:
            logger.warning(
                "NEUROCLAW_UPLOADS_DIR is set but NEUROCLAW_DASHBOARD_URL is missing "
                "— local_url will be None"
            )
        else:
            result.local_url = f"{dashboard_url.rstrip('/')}/uploads/images/{dest_filename}"
    except Exception as exc:
        logger.warning("Local image copy failed: %s", exc)
    return result


def _upload_supabase(
    result: DeliveryResult,
    supabase_url: str,
    supabase_key: str,
    bucket: str,
) -> DeliveryResult:
    try:
        from supabase import create_client  # lazy import — only runs when configured
    except ImportError:
        logger.warning("supabase package not installed — skipping Supabase upload")
        return result

    try:
        mime_type = mimetypes.guess_type(result.local_path)[0] or "application/octet-stream"
        filename = Path(result.local_path).name
        file_bytes = Path(result.local_path).read_bytes()

        client = create_client(supabase_url, supabase_key)
        client.storage.from_(bucket).upload(
            filename,
            file_bytes,
            {"content-type": mime_type, "upsert": "true"},
        )
        result.public_url = client.storage.from_(bucket).get_public_url(filename)
    except Exception as exc:
        logger.warning("Supabase upload failed: %s", exc)
    return result
