# SideFX Labs VAT Player

A Babylon.js-based player for Vertex Animation Textures exported from Houdini's SideFX Labs tools.

## Quick Start

```bash
npm install
npm run build
```

Open `public/index.html` in a browser.

## Usage

1. **Load Mesh** — GLB/glTF exported from Houdini with UV2 channel
2. **Load Position Texture** — The `_pos.png` file from SideFX Labs VAT export
3. **Load Metadata** — The Unity `.mat` file (auto-fills bounds, frames, FPS)
4. **Apply VAT** → **Play**

## SideFX Labs Export Settings

In Houdini, use the **Labs Vertex Animation Textures** node:

- **Method**: Soft (for skeletal, cloth, soft body)
- **Export**: Position texture + mesh with UV2
- **Target Engine**: Unity (exports `.mat` metadata file)

## File Reference

| SideFX Export | Use in Player |
|---------------|---------------|
| `*_mesh.fbx` → convert to GLB | Mesh input |
| `*_pos.png` | Position Texture |
| `*_norm.png` (optional) | Normal Texture |
| `*_mat.mat` | Metadata input |

## How It Works

The player uses a custom vertex shader that:
1. Reads vertex index from **UV2** (pre-computed by SideFX Labs)
2. Samples position from texture at `(UV2.x, UV2.y + frame/numFrames)`
3. Decodes position using bounds: `pos = min + (max - min) * textureSample`
4. Adds decoded position as offset to the rest pose

## Development

```bash
npm run dev    # Watch mode with live server
npm run build  # Production build
```

## License

MIT
