import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/api";
import { snapH3Duration, snapH3Frames, snapKeyframeToH3 } from "./lib/h3Utils";
import { neighborsAtTime, useStore } from "./store/projectStore";
import type { Asset, Job, Keyframe } from "./types";

function pillClass(status: string) {
  if (status === "up") return "pill ok";
  if (status === "busy") return "pill busy";
  return "pill down";
}

function formatTimecode(sec: number, fps: number = 24) {
  const totalFrames = Math.max(0, Math.floor(sec * fps));
  const f = totalFrames % fps;
  const totalSec = Math.floor(totalFrames / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

type BatchStatus = {
  running: boolean;
  total: number;
  currentIdx: number;
  currentLabel: string;
  error?: string;
};

function JobFloatingDock({
  job,
  batchStatus,
  onCancelBatch,
  onDone,
}: {
  job: Job | null;
  batchStatus: BatchStatus | null;
  onCancelBatch?: () => void;
  onDone: (finalJob: Job) => void;
}) {
  const pollJob = useStore((s) => s.pollJob);

  useEffect(() => {
    if (!job || ["done", "error"].includes(job.status)) return;
    let alive = true;
    const tick = async () => {
      while (alive) {
        const done = await pollJob(job.id);
        if (done) {
          onDone(done);
          return;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    };
    tick();
    return () => {
      alive = false;
    };
  }, [job?.id, onDone, pollJob]);

  const hasJob = Boolean(job && !["done", "error"].includes(job.status));
  const isBatch = Boolean(batchStatus && batchStatus.running);

  if (!hasJob && !isBatch) return null;

  const pct = isBatch
    ? Math.round(((batchStatus!.currentIdx) / Math.max(1, batchStatus!.total)) * 100)
    : job
    ? Math.round(((job.progress || 0) / (job.max || 100)) * 100)
    : 0;

  const title = isBatch
    ? `🎬 Storyboard Batch (${batchStatus!.currentIdx}/${batchStatus!.total})`
    : job?.kind === "video"
    ? "🎬 Rendering Video Clip"
    : job?.kind === "edit"
    ? "🎨 QwenEdit Keyframe"
    : "✨ Generating Image";

  const subtitle = isBatch
    ? batchStatus!.currentLabel
    : job?.phase || "Processing on GPU...";

  return (
    <div className="job-floating-dock" role="status" aria-live="polite">
      <div className="dock-header">
        <div className="dock-title-group">
          <div className="dock-spinner" />
          <span className="dock-title">{title}</span>
        </div>
        {isBatch && onCancelBatch && (
          <button
            className="dock-cancel-btn"
            title="Cancel background batch"
            onClick={onCancelBatch}
          >
            ✕ Stop Batch
          </button>
        )}
      </div>

      <div className="dock-body">
        <div className="dock-subtitle">{subtitle}</div>
        <div className="dock-progress-row">
          <div className="dock-progress-bar">
            <div className="dock-progress-fill" style={{ width: `${Math.max(5, pct)}%` }} />
          </div>
          <span className="dock-pct">{pct}%</span>
        </div>
      </div>
    </div>
  );
}

function PromptModal({
  title,
  initial,
  extra,
  onClose,
  onSubmit,
}: {
  title: string;
  initial?: string;
  extra?: React.ReactNode;
  onClose: () => void;
  onSubmit: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState(initial || "");
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {extra}
        <label>Prompt</label>
        <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus />
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSubmit(prompt)}>
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const {
    health,
    project,
    projects,
    activeJob,
    playhead,
    playing,
    selectedAssetId,
    selectedKeyframeIds,
    focusedKeyframeId,
    selectedClipId,
    selectedSegmentId,
    zoom,
    saveStatus,
    loadHealth,
    loadProjects,
    createProject,
    openProject,
    updateTimeline,
    flushSave,
    setPlayhead,
    setPlaying,
    setZoom,
    selectAsset,
    deleteAsset,
    toggleKeyframeSelect,
    clearKeyframeSelection,
    focusKeyframe,
    clearKeyframeFocus,
    deleteKeyframe,
    selectClip,
    deleteClip,
    selectSegment,
    setSegmentPrompt,
    deleteSelected,
    moveKeyframe,
    setActiveJob,
    pollJob,
  } = useStore();

  const [modal, setModal] = useState<null | "t2i" | "edit" | "between" | "video" | "batch">(null);
  const [gapRange, setGapRange] = useState<{ start: number; end: number } | null>(null);
  const [draggingPinId, setDraggingPinId] = useState<string | null>(null);
  const [loop, setLoop] = useState(false);
  const [isScrubbingRuler, setIsScrubbingRuler] = useState(false);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);

  // Batch Generation State
  const [batchStatus, setBatchStatus] = useState<BatchStatus>({
    running: false,
    total: 0,
    currentIdx: 0,
    currentLabel: "",
  });
  const cancelBatchRef = useRef(false);
  // Incremented when the active video slot flips (double-buffer) — triggers a re-render
  const [slotVersion, setSlotVersion] = useState(0);

  const importRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);   // slot A
  const videoRefB = useRef<HTMLVideoElement>(null);  // slot B
  const activeVideoSlot = useRef<"A" | "B">("A");   // which slot is currently visible
  const timelineCanvasRef = useRef<HTMLDivElement>(null);

  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    startTime: number;
    moved: boolean;
  } | null>(null);

  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    loadHealth();
    loadProjects();
    const id = setInterval(loadHealth, 8000);
    return () => clearInterval(id);
  }, [loadHealth, loadProjects]);

  useEffect(() => {
    const onLeave = () => {
      void useStore.getState().flushSave();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  const fps = project?.fps || 24;
  const duration = project?.duration || 30;

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!useStore.getState().playing);
      } else if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        deleteSelected();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        const step = e.shiftKey ? 1.0 : 1 / fps;
        setPlayhead(Math.max(0, useStore.getState().playhead - step));
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 1.0 : 1 / fps;
        setPlayhead(Math.min(duration, useStore.getState().playhead + step));
      } else if (e.code === "Home") {
        e.preventDefault();
        setPlayhead(0);
      } else if (e.code === "End") {
        e.preventDefault();
        setPlayhead(duration);
      } else if (e.code === "Escape") {
        clearKeyframeSelection();
        clearKeyframeFocus();
        selectClip(null);
        selectSegment(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fps, duration, deleteSelected, clearKeyframeSelection, clearKeyframeFocus, selectClip, selectSegment, setPlayhead, setPlaying]);

  const assetMap = useMemo(() => {
    const m = new Map<string, Asset>();
    for (const a of project?.assets || []) m.set(a.id, a);
    return m;
  }, [project?.assets]);

  // Compute all transition segments between consecutive keyframes
  const transitions = useMemo(() => {
    if (!project || project.keyframes.length < 2) return [];
    const sorted = [...project.keyframes].sort((a, b) => a.time - b.time);
    const list: Array<{
      id: string;
      left: Keyframe;
      right: Keyframe;
      start: number;
      end: number;
      duration: number;
      rawDuration?: number;
      frames: number;
      prompt: string;
      hasClip: boolean;
    }> = [];

    for (let i = 0; i < sorted.length - 1; i++) {
      const left = sorted[i];
      const right = sorted[i + 1];
      const start = left.time;
      const end = right.time;
      const rawDuration = Math.max(0.1, end - start);
      const segDuration = snapH3Duration(rawDuration, fps);
      const frames = snapH3Frames(rawDuration * fps);
      const segId = `seg-${left.id}-${right.id}`;

      const savedPrompt =
        (project.prompt_segments || []).find(
          (s) =>
            (s.from_kf_id === left.id && s.to_kf_id === right.id) ||
            s.id === segId ||
            (Math.abs(s.start - start) < 0.05 && Math.abs(s.end - end) < 0.05)
        )?.prompt || "";

      const hasClip = (project.clips || []).some(
        (c) => Math.abs(c.start - start) < 0.15 && Math.abs(c.end - end) < 0.15
      );

      list.push({
        id: segId,
        left,
        right,
        start,
        end,
        rawDuration,
        duration: segDuration,
        frames,
        prompt: savedPrompt,
        hasClip,
      });
    }
    return list;
  }, [project, fps]);

  const unfilledTransitions = useMemo(() => transitions.filter((t) => !t.hasClip), [transitions]);

  // Compute what should be displayed on the preview monitor
  const preview = useMemo(() => {
    if (!project) return null;
    if (focusedKeyframeId) {
      const kf = project.keyframes.find((k) => k.id === focusedKeyframeId);
      const asset = kf ? assetMap.get(kf.asset_id) : undefined;
      if (asset) return { kind: asset.kind, asset, keyframe: kf, isClip: false, clipOffset: 0 };
    }
    const clip = project.clips.find((c) => playhead >= c.start && playhead < c.end);
    if (clip) {
      const asset = assetMap.get(clip.asset_id);
      if (asset) {
        return {
          kind: "video" as const,
          asset,
          clip,
          isClip: true,
          clipOffset: Math.max(0, playhead - clip.start),
        };
      }
    }
    const sorted = [...project.keyframes].sort((a, b) => a.time - b.time);
    let current = sorted[0];
    for (const kf of sorted) {
      if (kf.time <= playhead) current = kf;
      else break;
    }
    if (!current) return null;
    const asset = assetMap.get(current.asset_id);
    if (!asset) return null;
    return { kind: asset.kind, asset, keyframe: current, isClip: false, clipOffset: 0 };
  }, [project, playhead, assetMap, focusedKe  // ── Double-buffer seamless clip switching ────────────────────────────────
  // Two <video> elements (slot A = videoRef, slot B = videoRefB) are always
  // mounted. We preload the incoming clip into the idle slot and only flip
  // opacity after the target frame is confirmed ready (seeked event).
  // This eliminates black frames AND wrong-first-frame flashes in both
  // forward and backward directions.

  const seekAndFlip = useCallback((
    inactiveEl: HTMLVideoElement,
    activeEl: HTMLVideoElement | null,
    fromSlot: "A" | "B",
    targetTime: number,
    onFlip: () => void,
  ) => {
    // Pause the currently-visible slot so it doesn't race to its end and go black
    if (activeEl && !activeEl.paused) activeEl.pause();

    const doFlip = () => {
      activeVideoSlot.current = fromSlot === "A" ? "B" : "A";
      setSlotVersion((v) => v + 1);
      onFlip();
    };

    // If the element already has this exact frame decoded, flip immediately
    if (Math.abs(inactiveEl.currentTime - targetTime) < 0.04 && inactiveEl.readyState >= 2) {
      doFlip();
      return () => {};
    }

    inactiveEl.currentTime = targetTime;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      inactiveEl.removeEventListener("seeked", finish);
      clearTimeout(fallback);
      doFlip();
    };
    // Safety net: if seeked never fires (e.g. already at position), flip after 150ms
    const fallback = setTimeout(finish, 150) as unknown as number;
    inactiveEl.addEventListener("seeked", finish, { once: true });

    return () => {
      done = true;
      inactiveEl.removeEventListener("seeked", finish);
      clearTimeout(fallback);
    };
  }, []);

  useEffect(() => {
    if (!preview?.isClip || !project) return;
    const nextSrc = api.assetUrl(project.id, preview.asset.file);
    const capturedOffset = preview.clipOffset;

    const activeSlot  = activeVideoSlot.current;
    const activeEl    = (activeSlot === "A" ? videoRef  : videoRefB).current;
    const inactiveEl  = (activeSlot === "A" ? videoRefB : videoRef).current;
    const activeSrc   = activeSlot === "A" ? slotSrcA  : slotSrcB;
    const inactiveSrc = activeSlot === "A" ? slotSrcB  : slotSrcA;

    // ── Case 1: active slot already has this clip ────────────────────────────
    if (activeSrc.current === nextSrc) {
      if (activeEl && Math.abs(activeEl.currentTime - capturedOffset) > 0.1) {
        activeEl.currentTime = capturedOffset;
      }
      return;
    }

    if (!inactiveEl) return;

    // Helper to get the freshest clip offset at flip time
    const getLiveOffset = () => {
      const ph = useStore.getState().playhead;
      const cl = useStore.getState().project?.clips.find(
        (c) => c.start <= ph && ph < c.end + 0.1
      );
      return cl ? Math.max(0, ph - cl.start) : capturedOffset;
    };

    // ── Case 2: very first clip ever — load directly into the active slot ────
    if (!activeSrc.current) {
      if (!activeEl) return;
      activeSrc.current = nextSrc;
      activeEl.src = nextSrc;
      activeEl.load();
      activeEl.addEventListener("canplay", () => {
        activeEl.currentTime = getLiveOffset();
        activeEl.addEventListener("seeked", () => setSlotVersion((v) => v + 1), { once: true });
        setTimeout(() => setSlotVersion((v) => v + 1), 200);
      }, { once: true });
      return;
    }

    // ── Case 3: idle slot already holds this clip (scrubbing backward, loop, etc) ─
    // No reload needed — just seek it to the right frame then flip.
    if (inactiveSrc.current === nextSrc) {
      const cleanup = seekAndFlip(inactiveEl, activeEl, activeSlot, getLiveOffset(), () => {
        // If we were playing, resume on the newly-active slot
        if (useStore.getState().playing) {
          const newVid = (activeVideoSlot.current === "A" ? videoRef : videoRefB).current;
          newVid?.play().catch(() => {});
        }
      });
      return cleanup;
    }

    // ── Case 4: new clip — load into idle slot, then seek-and-flip ──────────
    inactiveSrc.current = nextSrc;
    inactiveEl.src = nextSrc;
    inactiveEl.load();

    let cancelled = false;
    const onCanPlay = () => {
      if (cancelled) return;
      const targetOffset = getLiveOffset();
      const cleanup = seekAndFlip(inactiveEl, activeEl, activeSlot, targetOffset, () => {
        if (useStore.getState().playing) {
          const newVid = (activeVideoSlot.current === "A" ? videoRef : videoRefB).current;
          newVid?.play().catch(() => {});
        }
      });
      return cleanup;
    };
    inactiveEl.addEventListener("canplay", onCanPlay, { once: true });
    return () => {
      cancelled = true;
      inactiveEl.removeEventListener("canplay", onCanPlay);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.asset?.file, seekAndFlip]);

  // Sync offset when scrubbing within a clip (not at clip boundaries)
  useEffect(() => {
    if (!preview?.isClip) return;
    const activeEl = (activeVideoSlot.current === "A" ? videoRef : videoRefB).current;
    if (!activeEl) return;
    const t = preview.clipOffset;
    if (Math.abs(activeEl.currentTime - t) > 0.1) {
      activeEl.currentTime = t;
    }
  }, [preview?.clipOffset, preview?.isClip]);
getTime;
      }
    }
  }, [preview?.clipOffset, preview?.isClip]);

  // Master Playback Loop
  useEffect(() => {
    const activeVid = () => (activeVideoSlot.current === "A" ? videoRef.current : videoRefB.current);
    if (!playing || !project) {
      const vid = activeVid();
      if (vid && !vid.paused) vid.pause();
      return;
    }

    if (preview?.isClip) {
      activeVid()?.play().catch(() => {});
    }

    let lastTime = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const cur = useStore.getState().playhead;
      const next = cur + dt;

      if (next >= project.duration) {
        if (loop) {
          setPlayhead(0);
          rafRef.current = requestAnimationFrame(tick);
        } else {
          setPlayhead(0);
          setPlaying(false);
        }
        return;
      }

      setPlayhead(next);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, project, loop, preview?.isClip, setPlayhead, setPlaying]);

  const onJobDone = useCallback(
    async (job: Job) => {
      if (job.status === "error") {
        alert(job.error || "Generation failed");
      }
      setActiveJob(null);
    },
    [setActiveJob],
  );

  const startJob = async (runner: () => Promise<Job>) => {
    try {
      const job = await runner();
      setActiveJob(job);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Generation failed");
    }
  };

  // Run Batch Storyboard Generation (dynamically adjusts to timeline retiming and supports filling remaining videos)
  const runBatchGeneration = async (onlyUnfilled = false) => {
    const proj = useStore.getState().project;
    if (!proj || proj.keyframes.length < 2) {
      alert("Need at least 2 keyframes to generate video transitions.");
      return;
    }

    cancelBatchRef.current = false;
    setModal(null);
    const initialKfs = [...proj.keyframes].sort((a, b) => a.time - b.time);
    const totalCuts = initialKfs.length - 1;

    setBatchStatus({
      running: true,
      total: totalCuts,
      currentIdx: 0,
      currentLabel: onlyUnfilled ? "Filling remaining video cuts..." : "Starting storyboard batch render...",
    });

    for (let cutIdx = 0; cutIdx < totalCuts; cutIdx++) {
      if (cancelBatchRef.current) {
        break;
      }

      // Dynamically fetch fresh project state before each cut
      const currentProj = useStore.getState().project;
      if (!currentProj || currentProj.keyframes.length < 2) break;

      const currentSorted = [...currentProj.keyframes].sort((a, b) => a.time - b.time);
      if (cutIdx >= currentSorted.length - 1) break;

      const left = currentSorted[cutIdx];
      const right = currentSorted[cutIdx + 1];
      const start = left.time;
      const end = right.time;

      // Check if clip already exists covering this segment
      const hasClip = (currentProj.clips || []).some(
        (c) => Math.abs(c.start - start) < 0.15 && Math.abs(c.end - end) < 0.15
      );

      if (onlyUnfilled && hasClip) {
        setBatchStatus((prev) => ({
          ...prev,
          currentIdx: cutIdx + 1,
          currentLabel: `Cut ${cutIdx + 1}/${totalCuts} already rendered. Skipping...`,
        }));
        continue;
      }

      const leftAsset = currentProj.assets.find((a) => a.id === left.asset_id);
      const rightAsset = currentProj.assets.find((a) => a.id === right.asset_id);
      if (!leftAsset || !rightAsset) continue;

      const segPromptObj = (currentProj.prompt_segments || []).find(
        (s) =>
          (s.from_kf_id === left.id && s.to_kf_id === right.id) ||
          s.id === `seg-${left.id}-${right.id}` ||
          (Math.abs(s.start - start) < 0.05 && Math.abs(s.end - end) < 0.05)
      );

      const segPrompt =
        segPromptObj?.prompt.trim() ||
        `Smooth cinematic motion from initial frame toward ending frame. Natural lighting and character consistency.`;

      setBatchStatus({
        running: true,
        total: totalCuts,
        currentIdx: cutIdx + 1,
        currentLabel: `Rendering Cut ${cutIdx + 1}/${totalCuts} (${start.toFixed(1)}s ➔ ${end.toFixed(1)}s)...`,
      });

      try {
        const segDur = Math.max(0.5, end - start);
        const job = await api.generateVideo(currentProj.id, {
          prompt: segPrompt,
          first_asset_id: leftAsset.id,
          last_asset_id: rightAsset.id,
          gap_start: start,
          gap_end: end,
          duration_seconds: segDur,
        });

        // Poll this segment job until finished
        let done = false;
        while (!done && !cancelBatchRef.current) {
          await new Promise((r) => setTimeout(r, 1500));
          const checked = await pollJob(job.id);
          if (checked) {
            done = true;
            if (checked.status === "error") {
              throw new Error(checked.error || "Cut generation failed");
            }
          }
        }
      } catch (err) {
        setBatchStatus((prev) => ({
          ...prev,
          running: false,
          error: err instanceof Error ? err.message : "Generation error",
        }));
        alert(`Error on Cut ${cutIdx + 1}: ${err instanceof Error ? err.message : "Unknown error"}`);
        return;
      }
    }

    setBatchStatus({
      running: false,
      total: totalCuts,
      currentIdx: totalCuts,
      currentLabel: "Batch generation complete!",
    });
    setModal(null);
  };

  const timelineWidth = Math.max(800, duration * zoom + 160);

  // Ruler Scrubbing handler
  const handleRulerScrub = useCallback(
    (e: React.PointerEvent) => {
      if (!timelineCanvasRef.current) return;
      const rect = timelineCanvasRef.current.getBoundingClientRect();
      const scrollLeft = timelineCanvasRef.current.scrollLeft;
      const clientX = e.clientX;
      const trackX = clientX - rect.left + scrollLeft - 90; // 90px track label offset
      const newTime = Math.max(0, Math.min(duration, trackX / zoom));
      clearKeyframeFocus();
      setPlayhead(newTime);
    },
    [duration, zoom, clearKeyframeFocus, setPlayhead],
  );

  const onRulerPointerDown = (e: React.PointerEvent) => {
    setIsScrubbingRuler(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    handleRulerScrub(e);
  };

  const onRulerPointerMove = (e: React.PointerEvent) => {
    if (isScrubbingRuler) {
      handleRulerScrub(e);
    }
  };

  const onRulerPointerUp = () => {
    setIsScrubbingRuler(false);
  };

  // Keyframe Pin Dragging handler
  const onPinDown = (id: string, time: number, e: React.PointerEvent) => {
    e.stopPropagation();
    dragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      startTime: time,
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPinMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      drag.moved = true;
      setDraggingPinId(drag.id);
    }
    if (drag.moved && project) {
      const rawTime = Math.max(0, drag.startTime + dx / zoom);
      const snapped = snapKeyframeToH3(project.keyframes, drag.id, rawTime, fps);
      moveKeyframe(drag.id, snapped.time);
    }
  };

  const onPinUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved) {
      if (e.shiftKey) {
        toggleKeyframeSelect(drag.id);
      } else {
        focusKeyframe(drag.id);
      }
    } else if (project) {
      const dx = e.clientX - drag.startX;
      const rawTime = Math.max(0, drag.startTime + dx / zoom);
      const snapped = snapKeyframeToH3(project.keyframes, drag.id, rawTime, fps);
      moveKeyframe(drag.id, snapped.time);
      void flushSave();
    }
    dragRef.current = null;
    setDraggingPinId(null);
  };

  const selectedAssets = (selectedKeyframeIds || [])
    .map((id) => project?.keyframes.find((k) => k.id === id))
    .filter(Boolean)
    .map((kf) => assetMap.get(kf!.asset_id))
    .filter(Boolean) as Asset[];

  const comfyReady =
    health &&
    health.comfyui !== "down" &&
    (!health.require_idle_gpu || (health.comfyui !== "busy" && !health.comfy_busy));

  const qwenReady =
    health &&
    health.qwenedit !== "down" &&
    (!health.require_idle_gpu || health.qwenedit !== "busy");

  return (
    <div className="app-shell">
      {/* Top Header */}
      <header className="topbar">
        <div className="brand-group">
          <div className="brand-logo">FF</div>
          <h1>FrameForge</h1>
        </div>
        <select
          className="project-select"
          value={project?.id || ""}
          onChange={(e) => e.target.value && openProject(e.target.value)}
        >
          <option value="">Select project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn ghost" onClick={() => createProject(`Project ${projects.length + 1}`)}>
          ＋ New
        </button>

        <div className="header-actions">
          <button
            className="btn batch-btn"
            disabled={!project || transitions.length === 0 || !comfyReady || batchStatus.running}
            onClick={() => setModal("batch")}
            title="Batch render all transition prompts into video clips in one shot"
          >
            ⚡ Generate Whole Video ({transitions.length} cuts)
          </button>
          <button className="btn primary" disabled={!project || !comfyReady} onClick={() => setModal("t2i")}>
            Base Image (T2I)
          </button>
          <button
            className="btn"
            disabled={!project || !selectedAssetId || !qwenReady}
            onClick={() => setModal("edit")}
          >
            Edit Keyframe
          </button>
          <button
            className="btn"
            disabled={!project || selectedAssets.length !== 2 || !qwenReady}
            onClick={() => setModal("between")}
          >
            Generate Between
          </button>
        </div>
      </header>

      {!project ? (
        <div className="empty-state">
          <p>Create or open a project to start storyboarding.</p>
          <p>FrameForge connects to your existing QwenEdit (8741) and ComfyUI (8188).</p>
        </div>
      ) : (
        <div className="main-grid">
          {/* Media Pool Panel */}
          <aside className="panel media-pool-panel">
            <div className="panel-header">
              <span>Media Pool</span>
              <button
                className="btn ghost small-btn"
                disabled={!project}
                onClick={() => importRef.current?.click()}
                title="Import Image or Video"
              >
                ＋ Import
              </button>
              <input
                ref={importRef}
                type="file"
                accept="image/*,video/mp4,video/webm"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file || !project) return;
                  try {
                    const { project: updated } = await api.importAsset(project.id, file);
                    useStore.setState({ project: updated, saveStatus: "saved" });
                  } catch (err) {
                    alert(err instanceof Error ? err.message : "Import failed");
                  }
                }}
              />
            </div>
            <div className="assets-grid">
              {project.assets.length === 0 && (
                <div className="empty-state" style={{ gridColumn: "1 / -1" }}>
                  <p>No media yet.</p>
                  <button
                    className="btn primary"
                    style={{ marginTop: 8 }}
                    disabled={!comfyReady}
                    onClick={() => setModal("t2i")}
                  >
                    Generate base image
                  </button>
                </div>
              )}
              {project.assets.map((asset) => (
                <div
                  key={asset.id}
                  className={`asset-card ${selectedAssetId === asset.id ? "selected" : ""}`}
                  onClick={() => {
                    clearKeyframeFocus();
                    selectClip(null);
                    selectSegment(null);
                    selectAsset(asset.id);
                  }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("assetId", asset.id);
                  }}
                >
                  <div className="asset-thumb-container">
                    {asset.kind === "video" ? (
                      <div className="thumb video-thumb">
                        <span className="kind-badge">VIDEO</span>
                      </div>
                    ) : (
                      <img src={api.assetUrl(project.id, asset.file)} alt={asset.label} />
                    )}
                    <button
                      className="asset-delete-btn"
                      title="Delete asset from project"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${asset.label || asset.file}"? It will also be removed from timeline.`)) {
                          void deleteAsset(asset.id);
                        }
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="label" title={asset.label || asset.file}>
                    {asset.label || asset.file}
                  </div>
                </div>
              ))}
            </div>
          </aside>

          {/* Center Column: Pro Monitor + Multi-Track Timeline */}
          <section className="center-column">
            {/* Program Monitor */}
            <div className="preview-wrap">
              <div className="monitor-header">
                <div className="monitor-title">
                  {preview?.isClip ? (
                    <span className="badge-clip">CLIP: {preview.asset.label || preview.asset.file}</span>
                  ) : preview?.keyframe ? (
                    <span className="badge-keyframe">KEYFRAME @ {preview.keyframe.time.toFixed(2)}s</span>
                  ) : (
                    <span className="badge-idle">STORYBOARD PREVIEW</span>
                  )}
                </div>
                <div className="monitor-timecode">{formatTimecode(playhead, fps)}</div>
              </div>

              <div className="preview-stage">
                {!preview && (
                  <div className="monitor-placeholder">
                    <div className="monitor-crosshair" />
                    <p>No keyframe or clip at {formatTimecode(playhead, fps)}</p>
                  </div>
                )}
                {/* Dual-slot double-buffer: both <video> elements always mounted.
                    slotVersion is read here so React re-renders when the active slot flips. */}
                {(() => {
                  void slotVersion; // consumed for reactivity
                  const showA = preview?.kind === "video" && activeVideoSlot.current === "A";
                  const showB = preview?.kind === "video" && activeVideoSlot.current === "B";
                  return (
                    <>
                      <video
                        ref={videoRef}
                        playsInline
                        muted
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                          opacity: showA ? 1 : 0,
                          pointerEvents: "none",
                        }}
                      />
                      <video
                        ref={videoRefB}
                        playsInline
                        muted
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                          opacity: showB ? 1 : 0,
                          pointerEvents: "none",
                        }}
                      />
                    </>
                  );
                })()}
                {preview && preview.kind === "image" && (
                  <img src={api.assetUrl(project.id, preview.asset.file)} alt="preview" />
                )}
              </div>

              {/* NLE Transport Bar */}
              <div className="transport-bar">
                <div className="transport-left">
                  <span className="tc-display">{formatTimecode(playhead, fps)}</span>
                  <span className="tc-fps">/ {fps} FPS</span>
                </div>

                <div className="transport-center">
                  <button
                    className="transport-btn"
                    title="Jump to Start (Home)"
                    onClick={() => setPlayhead(0)}
                  >
                    ⏮
                  </button>
                  <button
                    className="transport-btn"
                    title="Step 1 Frame Back (Left Arrow)"
                    onClick={() => setPlayhead(Math.max(0, playhead - 1 / fps))}
                  >
                    ◀
                  </button>
                  <button
                    className={`transport-btn play-btn ${playing ? "is-playing" : ""}`}
                    title="Play / Pause (Space)"
                    onClick={() => setPlaying(!playing)}
                  >
                    {playing ? "⏸" : "▶"}
                  </button>
                  <button
                    className="transport-btn"
                    title="Step 1 Frame Forward (Right Arrow)"
                    onClick={() => setPlayhead(Math.min(duration, playhead + 1 / fps))}
                  >
                    ▶
                  </button>
                  <button
                    className="transport-btn"
                    title="Jump to End (End)"
                    onClick={() => setPlayhead(duration)}
                  >
                    ⏭
                  </button>
                  <button
                    className={`transport-btn loop-btn ${loop ? "active" : ""}`}
                    title="Toggle Loop Playback"
                    onClick={() => setLoop(!loop)}
                  >
                    🔁
                  </button>
                </div>

                <div className="transport-right">
                  <span className="tc-total">TOTAL: {formatTimecode(duration, fps)}</span>
                  <div className="zoom-controls">
                    <button className="zoom-btn" onClick={() => setZoom(zoom - 16)} title="Zoom Out">
                      －
                    </button>
                    <input
                      type="range"
                      min={24}
                      max={160}
                      value={zoom}
                      onChange={(e) => setZoom(parseFloat(e.target.value))}
                      className="zoom-slider"
                      title="Timeline Zoom"
                    />
                    <button className="zoom-btn" onClick={() => setZoom(zoom + 16)} title="Zoom In">
                      ＋
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Pro NLE Timeline with Prompt Track */}
            <div className="timeline-wrap">
              <div className="timeline-toolbar">
                <div className="toolbar-hints">
                  <span>✍️ Enter prompts in the Prompt Track</span>
                  <span>• ⚡ Dynamically fill remaining cuts</span>
                  <span>• 🖱 Click/drag ruler to scrub</span>
                  <span>• ⎵ Space: Play/Pause</span>
                </div>
                <div className="toolbar-actions">
                  {unfilledTransitions.length > 0 && unfilledTransitions.length < transitions.length ? (
                    <>
                      <button
                        className="btn batch-btn small-btn"
                        disabled={!comfyReady}
                        onClick={() => runBatchGeneration(true)}
                        title="Render only unfilled video cuts"
                      >
                        ⚡ Fill Remaining ({unfilledTransitions.length})
                      </button>
                      <button
                        className="btn ghost small-btn"
                        disabled={!comfyReady}
                        onClick={() => setModal("batch")}
                        title="Open Storyboard Batch Director"
                      >
                        🎬 Script Director ({transitions.length})
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn batch-btn small-btn"
                      disabled={transitions.length === 0 || !comfyReady}
                      onClick={() => setModal("batch")}
                    >
                      ⚡ Storyboard Director ({transitions.length} cuts)
                    </button>
                  )}
                  {(focusedKeyframeId || selectedClipId || selectedKeyframeIds.length > 0) && (
                    <button
                      className="btn danger-btn small-btn"
                      onClick={deleteSelected}
                      title="Delete selected item (Delete)"
                    >
                      ✕ Delete Selected
                    </button>
                  )}
                  <button className="btn ghost small-btn" onClick={clearKeyframeSelection}>
                    Clear Selection
                  </button>
                </div>
              </div>

              <div
                className="timeline-canvas"
                ref={timelineCanvasRef}
                onClick={(e) => {
                  if (e.target === e.currentTarget) {
                    clearKeyframeFocus();
                    selectClip(null);
                    selectSegment(null);
                  }
                }}
              >
                {/* Track Headers (Left sticky) */}
                <div className="track-headers-column">
                  <div className="track-header ruler-header">TIME</div>
                  <div className="track-header prompt-track-header">TXT Prompt</div>
                  <div className="track-header video-track-header">V1 Video</div>
                  <div className="track-header keyframes-track-header">KF Pin</div>
                </div>

                {/* Timeline Tracks Area */}
                <div className="timeline-tracks-area" style={{ width: timelineWidth }}>
                  {/* Time Ruler */}
                  <div
                    className="timeline-ruler"
                    onPointerDown={onRulerPointerDown}
                    onPointerMove={onRulerPointerMove}
                    onPointerUp={onRulerPointerUp}
                  >
                    {Array.from({ length: Math.ceil(duration) + 1 }).map((_, sec) => (
                      <div
                        key={sec}
                        className="ruler-tick-major"
                        style={{ left: sec * zoom }}
                      >
                        <span className="tick-label">{sec}s</span>
                      </div>
                    ))}
                  </div>

                  {/* Vertical Playhead Cursor */}
                  <div
                    className="timeline-playhead-cursor"
                    style={{ left: `${playhead * zoom}px` }}
                  >
                    <div
                      className="playhead-head"
                      onPointerDown={onRulerPointerDown}
                      onPointerMove={onRulerPointerMove}
                      onPointerUp={onRulerPointerUp}
                    >
                      <div className="playhead-badge">{formatTimecode(playhead, fps).slice(3)}</div>
                    </div>
                    <div className="playhead-needle" />
                  </div>

                  {/* Track 0: Prompt Track */}
                  <div className="timeline-track prompt-track">
                    {transitions.map((t) => {
                      const isSelected = selectedSegmentId === t.id;
                      const isEditing = editingSegmentId === t.id;
                      const width = Math.max(60, t.duration * zoom);

                      return (
                        <div
                          key={t.id}
                          className={`prompt-block ${isSelected ? "selected" : ""} ${t.hasClip ? "has-clip" : ""}`}
                          style={{ left: t.start * zoom, width }}
                          onClick={(e) => {
                            e.stopPropagation();
                            selectSegment(t.id);
                            setEditingSegmentId(t.id);
                          }}
                          title={`Transition Prompt (${t.duration.toFixed(1)}s)`}
                        >
                          <div className="prompt-block-header">
                            <span className="prompt-time-tag">
                              {t.start.toFixed(2)}s ➔ {t.end.toFixed(2)}s ({t.duration.toFixed(2)}s • {t.frames}f)
                            </span>
                            <div className="prompt-block-status">
                              {t.hasClip ? (
                                <span className="status-pill ready">✓ Clip</span>
                              ) : (
                                <button
                                  className="mini-render-btn"
                                  title="Render this segment"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    const leftAsset = assetMap.get(t.left.asset_id);
                                    const rightAsset = assetMap.get(t.right.asset_id);
                                    if (!leftAsset || !rightAsset) return;
                                    const segDur = Math.max(0.5, t.end - t.start);
                                    startJob(() =>
                                      api.generateVideo(project.id, {
                                        prompt: t.prompt.trim() || "Smooth cinematic transition toward next keyframe",
                                        first_asset_id: leftAsset.id,
                                        last_asset_id: rightAsset.id,
                                        gap_start: t.start,
                                        gap_end: t.end,
                                        duration_seconds: segDur,
                                      })
                                    );
                                  }}
                                >
                                  ⚡ Render
                                </button>
                              )}
                            </div>
                          </div>
                          {isEditing ? (
                            <input
                              className="prompt-inline-input"
                              value={t.prompt}
                              autoFocus
                              placeholder="Action/motion description..."
                              onChange={(ev) => {
                                setSegmentPrompt(t.start, t.end, ev.target.value, t.left.id, t.right.id);
                              }}
                              onBlur={() => setEditingSegmentId(null)}
                              onKeyDown={(ev) => {
                                if (ev.key === "Enter") setEditingSegmentId(null);
                              }}
                              onClick={(ev) => ev.stopPropagation()}
                            />
                          ) : (
                            <div className="prompt-text-preview">
                              {t.prompt.trim() ? (
                                t.prompt
                              ) : (
                                <span className="placeholder-text">＋ Click to write transition prompt…</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Track 1: Video Clips */}
                  <div
                    className="timeline-track clips-track"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const assetId = e.dataTransfer.getData("assetId");
                      const asset = project.assets.find((a) => a.id === assetId);
                      if (!asset || asset.kind !== "video") return;
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const x = e.clientX - rect.left;
                      const time = Math.max(0, x / zoom);
                      const clips = [
                        ...project.clips,
                        { id: crypto.randomUUID().slice(0, 8), asset_id: assetId, start: time, end: time + 3.0, label: asset.label },
                      ];
                      updateTimeline({ clips });
                    }}
                  >
                    {/* Gap Transition Trigger Areas */}
                    {transitions.map((t) => {
                      const left = t.start * zoom;
                      const width = t.duration * zoom;
                      return (
                        <div
                          key={`gap-${t.id}`}
                          className="gap-hit"
                          style={{ left, width }}
                          title={`Click to generate video between keyframes (${t.duration.toFixed(1)}s)`}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setGapRange({ start: t.start, end: t.end });
                            setModal("video");
                          }}
                        >
                          <span className="gap-label">＋ Video</span>
                        </div>
                      );
                    })}

                    {/* Clip Blocks */}
                    {project.clips.map((clip) => {
                      const asset = assetMap.get(clip.asset_id);
                      const isSelected = selectedClipId === clip.id;
                      return (
                        <div
                          key={clip.id}
                          className={`clip-block ${isSelected ? "selected" : ""}`}
                          style={{ left: clip.start * zoom, width: Math.max(40, (clip.end - clip.start) * zoom) }}
                          onClick={(e) => {
                            e.stopPropagation();
                            selectClip(clip.id);
                          }}
                        >
                          <div className="clip-header">
                            <span className="clip-title">{clip.label || asset?.label || "Video Clip"}</span>
                            <button
                              className="clip-delete-btn"
                              title="Delete clip from timeline"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteClip(clip.id);
                              }}
                            >
                              ✕
                            </button>
                          </div>
                          <div className="clip-duration">{(clip.end - clip.start).toFixed(1)}s</div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Track 2: Keyframe Pins */}
                  <div
                    className="timeline-track keyframes-track"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const assetId = e.dataTransfer.getData("assetId");
                      const asset = project.assets.find((a) => a.id === assetId);
                      if (!asset) return;
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const x = e.clientX - rect.left;
                      const rawTime = Math.max(0, x / zoom);
                      const tempId = crypto.randomUUID().slice(0, 8);
                      const snapped = snapKeyframeToH3(project.keyframes, tempId, rawTime, fps);
                      const keyframes = [
                        ...project.keyframes,
                        { id: tempId, asset_id: assetId, time: snapped.time, label: asset.label },
                      ].sort((a, b) => a.time - b.time);
                      updateTimeline({ keyframes });
                    }}
                  >
                    {project.keyframes.map((kf) => {
                      const asset = assetMap.get(kf.asset_id);
                      const focused = focusedKeyframeId === kf.id;
                      const selected = selectedKeyframeIds.includes(kf.id);
                      return (
                        <div
                          key={kf.id}
                          className={`keyframe-pin ${focused ? "focused" : ""} ${selected ? "selected" : ""} ${draggingPinId === kf.id ? "dragging" : ""}`}
                          style={{ left: kf.time * zoom }}
                          onPointerDown={(e) => {
                            if ((e.target as HTMLElement).closest(".keyframe-delete-btn")) return;
                            onPinDown(kf.id, kf.time, e);
                          }}
                          onPointerMove={onPinMove}
                          onPointerUp={onPinUp}
                          onClick={(e) => e.stopPropagation()}
                          title={`${kf.label || asset?.label || "Keyframe"} @ ${kf.time.toFixed(2)}s`}
                        >
                          <div className="keyframe-thumb">
                            {asset?.kind === "image" ? (
                              <img src={api.assetUrl(project.id, asset.file)} alt="" />
                            ) : (
                              <div className="thumb-vid-tag">VID</div>
                            )}
                          </div>
                          <button
                            className="keyframe-delete-btn"
                            title="Delete keyframe"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteKeyframe(kf.id);
                            }}
                          >
                            ✕
                          </button>
                          <div className="keyframe-diamond" />
                          <div className="keyframe-time">{kf.time.toFixed(1)}s</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Status Bar */}
      <footer className="statusbar">
        <span className={pillClass(health?.comfyui || "down")}>ComfyUI: {health?.comfyui || "…"}</span>
        <span className={pillClass(health?.qwenedit || "down")}>
          QwenEdit: {health?.qwenedit || "…"}
          {health?.qwenedit === "down" ? " (start QwenEdit for edits)" : ""}
        </span>
        <span>{health?.require_idle_gpu ? "GPU guard on" : "GPU guard off"}</span>
        {saveStatus === "pending" && <span style={{ color: "var(--muted)" }}>Saving…</span>}
        {saveStatus === "saving" && <span style={{ color: "var(--muted)" }}>Saving…</span>}
        {saveStatus === "saved" && <span style={{ color: "var(--success)" }}>Saved</span>}
        {saveStatus === "error" && <span style={{ color: "var(--danger)" }}>Save failed</span>}
        {!comfyReady && <span style={{ color: "#fbbf24" }}>ComfyUI not ready for T2I / video</span>}
        {!qwenReady && health?.qwenedit === "down" && (
          <span style={{ color: "#fbbf24" }}>Start QwenEdit for edit / between</span>
        )}
      </footer>

      <JobFloatingDock
        job={activeJob}
        batchStatus={batchStatus}
        onCancelBatch={() => {
          cancelBatchRef.current = true;
          setBatchStatus((prev) => ({ ...prev, running: false, currentLabel: "Cancelled" }));
        }}
        onDone={onJobDone}
      />

      {/* Batch Render Whole Video Modal */}
      {modal === "batch" && project && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal batch-modal" onClick={(e) => e.stopPropagation()}>
            <h2>⚡ Batch Storyboard Director</h2>
            <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
              Review prompt scripts and target durations for all {transitions.length} cuts. You can start rendering in the background and continue editing or scrubbing the timeline.
            </p>

            {batchStatus.running && (
              <div className="batch-running-banner">
                <div className="batch-spinner" />
                <div className="batch-status-text">
                  <strong>{batchStatus.currentLabel}</strong>
                  <div className="progress">
                    <span
                      style={{
                        width: `${Math.round(((batchStatus.currentIdx) / Math.max(1, batchStatus.total)) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <button
                  className="btn danger-btn small-btn"
                  onClick={() => {
                    cancelBatchRef.current = true;
                    setBatchStatus((prev) => ({ ...prev, running: false, currentLabel: "Cancelled" }));
                  }}
                >
                  Cancel
                </button>
              </div>
            )}

            <div className="batch-script-list">
              {transitions.map((t, idx) => (
                <div key={t.id} className="batch-script-row">
                  <div className="batch-row-header">
                    <span className="batch-cut-badge">Cut #{idx + 1}</span>
                    <span className="batch-time-range">
                      {t.start.toFixed(2)}s ➔ {t.end.toFixed(2)}s ({t.duration.toFixed(2)}s • {t.frames}f)
                    </span>
                    <div className="batch-dur-presets">
                      {[3.04, 3.75, 4.46, 5.17, 6.58, 8.00].map((dur) => (
                        <button
                          key={dur}
                          type="button"
                          className={`mini-dur-btn ${Math.abs(t.duration - dur) < 0.2 ? "active" : ""}`}
                          disabled={batchStatus.running}
                          title={`Set cut duration to ${dur}s`}
                          onClick={() => {
                            if (!project) return;
                            const sorted = [...project.keyframes].sort((a, b) => a.time - b.time);
                            if (idx >= sorted.length - 1) return;
                            const rightKf = sorted[idx + 1];
                            const newRightTime = Math.round((t.left.time + dur) * 100) / 100;
                            const delta = newRightTime - rightKf.time;
                            const updated = project.keyframes.map((k) => {
                              if (k.id === rightKf.id) return { ...k, time: newRightTime };
                              if (k.time > rightKf.time) return { ...k, time: Math.round((k.time + delta) * 100) / 100 };
                              return k;
                            }).sort((a, b) => a.time - b.time);
                            updateTimeline({ keyframes: updated });
                          }}
                        >
                          {dur}s
                        </button>
                      ))}
                    </div>
                    {t.hasClip ? (
                      <span className="status-pill ready">✓ Video Ready</span>
                    ) : (
                      <span className="status-pill draft">⚡ Needs Render</span>
                    )}
                  </div>
                  <textarea
                    rows={2}
                    className="batch-prompt-input"
                    value={t.prompt}
                    disabled={batchStatus.running}
                    placeholder="Describe camera movement, character action, and lighting for this transition..."
                    onChange={(e) => {
                      setSegmentPrompt(t.start, t.end, e.target.value, t.left.id, t.right.id);
                    }}
                  />
                </div>
              ))}
            </div>

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button
                className="btn ghost"
                disabled={batchStatus.running}
                onClick={() => setModal(null)}
              >
                Close
              </button>
              {unfilledTransitions.length > 0 && (
                <button
                  className="btn primary"
                  disabled={batchStatus.running || !comfyReady}
                  onClick={() => runBatchGeneration(true)}
                  title="Generate only the missing cuts"
                >
                  {batchStatus.running ? "Rendering in Progress…" : `⚡ Fill Remaining (${unfilledTransitions.length} cuts)`}
                </button>
              )}
              <button
                className={unfilledTransitions.length > 0 ? "btn secondary" : "btn primary"}
                disabled={batchStatus.running || !comfyReady}
                onClick={() => runBatchGeneration(false)}
                title="Render or re-render all cuts sequentially"
              >
                {batchStatus.running ? "Rendering in Progress…" : `🔄 Render All (${transitions.length} cuts)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "t2i" && project && (
        <PromptModal
          title="Generate Base Image (T2IV3.5 stack)"
          onClose={() => setModal(null)}
          onSubmit={(prompt) => {
            setModal(null);
            startJob(() => api.generateT2i(project.id, { prompt, place_at: playhead }));
          }}
        />
      )}

      {modal === "edit" && project && selectedAssetId && (
        <PromptModal
          title="QwenEdit — Next Keyframe"
          initial=""
          onClose={() => setModal(null)}
          onSubmit={(prompt) => {
            const asset = project.assets.find((a) => a.id === selectedAssetId);
            if (!asset) return;
            const currentKf = project.keyframes.find((k) => k.asset_id === selectedAssetId);
            const targetTime =
              currentKf && playhead <= currentKf.time
                ? Math.round((currentKf.time + 4.0) * 10) / 10
                : playhead > 0
                ? playhead
                : currentKf
                ? Math.round((currentKf.time + 4.0) * 10) / 10
                : 4.0;
            setModal(null);
            startJob(() =>
              api.generateEdit(project.id, {
                prompt,
                source_file: asset.file,
                parent_asset_id: asset.id,
                place_at: targetTime,
              }),
            );
          }}
        />
      )}

      {modal === "between" && project && selectedAssets.length === 2 && (
        <PromptModal
          title="Generate In-Between Keyframe"
          initial="Subtle motion toward the next pose."
          extra={
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              Uses the earlier selected keyframe as the edit source and instructs QwenEdit to land halfway toward the
              later keyframe.
            </p>
          }
          onClose={() => setModal(null)}
          onSubmit={(prompt) => {
            const [leftKf, rightKf] = selectedKeyframeIds
              .map((id) => project.keyframes.find((k) => k.id === id))
              .filter(Boolean);
            if (!leftKf || !rightKf) return;
            const left = leftKf.time <= rightKf.time ? leftKf : rightKf;
            const right = leftKf.time <= rightKf.time ? rightKf : leftKf;
            const mid = (left.time + right.time) / 2;
            setModal(null);
            startJob(() =>
              api.generateBetween(project.id, {
                left_asset_id: assetMap.get(left.asset_id)?.id,
                right_asset_id: assetMap.get(right.asset_id)?.id,
                prompt,
                place_at: mid,
              }),
            );
          }}
        />
      )}

      {modal === "video" && project && gapRange && (() => {
        const [left, right] = neighborsAtTime(project.keyframes, gapRange.start + 0.001);
        const segId = left && right ? `seg-${left.id}-${right.id}` : "";
        const initialPrompt =
          (project.prompt_segments || []).find(
            (s) =>
              (left && right && s.from_kf_id === left.id && s.to_kf_id === right.id) ||
              (segId && s.id === segId) ||
              (Math.abs(s.start - gapRange.start) < 0.05 && Math.abs(s.end - gapRange.end) < 0.05)
          )?.prompt || "Describe motion and audio for the transition.";

        return (
          <PromptModal
            title={`Generate Video (${(gapRange.end - gapRange.start).toFixed(1)}s)`}
            initial={initialPrompt}
            extra={
              <p style={{ fontSize: 13, color: "var(--muted)" }}>
                Duration automatically matches the timeline gap. Uses H3 Turbo LoRA (8 steps).
              </p>
            }
            onClose={() => {
              setModal(null);
              setGapRange(null);
            }}
            onSubmit={(prompt) => {
              if (!left || !right) {
                alert("Need two neighboring keyframes in this gap.");
                return;
              }
              setSegmentPrompt(gapRange.start, gapRange.end, prompt, left.id, right.id);
              setModal(null);
              startJob(() =>
                api.generateVideo(project.id, {
                  prompt,
                  first_asset_id: left.asset_id,
                  last_asset_id: right.asset_id,
                  gap_start: gapRange.start,
                  gap_end: gapRange.end,
                }),
              );
              setGapRange(null);
            }}
          />
        );
      })()}
    </div>
  );
}

