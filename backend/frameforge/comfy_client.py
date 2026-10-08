"""Minimal async ComfyUI client — read-only health checks and on-demand queue."""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote

log = logging.getLogger(__name__)

import httpx

try:
    import websockets  # type: ignore
except ImportError:  # pragma: no cover
    websockets = None


class ComfyError(RuntimeError):
    pass


ProgressCB = Callable[..., Any]


class ComfyClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8188"):
        self.base = base_url.rstrip("/")
        self.client_id = "frameforge-" + uuid.uuid4().hex[:6]
        self.http = httpx.AsyncClient(
            base_url=self.base, timeout=httpx.Timeout(60.0, connect=3.0)
        )

    async def aclose(self) -> None:
        await self.http.aclose()

    async def ping_status(self) -> str:
        try:
            r = await self.http.get("/system_stats", timeout=httpx.Timeout(3.0, connect=0.8))
            return "up" if r.status_code == 200 else "down"
        except httpx.ConnectError:
            return "down"
        except httpx.TimeoutException:
            return "busy"
        except httpx.HTTPError:
            return "down"

    async def ping(self) -> bool:
        return (await self.ping_status()) != "down"

    async def queue_snapshot(self) -> dict | None:
        try:
            r = await self.http.get("/queue", timeout=httpx.Timeout(3.0, connect=1.0))
            if not r.is_success:
                return None
            data = r.json()
            return data if isinstance(data, dict) else None
        except httpx.HTTPError:
            return None

    async def is_busy(self) -> bool:
        snap = await self.queue_snapshot()
        if snap is None:
            return False
        running = snap.get("queue_running") or []
        pending = snap.get("queue_pending") or []
        return bool(running or pending)

    async def upload_image(self, data: bytes, name: str) -> dict:
        mime = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
        }.get(Path(name).suffix.lower(), "image/png")
        r = await self.http.post(
            "/upload/image",
            files={"image": (name, data, mime)},
            data={"overwrite": "true"},
        )
        if not r.is_success:
            raise ComfyError(f"upload failed {r.status_code}: {r.text[:300]}")
        return r.json()

    async def queue(self, graph: dict) -> str:
        r = await self.http.post(
            "/prompt", json={"prompt": graph, "client_id": self.client_id}
        )
        if not r.is_success:
            raise ComfyError(f"ComfyUI rejected graph ({r.status_code}): {r.text[:800]}")
        pid = r.json().get("prompt_id")
        if not pid:
            raise ComfyError(f"No prompt_id in response: {r.text[:300]}")
        return str(pid)

    async def history_entry(self, prompt_id: str) -> dict | None:
        try:
            r = await self.http.get(f"/history/{prompt_id}")
            if not r.is_success:
                return None
            return r.json().get(prompt_id)
        except httpx.HTTPError:
            return None

    async def wait_job(
        self,
        prompt_id: str,
        timeout: float = 3600.0,
        on_progress: ProgressCB | None = None,
        abort: asyncio.Event | None = None,
    ) -> dict:
        t0 = time.monotonic()
        pid = str(prompt_id)
        while True:
            if abort is not None and abort.is_set():
                raise ComfyError("Cancelled")
            if time.monotonic() - t0 > timeout:
                raise ComfyError(f"Timed out after {int(timeout)}s")
            entry = await self.history_entry(pid)
            if entry:
                status = entry.get("status") or {}
                messages = status.get("messages") or []
                for m in messages:
                    if isinstance(m, list) and m and m[0] == "execution_error":
                        bad = m[1] or {}
                        raise ComfyError(
                            f"Node {bad.get('node_id')} failed: "
                            f"{str(bad.get('exception_message', ''))[:400]}"
                        )
                outputs = entry.get("outputs") or {}
                if status.get("completed") or outputs:
                    if on_progress:
                        on_progress(100, 100, "Done")
                    log.warning(
                        "[DEBUG] wait_job done for %s | status=%s | output_keys=%s | outputs=%s",
                        pid,
                        status.get("completed"),
                        list(outputs.keys()),
                        json.dumps(outputs, indent=2)[:6000],
                    )
                    return outputs
            if on_progress:
                on_progress(8, 100, "Running on ComfyUI…")
            await asyncio.sleep(1.0)

    @staticmethod
    def view_url(filename: str, subfolder: str = "", image_type: str = "output") -> str:
        return (
            f"/view?filename={quote(filename)}"
            f"&subfolder={quote(subfolder)}&type={image_type}"
        )

    async def download(
        self,
        filename: str,
        dest_path: Path,
        subfolder: str = "",
        image_type: str = "output",
    ) -> None:
        url = self.view_url(filename, subfolder, image_type)
        r = await self.http.get(url)
        if not r.is_success:
            raise ComfyError(f"download failed {r.status_code}")
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(r.content)

    @staticmethod
    def pick_image(outputs: dict) -> tuple[str, str]:
        for node_out in outputs.values():
            if not isinstance(node_out, dict):
                continue
            images = node_out.get("images") or []
            if images:
                img = images[0]
                return str(img.get("filename") or ""), str(img.get("subfolder") or "")
        raise ComfyError("no image in Comfy outputs")

    @staticmethod
    def pick_video(outputs: dict) -> tuple[str, str]:
        """Extract (filename, subfolder) from ComfyUI outputs for any known video saver node.

        Known formats:
        - VHS_VideoCombine / old style: node_out["videos"][0] or node_out["gifs"][0]
        - SaveVideo (Kijai H3 build): node_out["images"][0] with node_out["animated"] == [True]
        - video_ui wrapper: node_out["video_ui"]["videos"][0]
        - plain filenames list: node_out["filenames"][0] as str
        """
        def _candidates(node_out: dict):
            yield node_out
            for v in node_out.values():
                if isinstance(v, dict):
                    yield v

        for node_out in outputs.values():
            if not isinstance(node_out, dict):
                continue
            for candidate in _candidates(node_out):
                # Explicit video/gif keys
                for key in ("videos", "gifs", "filenames"):
                    items = candidate.get(key) or []
                    if items:
                        vid = items[0]
                        if isinstance(vid, dict):
                            return str(vid.get("filename") or ""), str(vid.get("subfolder") or "")
                        if isinstance(vid, str) and vid:
                            return vid, ""
                # SaveVideo pattern: "images" list + "animated": [True]
                animated = candidate.get("animated") or []
                images = candidate.get("images") or []
                if images and animated and animated[0] is True:
                    img = images[0]
                    if isinstance(img, dict):
                        return str(img.get("filename") or ""), str(img.get("subfolder") or "")
        raise ComfyError("no video in Comfy outputs")
