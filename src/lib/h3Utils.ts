/**
 * MiniMax H3 frame & duration snapping utilities.
 * MiniMax H3 requires frame count where (count % 17) == 5.
 * Valid range: 73 frames (~3.04s) to 362 frames (~15.08s) at 24 FPS.
 */

export const H3_FRAME_COUNTS = [
  73, 90, 107, 124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362,
];

export function snapH3Frames(frames: number): number {
  const f = Math.max(5, Math.round(frames));
  const k = Math.round((f - 5) / 17);
  const target = 17 * k + 5;
  return Math.min(Math.max(target, 73), 362);
}

export function snapH3Duration(seconds: number, fps = 24): number {
  const frames = snapH3Frames(seconds * fps);
  return Math.round((frames / fps) * 100) / 100;
}

export function getValidH3Presets(fps = 24): Array<{ frames: number; seconds: number; label: string }> {
  return H3_FRAME_COUNTS.map((frames) => {
    const seconds = Math.round((frames / fps) * 100) / 100;
    return {
      frames,
      seconds,
      label: `${seconds}s (${frames}f)`,
    };
  });
}

/**
 * Snaps a moving keyframe to the nearest valid H3 duration relative to its preceding keyframe.
 */
export function snapKeyframeToH3(
  keyframes: Array<{ id: string; time: number }>,
  movingId: string,
  rawTime: number,
  fps = 24
): { time: number; snappedGap?: number; frames?: number } {
  const otherKfs = keyframes
    .filter((k) => k.id !== movingId)
    .sort((a, b) => a.time - b.time);

  if (otherKfs.length === 0) {
    return { time: Math.max(0, Math.round(rawTime * 10) / 10) };
  }

  // Find previous keyframe that sits before rawTime
  let prevKf: { id: string; time: number } | null = null;
  for (const k of otherKfs) {
    if (k.time <= rawTime) {
      prevKf = k;
    } else {
      break;
    }
  }

  if (prevKf) {
    const rawGap = Math.max(0.5, rawTime - prevKf.time);
    const frames = snapH3Frames(rawGap * fps);
    const snappedGap = Math.round((frames / fps) * 100) / 100;
    const time = Math.round((prevKf.time + snappedGap) * 100) / 100;
    return { time, snappedGap, frames };
  }

  // If moving before the first other keyframe, snap to frame 0 or relative to next
  const nextKf = otherKfs[0];
  if (nextKf && rawTime < nextKf.time) {
    const rawGap = Math.max(0.5, nextKf.time - rawTime);
    const frames = snapH3Frames(rawGap * fps);
    const snappedGap = Math.round((frames / fps) * 100) / 100;
    const time = Math.max(0, Math.round((nextKf.time - snappedGap) * 100) / 100);
    return { time, snappedGap, frames };
  }

  return { time: Math.max(0, Math.round(rawTime * 10) / 10) };
}
