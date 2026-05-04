#!/usr/bin/env python3
"""
NanoBanana 2 — Image Generation & Editing Script
Model: Gemini 3.1 Flash Image Preview

Simple wrapper for the NanoBanana 2 API to generate and edit images.
No more curl commands — just run this script.

Usage:
    python nanobanana2.py generate "A futuristic robot chef" --output robot.png
    python nanobanana2.py generate "Cyberpunk city" --style anime --resolution 2K --aspect 16:9
    python nanobanana2.py edit "Make the sky purple" --image https://example.com/image.png
    python nanobanana2.py edit "Add a sunset" --image ./local.png --output edited.png
"""

import argparse
import base64
import json
import sys
import os
import urllib.request
import urllib.error
from pathlib import Path

# API Configuration
API_BASE_URL = "https://zghabnpyooyewzmsewwp.supabase.co/functions/v1/api-gateway/v1"
API_KEY = "nb_k3vdTQdP7VEGoGSuezD2D03weMrq5dAqyJOWXG9NB9xavYCF"

# Valid options
VALID_STYLES = ["none", "realistic", "artistic", "anime", "manga", "digital-art"]
VALID_RESOLUTIONS = ["STANDARD", "2K"]  # 4K disabled
VALID_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"]


def api_request(endpoint, data):
    """Make an API request and return JSON response."""
    url = "{}/{}".format(API_BASE_URL, endpoint)
    headers = {
        "Authorization": "Bearer {}".format(API_KEY),
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; OpenClaw/1.0)"
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers=headers,
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        try:
            error_json = json.loads(error_body)
            print("[ERROR] API error: {}".format(error_json.get("message", error_body)), file=sys.stderr)
        except json.JSONDecodeError:
            print("[ERROR] API error ({}): {}".format(e.code, error_body), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print("[ERROR] Network error: {}".format(e.reason), file=sys.stderr)
        sys.exit(1)


def download_image(url, output_path):
    """Download image from URL to file."""
    headers = {"User-Agent": "Mozilla/5.0 (compatible; OpenClaw/1.0)"}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            with open(output_path, "wb") as f:
                f.write(response.read())
    except Exception as e:
        print("[ERROR] Failed to download image: {}".format(e), file=sys.stderr)
        sys.exit(1)


def image_to_base64(image_path):
    """Convert local image to base64 data URL."""
    path = Path(image_path)
    if not path.exists():
        print("[ERROR] Image not found: {}".format(image_path), file=sys.stderr)
        sys.exit(1)
    
    ext = path.suffix.lower()
    mime_types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp"
    }
    mime_type = mime_types.get(ext, "image/png")
    
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
    
    return "data:{};base64,{}".format(mime_type, b64)


def generate(args):
    """Generate an image from a text prompt."""
    data = {"prompt": args.prompt}
    
    if args.style and args.style != "none":
        data["style"] = args.style
    if args.resolution:
        data["resolution"] = args.resolution
    if args.aspect:
        data["aspect_ratio"] = args.aspect
    
    print("[INFO] Generating image...", file=sys.stderr)
    result = api_request("generate", data)
    
    image_url = result.get("url")
    if not image_url:
        print("[ERROR] No image URL in response: {}".format(result), file=sys.stderr)
        sys.exit(1)
    
    output_path = args.output or "output.png"
    download_image(image_url, output_path)
    print("[OK] Image saved: {}".format(output_path), file=sys.stderr)
    print("MEDIA:{}".format(output_path))
    print("[INFO] URL: {}".format(image_url), file=sys.stderr)


def edit(args):
    """Edit an existing image with AI."""
    data = {"prompt": args.prompt}
    
    if args.image.startswith("http://") or args.image.startswith("https://"):
        data["image_url"] = args.image
    else:
        data["image_url"] = image_to_base64(args.image)
    
    if args.resolution:
        data["resolution"] = args.resolution
    if args.aspect:
        data["aspect_ratio"] = args.aspect
    
    print("[INFO] Editing image...", file=sys.stderr)
    result = api_request("edit", data)
    
    image_url = result.get("url")
    if not image_url:
        print("[ERROR] No image URL in response: {}".format(result), file=sys.stderr)
        sys.exit(1)
    
    output_path = args.output or "edited.png"
    download_image(image_url, output_path)
    print("[OK] Image saved: {}".format(output_path), file=sys.stderr)
    print("MEDIA:{}".format(output_path))
    print("[INFO] URL: {}".format(image_url), file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="NanoBanana 2 — AI Image Generation & Editing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python nanobanana2.py generate "A red sports car"
  python nanobanana2.py generate "Cyberpunk scene" --style anime --resolution 2K
  python nanobanana2.py edit "Make it sunset" --image ./photo.png

Styles: none, realistic, artistic, anime, manga, digital-art
Resolutions: STANDARD, 2K
Aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 4:5, 5:4, 21:9
        """
    )
    
    subparsers = parser.add_subparsers(dest="command")
    
    # Generate command
    gen_parser = subparsers.add_parser("generate", help="Generate image from text prompt")
    gen_parser.add_argument("prompt", help="Text description of the image")
    gen_parser.add_argument("--output", "-o", help="Output file path (default: output.png)")
    gen_parser.add_argument("--style", "-s", choices=VALID_STYLES, help="Image style")
    gen_parser.add_argument("--resolution", "-r", choices=VALID_RESOLUTIONS, help="Output resolution")
    gen_parser.add_argument("--aspect", "-a", choices=VALID_ASPECT_RATIOS, help="Aspect ratio")
    gen_parser.set_defaults(func=generate)
    
    # Edit command
    edit_parser = subparsers.add_parser("edit", help="Edit an existing image")
    edit_parser.add_argument("prompt", help="Edit instructions")
    edit_parser.add_argument("--image", "-i", required=True, help="Source image (URL or local path)")
    edit_parser.add_argument("--output", "-o", help="Output file path (default: edited.png)")
    edit_parser.add_argument("--resolution", "-r", choices=VALID_RESOLUTIONS, help="Output resolution")
    edit_parser.add_argument("--aspect", "-a", choices=VALID_ASPECT_RATIOS, help="Aspect ratio")
    edit_parser.set_defaults(func=edit)
    
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)
    args.func(args)


if __name__ == "__main__":
    main()
