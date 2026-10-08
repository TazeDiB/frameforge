import { create } from "zustand";
import { api } from "../lib/api";
import type { Health, Job, Keyframe, Project } from "../types";

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

type TimelinePatch = Partial<Pick<Project, "keyframes" | "clips" | "duration" | "fps" | "name" | "prompt_segments">>;

type Store = {
  health: Health | null;
  project: Project | null;
  projects: Project[];
  activeJob: Job | null;
  playhead: number;
  playing: boolean;
  selectedAssetId: string | null;
  selectedKeyframeIds: string[];
  focusedKeyframeId: string | null;
  selectedClipId: string | null;
  selectedSegmentId: string | null;
  zoom: number;
  saveStatus: SaveStatus;
  loadHealth: () => Promise<void>;
  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  updateTimeline: (patch: TimelinePatch) => void;
  saveTimeline: () => Promise<void>;
  flushSave: () => Promise<void>;
  setPlayhead: (t: number) => void;
  setPlaying: (v: boolean) => void;
  setZoom: (z: number) => void;
  selectAsset: (id: string | null) => void;
  deleteAsset: (id: string) => Promise<void>;
  toggleKeyframeSelect: (id: string) => void;
  clearKeyframeSelection: () => void;
  focusKeyframe: (id: string) => void;
  clearKeyframeFocus: () => void;
  deleteKeyframe: (id: string) => void;
  selectClip: (id: string | null) => void;
  deleteClip: (id: string) => void;
  selectSegment: (id: string | null) => void;
  setSegmentPrompt: (start: number, end: number, prompt: string, fromKfId?: string, toKfId?: string) => void;
  deleteSelected: () => void;
  moveKeyframe: (id: string, time: number) => void;
  setActiveJob: (job: Job | null) => void;
  pollJob: (jobId: string) => Promise<Job | null>;
  refreshProject: () => Promise<void>;
};

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
const AUTOSAVE_MS = 600;

export const useStore = create<Store>((set, get) => {
  const cancelAutosave = () => {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
  };

  const scheduleAutosave = () => {
    cancelAutosave();
    set({ saveStatus: "pending" });
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void get().flushSave();
    }, AUTOSAVE_MS);
  };

  const persistProject = async () => {
    const { project } = get();
    if (!project) return;
    set({ saveStatus: "saving" });
    try {
      const saved = await api.saveProject(project.id, {
        keyframes: project.keyframes,
        clips: project.clips,
        duration: project.duration,
        fps: project.fps,
        name: project.name,
        prompt_segments: project.prompt_segments,
      });
      set({ project: { ...project, ...saved }, saveStatus: "saved" });
    } catch {
      set({ saveStatus: "error" });
    }
  };

  return {
    health: null,
    project: null,
    projects: [],
    activeJob: null,
    playhead: 0,
    playing: false,
    selectedAssetId: null,
    selectedKeyframeIds: [],
    focusedKeyframeId: null,
    selectedClipId: null,
    selectedSegmentId: null,
    zoom: 64,
    saveStatus: "idle",

    loadHealth: async () => {
      const health = await api.health();
      set({ health });
    },

    loadProjects: async () => {
      const { projects } = await api.listProjects();
      set({ projects });
    },

    createProject: async (name) => {
      cancelAutosave();
      const project = await api.createProject(name);
      set({ project, playhead: 0, saveStatus: "saved" });
      await get().loadProjects();
    },

    openProject: async (id) => {
      cancelAutosave();
      const project = await api.getProject(id);
      set({
        project,
        playhead: 0,
        selectedAssetId: null,
        selectedKeyframeIds: [],
        focusedKeyframeId: null,
        selectedClipId: null,
        saveStatus: "saved",
      });
    },

    updateTimeline: (patch) => {
      const project = get().project;
      if (!project) return;
      set({ project: { ...project, ...patch } });
      scheduleAutosave();
    },

    saveTimeline: async () => {
      cancelAutosave();
      await persistProject();
    },

    flushSave: async () => {
      cancelAutosave();
      await persistProject();
    },

    setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
    setPlaying: (v) => set({ playing: v }),
    setZoom: (z) => set({ zoom: Math.min(200, Math.max(16, z)) }),
    selectAsset: (id) => set({ selectedAssetId: id }),

    deleteAsset: async (assetId) => {
      const { project, selectedAssetId } = get();
      if (!project) return;
      try {
        const { project: updated } = await api.deleteAsset(project.id, assetId);
        set({
          project: updated,
          selectedAssetId: selectedAssetId === assetId ? null : selectedAssetId,
          focusedKeyframeId: null,
          saveStatus: "saved",
        });
      } catch (err) {
        alert(err instanceof Error ? err.message : "Failed to delete asset");
      }
    },

    toggleKeyframeSelect: (id) => {
      const cur = get().selectedKeyframeIds;
      if (cur.includes(id)) {
        set({ selectedKeyframeIds: cur.filter((x) => x !== id) });
      } else if (cur.length >= 2) {
        set({ selectedKeyframeIds: [cur[1], id] });
      } else {
        set({ selectedKeyframeIds: [...cur, id] });
      }
    },

    clearKeyframeSelection: () => set({ selectedKeyframeIds: [] }),

    focusKeyframe: (id) => {
      const project = get().project;
      if (!project) return;
      const kf = project.keyframes.find((k) => k.id === id);
      if (!kf) return;
      set({
        focusedKeyframeId: id,
        playhead: kf.time,
        selectedAssetId: kf.asset_id,
        selectedClipId: null,
      });
    },

    clearKeyframeFocus: () => set({ focusedKeyframeId: null }),

    deleteKeyframe: (id) => {
      const { project, selectedKeyframeIds, focusedKeyframeId } = get();
      if (!project) return;
      const keyframes = project.keyframes.filter((k) => k.id !== id);
      set({
        project: { ...project, keyframes },
        selectedKeyframeIds: selectedKeyframeIds.filter((x) => x !== id),
        focusedKeyframeId: focusedKeyframeId === id ? null : focusedKeyframeId,
      });
      scheduleAutosave();
    },

    selectClip: (id) => {
      set({ selectedClipId: id, focusedKeyframeId: null, selectedKeyframeIds: [], selectedSegmentId: null });
    },

    deleteClip: (id) => {
      const { project, selectedClipId } = get();
      if (!project) return;
      const clips = project.clips.filter((c) => c.id !== id);
      set({
        project: { ...project, clips },
        selectedClipId: selectedClipId === id ? null : selectedClipId,
      });
      scheduleAutosave();
    },

    selectSegment: (id) => {
      set({ selectedSegmentId: id, selectedClipId: null, focusedKeyframeId: null, selectedKeyframeIds: [] });
    },

    setSegmentPrompt: (start: number, end: number, prompt: string, fromKfId?: string, toKfId?: string) => {
      const { project } = get();
      if (!project) return;
      const segs = [...(project.prompt_segments || [])];
      // Match existing segment by keyframe IDs first, then fallback to start/end
      const idx = segs.findIndex((s) =>
        (fromKfId && toKfId && ((s.from_kf_id === fromKfId && s.to_kf_id === toKfId) || s.id === `seg-${fromKfId}-${toKfId}`)) ||
        (Math.abs(s.start - start) < 0.05 && Math.abs(s.end - end) < 0.05)
      );
      const segId = fromKfId && toKfId ? `seg-${fromKfId}-${toKfId}` : crypto.randomUUID().slice(0, 8);
      if (idx >= 0) {
        segs[idx] = {
          ...segs[idx],
          prompt,
          start,
          end,
          from_kf_id: fromKfId || segs[idx].from_kf_id,
          to_kf_id: toKfId || segs[idx].to_kf_id,
        };
      } else {
        segs.push({ id: segId, start, end, prompt, from_kf_id: fromKfId, to_kf_id: toKfId });
      }
      set({ project: { ...project, prompt_segments: segs } });
      scheduleAutosave();
    },

    deleteSelected: () => {
      const { project, focusedKeyframeId, selectedKeyframeIds, selectedClipId } = get();
      if (!project) return;
      if (selectedClipId) {
        get().deleteClip(selectedClipId);
        return;
      }
      if (focusedKeyframeId) {
        get().deleteKeyframe(focusedKeyframeId);
        return;
      }
      if (selectedKeyframeIds.length > 0) {
        const keyframes = project.keyframes.filter((k) => !selectedKeyframeIds.includes(k.id));
        set({
          project: { ...project, keyframes },
          selectedKeyframeIds: [],
        });
        scheduleAutosave();
      }
    },

    moveKeyframe: (id, time) => {
      const project = get().project;
      if (!project) return;
      const keyframes = project.keyframes.map((kf) =>
        kf.id === id ? { ...kf, time: Math.max(0, time) } : kf,
      );
      keyframes.sort((a, b) => a.time - b.time);
      set({ project: { ...project, keyframes } });
      scheduleAutosave();
    },

    setActiveJob: (job) => set({ activeJob: job }),

    pollJob: async (jobId) => {
      const job = await api.getJob(jobId);
      if (job.status === "done") {
        cancelAutosave();
        const { project } = get();
        if (project) {
          const fresh = await api.getProject(project.id);
          set({ project: fresh, activeJob: null, saveStatus: "saved" });
        } else {
          set({ activeJob: null });
        }
        return job;
      }
      set({ activeJob: job });
      if (job.status === "error") {
        return job;
      }
      return null;
    },

    refreshProject: async () => {
      cancelAutosave();
      const { project } = get();
      if (!project) return;
      const fresh = await api.getProject(project.id);
      set({ project: fresh, saveStatus: "saved" });
    },
  };
});

export function neighborsAtTime(keyframes: Keyframe[], t: number): [Keyframe | null, Keyframe | null] {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  let left: Keyframe | null = null;
  let right: Keyframe | null = null;
  for (const kf of sorted) {
    if (kf.time <= t) left = kf;
    if (kf.time > t && !right) {
      right = kf;
      break;
    }
  }
  return [left, right];
}
