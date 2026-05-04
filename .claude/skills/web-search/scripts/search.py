#!/usr/bin/env python3
"""SearXNG web search tool for NeuroClaw agents.

Searches the web via SearXNG metasearch proxy.

Usage:
    python search.py "query" [options]
    
Examples:
    python search.py "open source AI"
    python search.py "climate news" --category news --time day
    python search.py "python logo" --category images --limit 5
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
import urllib.error
from typing import Any

# Proxy endpoint and credentials
PROXY_URL = "https://gpugbzwexfkrmmbmvofs.supabase.co/functions/v1/searx-proxy"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwdWdiendleGZrcm1tYm12b2ZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjE3ODksImV4cCI6MjA5MjEzNzc4OX0.mG72NyeXsyEa4SokRINQmQuynFdy_XoHZwZpzZtPzeI"

CATEGORIES = [
    "general", "news", "images", "videos", "files",
    "music", "it", "science", "social media", "map"
]

TIME_RANGES = ["day", "month", "year"]


def search(query: str, category: str = "general", time_range: str | None = None,
           page: int = 1, language: str | None = None, limit: int | None = None) -> dict[str, Any]:
    """Execute a search query against SearXNG.
    
    Args:
        query: Search query string
        category: Search category (general, news, images, etc.)
        time_range: Time filter (day, month, year)
        page: Page number (1-based)
        language: Language code (e.g., en-US)
        limit: Max results to return (applied client-side)
    
    Returns:
        SearXNG response dict with results, suggestions, etc.
    """
    params = {
        "q": query,
        "format": "json",
        "categories": category,
        "pageno": str(page),
    }
    
    if time_range:
        params["time_range"] = time_range
    if language:
        params["language"] = language
    
    url = f"{PROXY_URL}?{urllib.parse.urlencode(params)}"
    
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    })
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Search failed (HTTP {e.code}): {error_body}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}")
    
    # Apply client-side limit if specified
    if limit and "results" in data:
        data["results"] = data["results"][:limit]
    
    return data


def format_general_result(idx: int, r: dict) -> str:
    """Format a general/news/it/science result."""
    lines = [f"[{idx}] {r.get('title', 'No title')}"]
    lines.append(f"    {r.get('url', 'No URL')}")
    if content := r.get("content"):
        # Truncate long snippets
        if len(content) > 200:
            content = content[:200] + "..."
        lines.append(f"    {content}")
    
    meta = []
    if source := r.get("source") or r.get("pretty_url", "").split("/")[0]:
        meta.append(f"Source: {source}")
    if engine := r.get("engine"):
        meta.append(f"Engine: {engine}")
    if date := r.get("publishedDate"):
        meta.append(f"Date: {date}")
    if meta:
        lines.append(f"    {' | '.join(meta)}")
    
    return "\n".join(lines)


def format_image_result(idx: int, r: dict) -> str:
    """Format an image result."""
    lines = [f"[{idx}] {r.get('title', 'No title')}"]
    lines.append(f"    Page: {r.get('url', 'No URL')}")
    
    img_url = r.get("img_src") or r.get("thumbnail_src", "")
    # Fix protocol-relative URLs
    if img_url.startswith("//"):
        img_url = "https:" + img_url
    if img_url:
        lines.append(f"    Image: {img_url}")
    
    if res := r.get("resolution"):
        lines.append(f"    Resolution: {res}")
    if source := r.get("source"):
        lines.append(f"    Source: {source}")
    
    return "\n".join(lines)


def format_video_result(idx: int, r: dict) -> str:
    """Format a video result."""
    lines = [f"[{idx}] {r.get('title', 'No title')}"]
    lines.append(f"    {r.get('url', 'No URL')}")
    
    meta = []
    if duration := r.get("duration"):
        meta.append(f"Duration: {duration}")
    if source := r.get("source"):
        meta.append(f"Source: {source}")
    if meta:
        lines.append(f"    {' | '.join(meta)}")
    
    if content := r.get("content"):
        if len(content) > 150:
            content = content[:150] + "..."
        lines.append(f"    {content}")
    
    return "\n".join(lines)


def format_file_result(idx: int, r: dict) -> str:
    """Format a file/download result."""
    lines = [f"[{idx}] {r.get('title', 'No title')}"]
    lines.append(f"    {r.get('url', 'No URL')}")
    
    meta = []
    if size := r.get("filesize"):
        meta.append(f"Size: {size}")
    if ftype := r.get("filetype"):
        meta.append(f"Type: {ftype}")
    if source := r.get("source"):
        meta.append(f"Source: {source}")
    if meta:
        lines.append(f"    {' | '.join(meta)}")
    
    return "\n".join(lines)


def format_results(data: dict, category: str) -> str:
    """Format search results for display."""
    results = data.get("results", [])
    
    if not results:
        unresponsive = data.get("unresponsive_engines", [])
        msg = "No results found."
        if unresponsive:
            msg += f" ({len(unresponsive)} engines unresponsive)"
        return msg
    
    # Choose formatter based on category
    if category == "images":
        formatter = format_image_result
    elif category == "videos":
        formatter = format_video_result
    elif category == "files":
        formatter = format_file_result
    else:
        formatter = format_general_result
    
    lines = []
    for idx, r in enumerate(results, 1):
        lines.append(formatter(idx, r))
        lines.append("")  # blank line between results
    
    # Summary line
    summary_parts = [f"{len(results)} results"]
    if suggestions := data.get("suggestions"):
        summary_parts.append(f"Suggestions: {', '.join(suggestions[:3])}")
    if unresponsive := data.get("unresponsive_engines"):
        summary_parts.append(f"{len(unresponsive)} engines unresponsive")
    
    lines.append(f"--- {' | '.join(summary_parts)} ---")
    
    # Answers (direct answers like calculations)
    if answers := data.get("answers"):
        lines.insert(0, f"Answer: {answers[0] if isinstance(answers[0], str) else answers[0].get('answer', '')}")
        lines.insert(1, "")
    
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Search the web via SearXNG metasearch",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  %(prog)s "open source AI"
  %(prog)s "climate change" --category news --time day
  %(prog)s "python logo" --category images --limit 5
  %(prog)s "machine learning papers" --category science
"""
    )
    parser.add_argument("query", help="Search query")
    parser.add_argument("-c", "--category", default="general",
                        choices=CATEGORIES, help="Search category (default: general)")
    parser.add_argument("-t", "--time", dest="time_range",
                        choices=TIME_RANGES, help="Time range filter")
    parser.add_argument("-p", "--page", type=int, default=1,
                        help="Page number (default: 1)")
    parser.add_argument("-l", "--limit", type=int,
                        help="Max results to return")
    parser.add_argument("--language", help="Language code (e.g., en-US)")
    parser.add_argument("--json", action="store_true",
                        help="Output raw JSON response")
    
    args = parser.parse_args()
    
    try:
        data = search(
            query=args.query,
            category=args.category,
            time_range=args.time_range,
            page=args.page,
            language=args.language,
            limit=args.limit,
        )
        
        if args.json:
            print(json.dumps(data, indent=2))
        else:
            print(format_results(data, args.category))
            
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
