"""API-format Comfy graphs matched to this machine's T2IV3.5 / I2VV2 setup."""
from __future__ import annotations

import math
import random
import struct
from pathlib import Path

CHECKPOINT = "model.safetensors"
ANIMA_LORA = "lora.safetensors"
FACE_DET = "bbox/face_yolov8m.pt"

H3_UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
H3_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
H3_VAE_VIDEO = "minimax_h3_video_vae_fp16.safetensors"
H3_VAE_AUDIO = "minimax_h3_audio_vae_fp32.safetensors"

NEGATIVE_DEFAULT = ""

# ComfyUI SaveVideo (v3) requires format + codec; matches I2VV2_Turbo workflow defaults.
SAVE_VIDEO_INPUTS = {
    "format": "mp4",
    "codec": "h264",
}


def get_image_size(path_or_bytes: Path | bytes) -> tuple[int, int] | None:
    """Extract (width, height) from PNG, JPEG, WebP bytes without third-party dependencies."""
    data = path_or_bytes.read_bytes() if isinstance(path_or_bytes, Path) else path_or_bytes
    if not data or len(data) < 24:
        return None
    # PNG: IHDR width & height are at offset 16..24
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return struct.unpack(">II", data[16:24])
    # JPEG: parse SOF markers
    if data.startswith(b"\xff\xd8"):
        idx = 2
        while idx < len(data) - 9:
            if data[idx] != 0xFF:
                idx += 1
                continue
            marker = data[idx + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", data[idx + 5 : idx + 9])
                return w, h
            length = struct.unpack(">H", data[idx + 2 : idx + 4])[0]
            idx += 2 + length
    # WebP: VP8 / VP8L / VP8X
    if data.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WEBP":
        if data[12:16] == b"VP8 " and len(data) >= 30:
            w, h = struct.unpack("<HH", data[26:30])
            return (w & 0x3FFF, h & 0x3FFF)
        if data[12:16] == b"VP8L" and len(data) >= 25:
            b0, b1, b2, b3, b4 = data[20:25]
            w = 1 + (((b1 & 0x3F) << 8) | b0)
            h = 1 + (((b4 & 0x0F) << 10) | (b3 << 2) | ((b2 & 0xC0) >> 6))
            return w, h
        if data[12:16] == b"VP8X" and len(data) >= 30:
            w = 1 + struct.unpack("<I", data[24:27] + b"\x00")[0]
            h = 1 + struct.unpack("<I", data[27:30] + b"\x00")[0]
            return w, h
    return None


def calculate_h3_dimensions(
    w_in: int,
    h_in: int,
    target_pixels: int = 414720,
    multiple: int = 32,
) -> tuple[int, int]:
    """Calculate (width, height) matching the input image's aspect ratio on a multiple-of-32 grid."""
    if w_in <= 0 or h_in <= 0:
        return 480, 864
    target_ratio = w_in / h_in
    candidates = []
    min_pixels = target_pixels * 0.75
    max_pixels = target_pixels * 1.30

    for w in range(multiple * 4, 1920 + 1, multiple):
        h_exact = w / target_ratio
        for h in (
            max(multiple * 4, int(round(h_exact / multiple)) * multiple),
            max(multiple * 4, int(math.floor(h_exact / multiple)) * multiple),
            max(multiple * 4, int(math.ceil(h_exact / multiple)) * multiple),
        ):
            if h > 1920:
                continue
            pixels = w * h
            if min_pixels <= pixels <= max_pixels:
                ratio = w / h
                ratio_err = abs(ratio - target_ratio) / target_ratio
                pixel_err = abs(pixels - target_pixels) / target_pixels
                score = ratio_err * 3.0 + pixel_err
                candidates.append((score, w, h))

    if not candidates:
        raw_w = math.sqrt(target_pixels * target_ratio)
        raw_h = math.sqrt(target_pixels / target_ratio)
        return (
            max(multiple, int(round(raw_w / multiple)) * multiple),
            max(multiple, int(round(raw_h / multiple)) * multiple),
        )

    candidates.sort(key=lambda x: x[0])
    return candidates[0][1], candidates[0][2]


def _seed(seed: int | None = None) -> int:
    return seed if seed is not None else random.randint(1, 2**31 - 1)


def normalize_detector(name: str | None) -> str:
    n = (name or FACE_DET).strip()
    if n and "/" not in n:
        n = "bbox/" + n
    return n


def snap_h3_frames(frames: int) -> int:
    # MiniMax H3 requires frame count where (count % 17) == 5.
    # Minimum valid value is 73 (~3s at 24fps). Max is 362 (~15s).
    f = max(5, int(round(frames)))
    k = round((f - 5) / 17.0)
    target = int(17 * k + 5)
    return min(max(target, 73), 362)


def snap_h3_length(seconds: float) -> int:
    return snap_h3_frames(max(5, round(float(seconds) * 24)))


def t2i_keyframe_graph(
    prompt: str,
    *,
    width: int = 832,
    height: int = 1216,
    seed: int | None = None,
    steps: int = 25,
    cfg: float = 3.5,
    negative: str = NEGATIVE_DEFAULT,
    checkpoint: str = CHECKPOINT,
    lora_name: str = ANIMA_LORA,
    lora_strength: float = 1.0,
    detailer_denoise: float = 0.35,
    detector: str = FACE_DET,
    save_prefix: str = "FrameForge/keyframes",
    sampler_name: str = "dpmpp_2m",
    scheduler: str = "sgm_uniform",
    skip_detailer: bool = False,
) -> dict:
    detector = normalize_detector(detector)
    s = _seed(seed)
    g = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "2": {
            "class_type": "LoraLoader",
            "inputs": {
                "model": ["1", 0],
                "clip": ["1", 1],
                "lora_name": lora_name,
                "strength_model": lora_strength,
                "strength_clip": lora_strength,
            },
        },
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 1]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["2", 1]}},
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        },
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "seed": s,
                "steps": steps,
                "cfg": cfg,
                "denoise": 1.0,
                "sampler_name": sampler_name,
                "scheduler": scheduler,
                "model": ["2", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["5", 0],
            },
        },
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
    }
    if skip_detailer:
        g["10"] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["7", 0], "filename_prefix": save_prefix},
        }
    else:
        g["8"] = {
            "class_type": "UltralyticsDetectorProvider",
            "inputs": {"model_name": detector},
        }
        g["9"] = {
            "class_type": "FaceDetailer",
            "inputs": {
                "image": ["7", 0],
                "model": ["2", 0],
                "clip": ["2", 1],
                "vae": ["1", 2],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "bbox_detector": ["8", 0],
                "guide_size": 512,
                "guide_size_for": True,
                "max_size": 1024,
                "seed": s,
                "steps": 12,
                "cfg": cfg,
                "sampler_name": sampler_name,
                "scheduler": scheduler,
                "denoise": detailer_denoise,
                "feather": 5,
                "noise_mask": True,
                "force_inpaint": True,
                "bbox_threshold": 0.5,
                "bbox_dilation": 10,
                "bbox_crop_factor": 3.0,
                "sam_detection_hint": "center-1",
                "sam_dilation": 0,
                "sam_threshold": 0.93,
                "sam_bbox_expansion": 0,
                "sam_mask_hint_threshold": 0.7,
                "sam_mask_hint_use_negative": "False",
                "drop_size": 10,
                "wildcard": "",
                "cycle": 1,
            },
        }
        g["10"] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["9", 0], "filename_prefix": save_prefix},
        }
    return g


def format_fl2va_prompt(prompt: str, has_first: bool, has_last: bool) -> str:
    p = (prompt or "").strip()
    if has_first and has_last:
        if "<Picture 1>" not in p and "<Picture 2>" not in p:
            return f"<Picture 1> smoothly transitions, transforms, and ends precisely matching <Picture 2>. {p}"
    elif has_first and "<Picture 1>" not in p:
        return f"<Picture 1> begins the motion. {p}"
    return p


def h3_i2v_graph(
    prompt: str,
    *,
    width: int = 768,
    height: int = 1344,
    length_frames: int = 124,
    seed: int | None = None,
    steps: int = 20,
    first_frame_name: str | None = None,
    last_frame_name: str | None = None,
    unet_name: str = H3_UNET,
    clip_name: str = H3_CLIP,
    vae_video: str = H3_VAE_VIDEO,
    vae_audio: str = H3_VAE_AUDIO,
    save_prefix: str = "FrameForge/clips",
    turbo: bool = False,
    turbo_lora: str = "minimax_h3_turbo_v4_step600_ema.safetensors",
    turbo_lora_strength: float = 1.0,
) -> dict:
    prompt = format_fl2va_prompt(prompt, bool(first_frame_name), bool(last_frame_name))
    if turbo:
        return h3_i2v_turbo_graph(
            prompt,
            width=width,
            height=height,
            length_frames=length_frames,
            seed=seed,
            steps=steps,
            first_frame_name=first_frame_name,
            last_frame_name=last_frame_name,
            unet_name=unet_name,
            clip_name=clip_name,
            vae_video=vae_video,
            vae_audio=vae_audio,
            save_prefix=save_prefix,
            turbo_lora=turbo_lora,
            turbo_lora_strength=turbo_lora_strength,
        )
    length_frames = snap_h3_frames(length_frames)
    g: dict = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}},
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": clip_name, "type": "minimax", "device": "default"},
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae_video}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": vae_audio}},
    }
    n = 5
    first_ref = last_ref = None
    if first_frame_name:
        g[str(n)] = {"class_type": "LoadImage", "inputs": {"image": first_frame_name}}
        first_ref = [str(n), 0]
        n += 1
    if last_frame_name:
        g[str(n)] = {"class_type": "LoadImage", "inputs": {"image": last_frame_name}}
        last_ref = [str(n), 0]
        n += 1

    h3_inputs: dict = {
        "clip": ["2", 0],
        "vae": ["3", 0],
        "prompt": prompt,
        "width": width,
        "height": height,
        "length": length_frames,
    }
    if first_ref:
        h3_inputs["first_frame"] = first_ref
    if last_ref:
        h3_inputs["last_frame"] = last_ref
    h3_id = str(n)
    g[h3_id] = {"class_type": "MiniMaxH3ImageToVideo", "inputs": h3_inputs}
    n += 1

    guider_id = str(n)
    g[guider_id] = {
        "class_type": "BasicGuider",
        "inputs": {"model": ["1", 0], "conditioning": [h3_id, 0]},
    }
    n += 1
    noise_id = str(n)
    g[noise_id] = {"class_type": "RandomNoise", "inputs": {"noise_seed": _seed(seed)}}
    n += 1
    sampler_id = str(n)
    g[sampler_id] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}}
    n += 1
    sigmas_id = str(n)
    g[sigmas_id] = {
        "class_type": "BasicScheduler",
        "inputs": {"model": ["1", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0},
    }
    n += 1
    adv_id = str(n)
    g[adv_id] = {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
            "noise": [noise_id, 0],
            "guider": [guider_id, 0],
            "sampler": [sampler_id, 0],
            "sigmas": [sigmas_id, 0],
            "latent_image": [h3_id, 1],
        },
    }
    n += 1
    vid_id = str(n)
    g[vid_id] = {"class_type": "VAEDecode", "inputs": {"samples": [adv_id, 0], "vae": ["3", 0]}}
    n += 1
    aud_id = str(n)
    g[aud_id] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": [adv_id, 1], "vae": ["4", 0]}}
    n += 1
    video_id = str(n)
    g[video_id] = {
        "class_type": "CreateVideo",
        "inputs": {"images": [vid_id, 0], "audio": [aud_id, 0], "fps": 24.0, "bit_depth": 8},
    }
    n += 1
    g[str(n)] = {
        "class_type": "SaveVideo",
        "inputs": {"video": [video_id, 0], "filename_prefix": save_prefix, **SAVE_VIDEO_INPUTS},
    }
    return g


def h3_i2v_turbo_graph(
    prompt: str,
    *,
    width: int = 480,
    height: int = 864,
    length_frames: int = 124,
    seed: int | None = None,
    steps: int = 8,
    first_frame_name: str | None = None,
    last_frame_name: str | None = None,
    unet_name: str = H3_UNET,
    clip_name: str = H3_CLIP,
    vae_video: str = H3_VAE_VIDEO,
    vae_audio: str = H3_VAE_AUDIO,
    save_prefix: str = "FrameForge/clips",
    turbo_lora: str = "minimax_h3_turbo_v4_step600_ema.safetensors",
    turbo_lora_strength: float = 1.0,
) -> dict:
    """MiniMax H3 turbo: Turbo LoRA v4 + 8-step sampler (no Sage — breaks on Windows portable)."""
    length_frames = snap_h3_frames(length_frames)
    g: dict = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}},
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": clip_name, "type": "minimax", "device": "default"},
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae_video}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": vae_audio}},
        "130": {
            "class_type": "MiniMaxH3TurboLoRA",
            "inputs": {
                "model": ["1", 0],
                "lora_name": turbo_lora,
                "strength": turbo_lora_strength,
                "low_vram": False,
            },
        },
    }
    model_ref: list = ["130", 0]
    n = 5
    first_ref = last_ref = None
    if first_frame_name:
        g[str(n)] = {"class_type": "LoadImage", "inputs": {"image": first_frame_name}}
        first_ref = [str(n), 0]
        n += 1
    if last_frame_name:
        g[str(n)] = {"class_type": "LoadImage", "inputs": {"image": last_frame_name}}
        last_ref = [str(n), 0]
        n += 1

    h3_inputs: dict = {
        "clip": ["2", 0],
        "vae": ["3", 0],
        "prompt": prompt,
        "width": width,
        "height": height,
        "length": length_frames,
    }
    if first_ref:
        h3_inputs["first_frame"] = first_ref
    if last_ref:
        h3_inputs["last_frame"] = last_ref
    h3_id = str(n)
    g[h3_id] = {"class_type": "MiniMaxH3ImageToVideo", "inputs": h3_inputs}
    n += 1

    g["16"] = {
        "class_type": "BasicGuider",
        "inputs": {"model": model_ref, "conditioning": [h3_id, 0]},
    }
    g["15"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": _seed(seed)}}
    g["131"] = {"class_type": "MiniMaxH3TurboSampler", "inputs": {}}
    g["9"] = {
        "class_type": "BasicScheduler",
        "inputs": {"model": ["130", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0},
    }
    g["14"] = {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
            "noise": ["15", 0],
            "guider": ["16", 0],
            "sampler": ["131", 0],
            "sigmas": ["9", 0],
            "latent_image": [h3_id, 1],
        },
    }
    g["10"] = {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["3", 0]}}
    g["23"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["14", 1], "vae": ["4", 0]}}
    g["91"] = {
        "class_type": "CreateVideo",
        "inputs": {"images": ["10", 0], "audio": ["23", 0], "fps": 24.0, "bit_depth": 8},
    }
    g["92"] = {
        "class_type": "SaveVideo",
        "inputs": {"video": ["91", 0], "filename_prefix": save_prefix, **SAVE_VIDEO_INPUTS},
    }
    return g


BETWEEN_PROMPT_TEMPLATE = (
    "Generate the in-between frame: this image should depict the moment halfway "
    "between the previous keyframe and the next keyframe. Preserve character identity, "
    "wardrobe, and scene continuity while showing natural motion toward the next pose. "
    "{user_prompt}"
)
