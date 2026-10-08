# FrameForge

AI storyboard / video editor that sits **on top of** your existing **QwenEdit** and **ComfyUI** installs. It does not modify, replace, or auto-start those services.

## What it does

- **Media pool** — generated images and clips land here automatically
- **Timeline** — X axis is seconds; keyframes are vertical pins you can drag, copy via re-drop, and select in pairs
- **Preview** — storyboard playback (hold keyframe until the next) plus video clips in gaps
- **Base image** — T2I via ComfyUI using the same API graph stack as your **T2IV3.5** workflow
- **Edit / between** — delegates to **QwenEdit** on port `8741`
- **Video between keyframes** — ComfyUI **I2VV2** / MiniMax H3; clip length = timeline gap

## VRAM safety

- FrameForge **never** starts ComfyUI or QwenEdit
- By default `generation.require_idle_gpu` refuses to queue if either service reports a busy GPU/queue
- Health checks are lightweight HTTP pings only
- You choose when to click Generate

## Quick start

```bat
run.bat
```

Or manually:

```bat
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m frameforge

cd ..
npm install
npm run dev
```

Open http://127.0.0.1:5173 — API at http://127.0.0.1:8765

## Config

Edit `config.json` for ComfyUI/QwenEdit URLs and T2I/H3 defaults. Workflow JSON paths are referenced for documentation; runtime uses programmatic API graphs matched to your T2IV3.5 / I2VV2 setup (same approach as AICOM2).

## Project files

Timeline state lives in `projects/<id>/project.json` with assets in `projects/<id>/assets/`.
