"""Generation job queue — user-initiated only; respects external GPU occupancy."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import time
import uuid
from typing import Any

from .comfy_client import ComfyClient, ComfyError
from .config import JOBS_PATH, STATE_DIR, load_config
from .graphs import (
    BETWEEN_PROMPT_TEMPLATE,
    calculate_h3_dimensions,
    get_image_size,
    h3_i2v_graph,
    snap_h3_length,
    t2i_keyframe_graph,
)
from .project_store import add_asset, asset_path, load_project, save_project
from .qwenedit_client import QwenEditClient, QwenEditError

ACTIVE = ("queued", "running")
KEEP = 32


def extract_video_last_frame(video_path: Path, output_image_path: Path) -> bool:
    try:
        import imageio.v3 as iio
        from PIL import Image

        last_frame = None
        for frame in iio.imiter(video_path):
            last_frame = frame
        if last_frame is not None:
            img = Image.fromarray(last_frame)
            img.save(output_image_path, "PNG")
            return True
    except Exception as e:
        print(f"Failed to extract last frame from {video_path}: {e}")
    return False


class JobManager:
    def __init__(self) -> None:
        self.jobs: list[dict[str, Any]] = []
        self.lock = asyncio.Lock()
        self.wake = asyncio.Event()
        self._worker_task: asyncio.Task | None = None

    def start(self) -> None:
        if self._worker_task is None:
            self.wake = asyncio.Event()
            self._load()
            self._worker_task = asyncio.create_task(self._worker())

    def _load(self) -> None:
        if not JOBS_PATH.is_file():
            return
        try:
            raw = json.loads(JOBS_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(raw, list):
            return
        for job in raw:
            if not isinstance(job, dict) or not job.get("id"):
                continue
            if job.get("status") in ("queued", "running"):
                job["status"] = "error"
                job["error"] = "Interrupted — restart the generation"
                job["phase"] = "Error"
            self.jobs.append(job)
        if any(j.get("status") == "queued" for j in self.jobs):
            self.wake.set()

    def _persist(self) -> None:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = JOBS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.public_jobs(), indent=2), encoding="utf-8")
        tmp.replace(JOBS_PATH)

    def public_jobs(self) -> list[dict[str, Any]]:
        return [{k: v for k, v in j.items() if not k.startswith("_")} for j in self.jobs[-KEEP:]]

    def get(self, job_id: str) -> dict[str, Any] | None:
        return next((j for j in self.jobs if j["id"] == job_id), None)

    async def _gpu_available(self, kind: str) -> tuple[bool, str]:
        cfg = load_config()
        if not cfg.get("generation", {}).get("require_idle_gpu", True):
            return True, ""
        comfy_url = str((cfg.get("comfyui") or {}).get("base_url") or "http://127.0.0.1:8188")
        qwen_url = str((cfg.get("qwenedit") or {}).get("base_url") or "http://127.0.0.1:8741")
        needs_comfy = kind in ("t2i", "video")
        needs_qwen = kind == "edit"
        comfy = ComfyClient(comfy_url)
        qwen = QwenEditClient(qwen_url)
        try:
            if needs_comfy or needs_qwen:
                comfy_status = await comfy.ping_status()
                if comfy_status == "down":
                    return False, "ComfyUI is not reachable"
                if needs_comfy and await comfy.is_busy():
                    return False, "ComfyUI queue is busy — wait for the current job to finish"
            if needs_qwen:
                qwen_status = await qwen.ping_status()
                if qwen_status == "down":
                    return False, "QwenEdit is not reachable — start it from Desktop\\QwenEdit"
                if qwen_status == "busy":
                    return False, "QwenEdit is busy — wait for the current edit to finish"
                if await comfy.is_busy():
                    return False, "ComfyUI queue is busy — QwenEdit needs it idle"
        finally:
            await comfy.aclose()
            await qwen.aclose()
        return True, ""

    async def enqueue(self, job: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            ok, reason = await self._gpu_available(str(job.get("kind") or ""))
            if not ok and job.get("kind") != "noop":
                raise RuntimeError(reason)
            job.setdefault("status", "queued")
            job.setdefault("progress", 0)
            job.setdefault("max", 100)
            job.setdefault("phase", "Queued")
            job.setdefault("created", time.time())
            job["_payload"] = payload
            self.jobs.append(job)
            self._persist()
            self.wake.set()
        return job

    async def _worker(self) -> None:
        while True:
            async with self.lock:
                busy = any(j.get("status") == "running" for j in self.jobs)
                nxt = None if busy else next((j for j in self.jobs if j.get("status") == "queued"), None)
            if not nxt:
                self.wake.clear()
                try:
                    await asyncio.wait_for(self.wake.wait(), timeout=1.5)
                except asyncio.TimeoutError:
                    pass
                continue
            payload = nxt.pop("_payload", None)
            if not payload:
                nxt["status"] = "error"
                nxt["error"] = "Missing payload"
                continue
            nxt["status"] = "running"
            try:
                await self._run(nxt, payload)
            except Exception as e:  # noqa: BLE001
                nxt["status"] = "error"
                nxt["error"] = str(e)[:500]
                nxt["phase"] = "Error"
            self._persist()
            self.wake.set()

    async def _run(self, job: dict[str, Any], payload: dict[str, Any]) -> None:
        kind = job.get("kind")
        if kind == "t2i":
            await self._run_t2i(job, payload)
        elif kind == "edit":
            await self._run_edit(job, payload)
        elif kind == "video":
            await self._run_video(job, payload)
        else:
            raise RuntimeError(f"unknown job kind {kind}")

    def _progress(self, job: dict[str, Any], value: int, maxv: int, phase: str) -> None:
        job["progress"] = int(value)
        job["max"] = int(maxv) or 100
        if phase:
            job["phase"] = phase

    def _finish_job(self, job: dict[str, Any], *, filename: str, project_id: str) -> None:
        asset_id = uuid.uuid4().hex[:10]
        kind = (
            "video"
            if job.get("kind") == "video" or str(filename).lower().endswith((".mp4", ".webm"))
            else "image"
        )
        add_asset(
            project_id,
            asset_id=asset_id,
            filename=filename,
            kind=kind,
            label=(job.get("prompt") or "")[:60],
            source_job_id=job["id"],
        )
        data = load_project(project_id)
        if kind == "image":
            kf = {
                "id": uuid.uuid4().hex[:8],
                "asset_id": asset_id,
                "time": float(job.get("place_at") or 0),
                "label": (job.get("prompt") or "")[:40],
            }
            data.setdefault("keyframes", []).append(kf)
            data["keyframes"].sort(key=lambda x: float(x.get("time") or 0))
            job["placed_keyframe_id"] = kf["id"]
        elif job.get("gap_start") is not None:
            gap_start = float(job.get("gap_start") or 0)
            actual_duration = float(
                job.get("actual_duration")
                or (float(job.get("gap_end") or gap_start + 3) - gap_start)
            )
            gap_end = gap_start + actual_duration
            old_gap_end = float(job.get("gap_end") or gap_end)

            # Extract video's exact last frame and register it as an image asset
            video_file = asset_path(project_id, filename)
            last_frame_name = f"{video_file.stem}_end_frame.png"
            last_frame_path = asset_path(project_id, last_frame_name)
            last_frame_asset_id = None
            if extract_video_last_frame(video_file, last_frame_path):
                last_frame_asset_id = uuid.uuid4().hex[:10]
                add_asset(
                    project_id,
                    asset_id=last_frame_asset_id,
                    filename=last_frame_name,
                    kind="image",
                    label=f"End Frame @ {gap_end:.2f}s",
                    source_job_id=job["id"],
                )

            # Replace any previous clip for this segment
            existing_clips = data.get("clips") or []
            data["clips"] = [
                c
                for c in existing_clips
                if not (abs(float(c.get("start", 0)) - gap_start) < 0.15)
            ]

            clip = {
                "id": uuid.uuid4().hex[:8],
                "asset_id": asset_id,
                "start": gap_start,
                "end": gap_end,
                "label": (job.get("prompt") or "")[:40],
            }
            data["clips"].append(clip)
            job["placed_clip_id"] = clip["id"]

            # Align the destination keyframe position; store end-frame for next clip's first_frame use
            for kf in data.get("keyframes") or []:
                if abs(float(kf.get("time", 0)) - old_gap_end) < 0.5:
                    kf["time"] = round(gap_end, 2)
                    if last_frame_asset_id:
                        # Keep original asset_id visible in timeline; store chain asset for next video render
                        kf["chain_asset_id"] = last_frame_asset_id
            if data.get("keyframes"):
                data["keyframes"].sort(key=lambda x: float(x.get("time") or 0))

            # Keep prompt_segments timestamps in sync with retimed keyframes
            for seg in data.get("prompt_segments") or []:
                if abs(float(seg.get("end", 0)) - old_gap_end) < 0.5:
                    seg["end"] = round(gap_end, 2)
                if abs(float(seg.get("start", 0)) - old_gap_end) < 0.5:
                    seg["start"] = round(gap_end, 2)
        save_project(data)
        job.update({
            "status": "done",
            "phase": "Done",
            "progress": 100,
            "asset_id": asset_id,
            "result_file": filename,
            "result_url": f"/api/projects/{project_id}/assets/{filename}",
        })

    async def _run_t2i(self, job: dict[str, Any], payload: dict[str, Any]) -> None:
        cfg = load_config()
        t2i = {**(cfg.get("t2i") or {}), **(payload.get("config") or {})}
        project_id = payload["project_id"]
        job["place_at"] = float(payload.get("place_at") or 0)
        comfy = ComfyClient(str((cfg.get("comfyui") or {}).get("base_url")))
        try:
            self._progress(job, 5, 100, "Queueing T2I on ComfyUI")
            graph = t2i_keyframe_graph(
                payload["prompt"],
                width=int(t2i.get("width", 832)),
                height=int(t2i.get("height", 1216)),
                seed=payload.get("seed"),
                steps=int(t2i.get("steps", 25)),
                cfg=float(t2i.get("cfg", 3.5)),
                negative=str(t2i.get("negative_prompt") or ""),
                checkpoint=str(t2i.get("checkpoint") or ""),
                lora_name=str(t2i.get("anima_lora") or ""),
                detailer_denoise=float(t2i.get("detailer_denoise", 0.35)),
                detector=str(t2i.get("detector") or ""),
                sampler_name=str(t2i.get("sampler") or "dpmpp_2m"),
                scheduler=str(t2i.get("scheduler") or "sgm_uniform"),
                skip_detailer=not bool(t2i.get("detailer", True)),
                save_prefix=f"FrameForge/{job['id']}",
            )
            pid = await comfy.queue(graph)
            job["comfy_prompt_id"] = pid

            def on_prog(v: int, m: int, phase: str = "") -> None:
                self._progress(job, v, m, phase)

            outputs = await comfy.wait_job(pid, on_progress=on_prog)
            fname, sub = comfy.pick_image(outputs)
            dest = asset_path(project_id, f"{job['id']}_{fname}")
            await comfy.download(fname, dest, subfolder=sub)
            job["prompt"] = payload["prompt"]
            self._finish_job(job, filename=dest.name, project_id=project_id)
            self._persist()
        finally:
            await comfy.aclose()

    async def _run_edit(self, job: dict[str, Any], payload: dict[str, Any]) -> None:
        cfg = load_config()
        qwen_cfg = cfg.get("qwenedit") or {}
        edit_cfg = payload.get("config") or {}
        project_id = payload["project_id"]
        job["place_at"] = float(payload.get("place_at") or 0)
        qwen = QwenEditClient(str(qwen_cfg.get("base_url") or "http://127.0.0.1:8741"))
        try:
            self._progress(job, 5, 100, "Submitting to QwenEdit")
            src = asset_path(project_id, payload["source_file"])
            if not src.is_file():
                raise QwenEditError("source image missing")
            image_bytes = src.read_bytes()
            prompt = payload["prompt"]
            if payload.get("between"):
                extra = (payload.get("user_prompt") or "").strip()
                prompt = BETWEEN_PROMPT_TEMPLATE.format(
                    user_prompt=extra if extra else "Match lighting and composition."
                )
            resp = await qwen.submit_edit(
                image_bytes,
                src.name,
                prompt,
                steps=int(edit_cfg.get("steps", 4)),
                cfg=float(edit_cfg.get("cfg", 1.0)),
                seed=payload.get("seed"),
            )
            qid = resp.get("id")
            job["qwenedit_job_id"] = qid
            self._progress(job, 10, 100, "QwenEdit running")

            def poll_progress(qjob: dict[str, Any]) -> None:
                self._progress(
                    job,
                    int(qjob.get("progress") or 10),
                    int(qjob.get("max") or 100),
                    str(qjob.get("phase") or "Editing"),
                )

            t0 = time.monotonic()
            while time.monotonic() - t0 < 1800:
                qjob = await qwen.get_job(str(qid))
                poll_progress(qjob)
                if qjob.get("status") == "done":
                    result_url = str(qjob.get("result_url") or "")
                    data = await qwen.download_result(result_url)
                    dest = asset_path(project_id, f"{job['id']}_edit.png")
                    dest.write_bytes(data)
                    job["prompt"] = prompt
                    self._finish_job(job, filename=dest.name, project_id=project_id)
                    self._persist()
                    return
                if qjob.get("status") in ("error", "cancelled"):
                    raise QwenEditError(qjob.get("error") or "edit failed")
                await asyncio.sleep(1.2)
            raise QwenEditError("timed out waiting for QwenEdit")
        finally:
            await qwen.aclose()

    async def _run_video(self, job: dict[str, Any], payload: dict[str, Any]) -> None:
        cfg = load_config()
        h3 = {**(cfg.get("h3") or {}), **(payload.get("config") or {})}
        project_id = payload["project_id"]
        job["gap_start"] = payload.get("gap_start")
        job["gap_end"] = payload.get("gap_end")
        comfy = ComfyClient(str((cfg.get("comfyui") or {}).get("base_url")))
        try:
            self._progress(job, 5, 100, "Uploading keyframes")
            first = asset_path(project_id, payload["first_file"])
            last = asset_path(project_id, payload["last_file"])
            up_first = await comfy.upload_image(first.read_bytes(), f"ff_{job['id']}_a.png")
            up_last = await comfy.upload_image(last.read_bytes(), f"ff_{job['id']}_b.png")
            duration = float(payload.get("duration_seconds") or 3.0)
            length = snap_h3_length(duration)
            job["actual_duration"] = length / 24.0
            turbo = bool(h3.get("turbo", True))
            steps = int(h3.get("steps", 8 if turbo else 20))
            target_pixels = int(h3.get("target_pixels", 414720 if turbo else 1032192))

            # Auto-detect input image dimensions to preserve exact aspect ratio (prevents squishing)
            first_size = get_image_size(first)
            if first_size and not payload.get("config", {}).get("width"):
                width, height = calculate_h3_dimensions(first_size[0], first_size[1], target_pixels=target_pixels)
            else:
                width = int(h3.get("width", 480 if turbo else 768))
                height = int(h3.get("height", 864 if turbo else 1344))

            self._progress(
                job,
                12,
                100,
                f"Queueing I2V Turbo ({width}x{height}) on ComfyUI"
                if turbo
                else f"Queueing I2V ({width}x{height}) on ComfyUI",
            )
            graph = h3_i2v_graph(
                payload["prompt"],
                width=width,
                height=height,
                length_frames=length,
                seed=payload.get("seed"),
                steps=steps,
                first_frame_name=str(up_first.get("name")),
                last_frame_name=str(up_last.get("name")),
                unet_name=str(h3.get("unet") or ""),
                clip_name=str(h3.get("clip_name") or ""),
                vae_video=str(h3.get("vae_video") or ""),
                vae_audio=str(h3.get("vae_audio") or ""),
                save_prefix=f"FrameForge/{job['id']}",
                turbo=turbo,
                turbo_lora=str(h3.get("turbo_lora") or "minimax_h3_turbo_v4_step600_ema.safetensors"),
                turbo_lora_strength=float(h3.get("turbo_lora_strength", 1.0)),
            )
            pid = await comfy.queue(graph)
            job["comfy_prompt_id"] = pid

            def on_prog(v: int, m: int, phase: str = "") -> None:
                self._progress(job, v, m, phase)

            outputs = await comfy.wait_job(pid, on_progress=on_prog)
            fname, sub = comfy.pick_video(outputs)
            dest = asset_path(project_id, f"{job['id']}_{fname}")
            await comfy.download(fname, dest, subfolder=sub, image_type="output")
            job["prompt"] = payload["prompt"]
            self._finish_job(job, filename=dest.name, project_id=project_id)
            self._persist()
        finally:
            await comfy.aclose()


jobs = JobManager()
