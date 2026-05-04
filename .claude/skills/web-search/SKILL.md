---
name: web-search
description: "Search the web using SearXNG metasearch. Use when you need current information, news, research, images, videos, or any web content. Supports categories: general, news, images, videos, files, music, it, science, social media."
scripts: [search.py]
---
# Web Search (SearXNG)

Search the web via SearXNG metasearch engine. Aggregates results from multiple search engines (DuckDuckGo, Brave, Bing, Wikipedia, etc.) in a single query.

## Quick Start

```bash
python ~/.claude/skills/web-search/scripts/search.py "your query here"
```

## Usage

```bash
# Basic web search
python scripts/search.py "open source AI frameworks"

# Category-specific searches
python scripts/search.py "climate change" --category news
python scripts/search.py "sunset mountains" --category images
python scripts/search.py "python tutorial" --category videos

# Time-filtered news
python scripts/search.py "tech layoffs" --category news --time day

# Pagination
python scripts/search.py "machine learning" --page 2

# Limit results
python scripts/search.py "rust programming" --limit 5
```

## Categories

| Category | Use For |
|----------|---------|
| `general` | Web pages, articles, documentation (default) |
| `news` | Current events, articles with dates |
| `images` | Photos, graphics, visual content |
| `videos` | Video content with thumbnails/duration |
| `files` | Documents, downloads, torrents |
| `music` | Tracks, artists, albums |
| `it` | Programming Q&A, package registries |
| `science` | Academic papers, research |
| `social media` | Posts, profiles |

## Options

| Flag | Values | Description |
|------|--------|-------------|
| `--category`, `-c` | general, news, images, videos, files, music, it, science | Search category |
| `--time`, `-t` | day, month, year | Time range filter |
| `--page`, `-p` | 1, 2, 3... | Page number |
| `--limit`, `-l` | integer | Max results to return |
| `--language` | en-US, de-DE, etc. | Language filter |
| `--json` | flag | Output raw JSON |

## Output Format

**General/News results:**
```
[1] Title of the Result
    https://example.com/page
    Snippet or description text...
    Source: example.com | Engine: duckduckgo
```

**Image results:**
```
[1] Image Title
    Page: https://example.com/gallery
    Image: https://example.com/image.jpg
    Source: example.com
```

## Notes

- Results are deduplicated across engines
- Not all engines support all filters (time_range, pagination)
- Some engines may be unresponsive — check the summary line
- Image URLs may need `https:` prefix if protocol-relative
