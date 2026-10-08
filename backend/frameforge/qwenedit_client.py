"""HTTP client for the existing QwenEdit server — does not start or modify it."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

import httpx


class QwenEditError(RuntimeError):
    pass


class QwenEditClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8741"):
        self.base = base_url.rstrip("/")
        self.http = httpx.AsyncClient(
            base_url=self.base, timeout=httpx.Timeout(120.0, connect=3.0)
        )

    async def aclose(self) -> None:
        await self.http.aclose()

    async def ping_status(self) -> str:
        try:
            r = await self.http.get("/api/health", timeout=httpx.Timeout(3.0, connect=0.8))
            if not r.is_success:
                return "down"
            data = r.json()
            if data.get("job") and data["job"].get("status") in ("queued", "uploading", "running"):
                return "busy"
            if data.get("comfy_status") == "busy":
                return "busy"
            return "up" if data.get("ok") else "down"
        except httpx.ConnectError:
            return "down"
        except httpx.ConnectTimeout:
            return "down"
        except httpx.TimeoutException:
            return "down"
        except httpx.HTTPError:
            return "down"

    async def health(self) -> dict[str, Any]:
        r = await self.http.get("/api/health")
        r.raise_for_status()
        return r.json()

    async def submit_edit(
        self,
        image_bytes: bytes,
        filename: str,
        prompt: str,
        *,
        steps: int = 4,
        cfg: float = 1.0,
        seed: Optional[int] = None,
        use_lightning: bool = True,
    ) -> dict[str, Any]:
        files = {"image": (filename, image_bytes, "image/png")}
        data: dict[str, Any] = {
            "prompt": prompt,
            "steps": str(steps),
            "cfg": str(cfg),
            "use_lightning": "true" if use_lightning else "false",
        }
        if seed is not None:
            data["seed"] = str(seed)
        r = await self.http.post("/api/edit", files=files, data=data)
        if not r.is_success:
            raise QwenEditError(f"QwenEdit rejected edit ({r.status_code}): {r.text[:400]}")
        return r.json()

    async def get_job(self, job_id: str) -> dict[str, Any]:
        r = await self.http.get("/api/jobs")
        r.raise_for_status()
        payload = r.json()
        for job in payload.get("jobs") or []:
            if job.get("id") == job_id:
                return job
        cur = payload.get("current")
        if cur:
            r2 = await self.http.get("/api/job")
            if r2.is_success:
                j = r2.json()
                if j.get("id") == job_id:
                    return j
        raise QwenEditError(f"job {job_id} not found")

    async def wait_job(self, job_id: str, poll: float = 1.2, timeout: float = 1800.0) -> dict[str, Any]:
        import time

        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            job = await self.get_job(job_id)
            status = job.get("status")
            if status == "done":
                return job
            if status in ("error", "cancelled"):
                raise QwenEditError(job.get("error") or status)
            await _sleep(poll)
        raise QwenEditError(f"Timed out waiting for QwenEdit job {job_id}")

    async def download_result(self, result_url: str) -> bytes:
        path = result_url.split("?")[0]
        if not path.startswith("/"):
            path = "/" + path
        r = await self.http.get(path)
        if not r.is_success:
            raise QwenEditError(f"failed to download {path}")
        return r.content


async def _sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)
