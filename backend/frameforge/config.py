from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
DIST_DIR = ROOT / "dist"
CFG_PATH = ROOT / "config.json"
PROJECTS_DIR = ROOT / "projects"
STATE_DIR = ROOT / "state"
JOBS_PATH = STATE_DIR / "jobs.json"


def load_config() -> dict[str, Any]:
    if CFG_PATH.is_file():
        return json.loads(CFG_PATH.read_text(encoding="utf-8"))
    return {}


def save_config(data: dict[str, Any]) -> None:
    CFG_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
