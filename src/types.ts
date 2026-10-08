export type Asset = {
  id: string;
  kind: "image" | "video";
  file: string;
  label: string;
  source_job_id?: string | null;
  created?: number;
};

export type Keyframe = {
  id: string;
  asset_id: string;
  time: number;
  label?: string;
};

export type Clip = {
  id: string;
  asset_id: string;
  start: number;
  end: number;
  label?: string;
};

export type PromptSegment = {
  id: string;
  start: number;
  end: number;
  prompt: string;
  from_kf_id?: string;
  to_kf_id?: string;
};

export type Project = {
  id: string;
  name: string;
  fps: number;
  duration: number;
  assets: Asset[];
  keyframes: Keyframe[];
  clips: Clip[];
  prompt_segments?: PromptSegment[];
  settings?: Record<string, unknown>;
  created?: number;
  updated?: number;
};

export type Job = {
  id: string;
  project_id: string;
  kind: "t2i" | "edit" | "video";
  status: string;
  phase?: string;
  progress?: number;
  max?: number;
  prompt?: string;
  preview_url?: string;
  preview_file?: string;
  error?: string;
  place_at?: number;
};

export type Health = {
  ok: boolean;
  comfyui: string;
  comfy_busy: boolean;
  qwenedit: string;
  require_idle_gpu: boolean;
};
