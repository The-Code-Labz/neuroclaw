---
name: nanobanana-2-image-gen
description: generate images using nano banana 2
tools: [run_skill_script]
scripts: [nanobanana2.py]
---
## Purpose
generate images using nano banana 2

## How to use
Call `run_skill_script(skill_name="nanobanana-2-image-gen", script="nanobanana-2-image-gen", args=[...])` with whatever arguments the script needs.
Stdout/stderr come back as text — read them, then summarise the result for the user.

## nanobanana2.py — Image Generation

Generate and edit images using the NanoBanana 2 API (Gemini 3.1 Flash Image).

### Quick Start

```bash
# Generate an image
python nanobanana2.py generate "A futuristic robot chef" --output robot.png

# Generate with style and options
python nanobanana2.py generate "Cyberpunk city" --style anime --resolution 2K --aspect 16:9

# Edit an image from URL
python nanobanana2.py edit "Make the sky purple" --image https://example.com/image.png

# Edit a local image
python nanobanana2.py edit "Add a sunset" --image ./local.png --output edited.png
```

### Options

| Option | Values | Description |
|--------|--------|-------------|
| `--style` | none, realistic, artistic, anime, manga, digital-art | Image style |
| `--resolution` | STANDARD, 2K | Output resolution (4K disabled) |
| `--aspect` | 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 4:5, 5:4, 21:9 | Aspect ratio |
| `--output` | path | Output file path |
