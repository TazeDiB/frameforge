"""FrameForge API server."""
from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any, Optional

import uvicorn
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .comfy_client import ComfyClient
from .config import DIST_DIR, PROJECTS_DIR, load_config
from .jobs import jobs
from .project_store import (
    assets_dir,
    delete_asset,
    delete_project,
    import_asset_file,
    list_projects,
    load_project,
    new_project,
    public_project,
    save_project,
)
from .qwenedit_client import QwenEditClient

app = FastAPI(title="FrameForge", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    jobs.start()


@app.get("/api/health")
async def health() -> dict[str, Any]:
    """Lightweight ping — does not queue GPU work."""
    cfg = load_config()
    comfy = ComfyClient(str((cfg.get("comfyui") or {}).get("base_url") or "http://127.0.0.1:8188"))
    qwen = QwenEditClient(str((cfg.get("qwenedit") or {}).get("base_url") or "http://127.0.0.1:8741"))
    try:
        comfy_status = await comfy.ping_status()
        qwen_status = await qwen.ping_status()
        comfy_busy = await comfy.is_busy() if comfy_status != "down" else False
    finally:
        await comfy.aclose()
        await qwen.aclose()
    return {
        "ok": True,
        "comfyui": comfy_status,
        "comfy_busy": comfy_busy,
        "qwenedit": qwen_status,
        "jobs": jobs.public_jobs(),
        "require_idle_gpu": bool(cfg.get("generation", {}).get("require_idle_gpu", True)),
    }


@app.get("/api/projects")
async def api_list_projects() -> dict[str, Any]:
    return {"projects": list_projects()}


@app.post("/api/projects")
async def api_create_project(body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    name = str(body.get("name") or "Untitled")
    return new_project(name)


@app.get("/api/projects/{project_id}")
async def api_get_project(project_id: str) -> dict[str, Any]:
    try:
        return public_project(load_project(project_id), full=True)
    except FileNotFoundError as e:
        raise HTTPException(404, "project not found") from e


@app.put("/api/projects/{project_id}")
async def api_update_project(project_id: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    try:
        data = load_project(project_id)
    except FileNotFoundError as e:
        raise HTTPException(404, "project not found") from e
    for key in ("name", "fps", "duration", "keyframes", "clips", "assets", "settings", "prompt_segments"):
        if key in body:
            data[key] = body[key]
    save_project(data)
    return public_project(data, full=True)


@app.delete("/api/projects/{project_id}")
async def api_delete_project(project_id: str) -> dict[str, Any]:
    delete_project(project_id)
    return {"ok": True, "id": project_id}


@app.get("/api/projects/{project_id}/assets/{filename}")
async def api_asset_file(project_id: str, filename: str) -> FileResponse:
    path = assets_dir(project_id) / Path(filename).name
    if not path.is_file():
        raise HTTPException(404, "asset not found")
    media = "video/mp4" if path.suffix.lower() in {".mp4", ".webm"} else "image/png"
    return FileResponse(path, media_type=media)


@app.post("/api/projects/{project_id}/import")
async def api_import_asset(
    project_id: str,
    file: UploadFile = File(...),
    label: str = Form(""),
) -> dict[str, Any]:
    try:
        load_project(project_id)
    except FileNotFoundError as e:
        raise HTTPException(404, "project not found") from e
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    if len(data) > 80 * 1024 * 1024:
        raise HTTPException(400, "file too large (80MB max)")
    try:
        asset = import_asset_file(
            project_id,
            data,
            Path(file.filename or "import.png").name,
            label=label.strip(),
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "asset": asset, "project": public_project(load_project(project_id), full=True)}


@app.delete("/api/projects/{project_id}/assets/{asset_id}")
async def api_delete_asset(project_id: str, asset_id: str) -> dict[str, Any]:
    try:
        load_project(project_id)
    except FileNotFoundError as e:
        raise HTTPException(404, "project not found") from e
    updated = delete_asset(project_id, asset_id)
    return {"ok": True, "id": asset_id, "project": updated}


@app.get("/api/jobs")
async def api_jobs() -> dict[str, Any]:
    return {"jobs": jobs.public_jobs()}


@app.get("/api/jobs/{job_id}")
async def api_job(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {k: v for k, v in job.items() if not k.startswith("_")}


def _job_base(project_id: str, kind: str, prompt: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": uuid.uuid4().hex[:10],
        "project_id": project_id,
        "kind": kind,
        "prompt": prompt,
        "status": "queued",
        "created": time.time(),
        **extra,
    }


@app.post("/api/projects/{project_id}/generate/t2i")
async def api_generate_t2i(project_id: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    try:
        load_project(project_id)
    except FileNotFoundError as e:
        raise HTTPException(404, "project not found") from e
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "prompt required")
    job = _job_base(project_id, "t2i", prompt, place_at=body.get("place_at"))
    try:
        await jobs.enqueue(job, {
            "project_id": project_id,
            "prompt": prompt,
            "seed": body.get("seed"),
            "config": body.get("config") or {},
        })
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {k: v for k, v in job.items() if not k.startswith("_")}


@app.post("/api/projects/{project_id}/generate/edit")
async def api_generate_edit(project_id: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    try:
        load_project(project_id)
    except FileNotFoundError as e:
        raise HTTPException(404, "project not found") from e
    source_file = str(body.get("source_file") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    if not source_file or not prompt:
        raise HTTPException(400, "source_file and prompt required")
    job = _job_base(
        project_id,
        "edit",
        prompt,
        place_at=body.get("place_at"),
        parent_asset_id=body.get("parent_asset_id"),
    )
    try:
        await jobs.enqueue(job, {
            "project_id": project_id,
            "source_file": source_file,
            "prompt": prompt,
            "user_prompt": body.get("user_prompt"),
            "between": bool(body.get("between")),
            "seed": body.get("seed"),
            "config": body.get("config") or {},
            "parent_asset_id": body.get("parent_asset_id"),
        })
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {k: v for k, v in job.items() if not k.startswith("_")}


@app.post("/api/projects/{project_id}/generate/between")
async def api_generate_between(project_id: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    left_id = str(body.get("left_asset_id") or "")
    right_id = str(body.get("right_asset_id") or "")
    data = load_project(project_id)
    assets = {a["id"]: a for a in data.get("assets") or []}
    left = assets.get(left_id)
    right = assets.get(right_id)
    if not left or not right:
        raise HTTPException(400, "left and right assets required")
    user_prompt = str(body.get("prompt") or "").strip()
    job = _job_base(project_id, "edit", user_prompt or "In-between keyframe", place_at=body.get("place_at"))
    try:
        await jobs.enqueue(job, {
            "project_id": project_id,
            "source_file": left["file"],
            "prompt": user_prompt,
            "user_prompt": user_prompt,
            "between": True,
            "config": body.get("config") or {},
            "parent_asset_id": left_id,
            "ref_asset_id": right_id,
        })
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {k: v for k, v in job.items() if not k.startswith("_")}


@app.post("/api/projects/{project_id}/generate/video")
async def api_generate_video(project_id: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    data = load_project(project_id)
    assets = {a["id"]: a for a in data.get("assets") or []}
    first_asset_id = str(body.get("first_asset_id") or "")
    last_asset_id = str(body.get("last_asset_id") or "")
    first = assets.get(first_asset_id)
    last = assets.get(last_asset_id)
    if not first or not last:
        raise HTTPException(400, "first and last assets required")

    # If the left keyframe has a chain_asset_id (end-frame extracted from previous video),
    # use that as the actual first_file for pixel-exact continuity.
    chain_first = first
    for kf in data.get("keyframes") or []:
        if kf.get("asset_id") == first_asset_id and kf.get("chain_asset_id"):
            chain_asset = assets.get(kf["chain_asset_id"])
            if chain_asset:
                chain_first = chain_asset

    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "prompt required")
    gap_start = float(body.get("gap_start") if body.get("gap_start") is not None else 0)
    if body.get("duration_seconds") is not None:
        duration = max(0.5, float(body.get("duration_seconds")))
        gap_end = float(body.get("gap_end") if body.get("gap_end") is not None else gap_start + duration)
    else:
        gap_end = float(body.get("gap_end") if body.get("gap_end") is not None else gap_start + 3)
        duration = max(0.5, gap_end - gap_start)
    job = _job_base(project_id, "video", prompt)
    job["gap_start"] = gap_start
    job["gap_end"] = gap_end
    try:
        await jobs.enqueue(job, {
            "project_id": project_id,
            "first_file": chain_first["file"],
            "last_file": last["file"],
            "prompt": prompt,
            "duration_seconds": duration,
            "gap_start": gap_start,
            "gap_end": gap_end,
            "seed": body.get("seed"),
            "config": body.get("config") or {},
        })
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {k: v for k, v in job.items() if not k.startswith("_")}


if DIST_DIR.is_dir():
    assets_dir_ui = DIST_DIR / "assets"
    if assets_dir_ui.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir_ui)), name="ui-assets")

    @app.get("/")
    async def ui_index() -> FileResponse:
        return FileResponse(DIST_DIR / "index.html")


def main() -> None:
    cfg = load_config()
    host = str(cfg.get("host") or "127.0.0.1")
    port = int(cfg.get("port") or 8765)
    uvicorn.run("frameforge.server:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
