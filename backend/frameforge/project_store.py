"""Project and asset persistence on disk."""
from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from .config import PROJECTS_DIR


def _pid(project_id: str) -> str:
    pid = (project_id or "").strip()
    if not pid or not pid.replace("-", "").isalnum():
        raise ValueError("invalid project id")
    return pid


def project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / _pid(project_id)


def project_file(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def assets_dir(project_id: str) -> Path:
    return project_dir(project_id) / "assets"


def load_project(project_id: str) -> dict[str, Any]:
    path = project_file(project_id)
    if not path.is_file():
        raise FileNotFoundError(project_id)
    return json.loads(path.read_text(encoding="utf-8"))


def save_project(data: dict[str, Any]) -> dict[str, Any]:
    pid = _pid(str(data.get("id") or ""))
    data["id"] = pid
    data["updated"] = time.time()
    folder = project_dir(pid)
    folder.mkdir(parents=True, exist_ok=True)
    assets_dir(pid).mkdir(parents=True, exist_ok=True)
    tmp = folder / "project.json.tmp"
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(project_file(pid))
    return data


def list_projects() -> list[dict[str, Any]]:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    for folder in PROJECTS_DIR.iterdir():
        path = folder / "project.json"
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data["id"] = data.get("id") or folder.name
            items.append(public_project(data))
        except (OSError, json.JSONDecodeError):
            continue
    items.sort(key=lambda p: float(p.get("updated") or 0), reverse=True)
    return items


def public_project(data: dict[str, Any], *, full: bool = False) -> dict[str, Any]:
    pid = data["id"]
    out: dict[str, Any] = {
        "id": pid,
        "name": data.get("name") or "Untitled",
        "created": data.get("created"),
        "updated": data.get("updated"),
        "fps": data.get("fps", 24),
        "duration": data.get("duration", 30),
    }
    if full:
        out["assets"] = data.get("assets") or []
        out["keyframes"] = data.get("keyframes") or []
        out["clips"] = data.get("clips") or []
        out["settings"] = data.get("settings") or {}
        out["prompt_segments"] = data.get("prompt_segments") or []
    return out


def new_project(name: str = "Untitled") -> dict[str, Any]:
    pid = uuid.uuid4().hex[:10]
    now = time.time()
    data = {
        "id": pid,
        "name": (name or "Untitled").strip()[:80] or "Untitled",
        "created": now,
        "updated": now,
        "fps": 24,
        "duration": 30,
        "assets": [],
        "keyframes": [],
        "clips": [],
        "prompt_segments": [],
        "settings": {
            "t2i": {},
            "h3": {},
            "edit": {"steps": 4, "cfg": 1.0},
        },
    }
    save_project(data)
    return public_project(data, full=True)


def delete_project(project_id: str) -> None:
    folder = project_dir(project_id)
    if folder.is_dir():
        shutil.rmtree(folder)


def add_asset(
    project_id: str,
    *,
    asset_id: str,
    filename: str,
    kind: str,
    label: str = "",
    source_job_id: str | None = None,
) -> dict[str, Any]:
    data = load_project(project_id)
    asset = {
        "id": asset_id,
        "kind": kind,
        "file": filename,
        "label": label or filename,
        "source_job_id": source_job_id,
        "created": time.time(),
    }
    assets = data.setdefault("assets", [])
    assets.append(asset)
    save_project(data)
    return asset


def delete_asset(project_id: str, asset_id: str) -> dict[str, Any]:
    data = load_project(project_id)
    assets = data.get("assets") or []
    target = next((a for a in assets if a.get("id") == asset_id), None)
    if target:
        filename = target.get("file")
        if filename:
            file_on_disk = asset_path(project_id, filename)
            if file_on_disk.is_file():
                try:
                    file_on_disk.unlink()
                except OSError:
                    pass
        data["assets"] = [a for a in assets if a.get("id") != asset_id]
        data["keyframes"] = [k for k in data.get("keyframes") or [] if k.get("asset_id") != asset_id]
        data["clips"] = [c for c in data.get("clips") or [] if c.get("asset_id") != asset_id]
        save_project(data)
    return public_project(data, full=True)


def asset_path(project_id: str, filename: str) -> Path:
    return assets_dir(project_id) / filename


def import_asset_file(
    project_id: str,
    data: bytes,
    filename: str,
    *,
    label: str = "",
) -> dict[str, Any]:
    """Add an existing image/video file directly to the media pool."""
    ext = Path(filename).suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm"}:
        raise ValueError("unsupported file type")
    kind = "video" if ext in {".mp4", ".webm"} else "image"
    asset_id = uuid.uuid4().hex[:10]
    safe_name = f"import_{asset_id}{ext if ext != '.jpeg' else '.jpg'}"
    dest = asset_path(project_id, safe_name)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return add_asset(
        project_id,
        asset_id=asset_id,
        filename=safe_name,
        kind=kind,
        label=label or Path(filename).stem,
    )
