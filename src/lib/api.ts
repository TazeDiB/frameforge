import type { Health, Job, Project } from "../types";

const API = "/api";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => json<Health>("/health"),
  listProjects: () => json<{ projects: Project[] }>("/projects"),
  createProject: (name: string) =>
    json<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  getProject: (id: string) => json<Project>(`/projects/${id}`),
  saveProject: (id: string, body: Partial<Project>) =>
    json<Project>(`/projects/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  generateT2i: (id: string, body: Record<string, unknown>) =>
    json<Job>(`/projects/${id}/generate/t2i`, { method: "POST", body: JSON.stringify(body) }),
  generateEdit: (id: string, body: Record<string, unknown>) =>
    json<Job>(`/projects/${id}/generate/edit`, { method: "POST", body: JSON.stringify(body) }),
  generateBetween: (id: string, body: Record<string, unknown>) =>
    json<Job>(`/projects/${id}/generate/between`, { method: "POST", body: JSON.stringify(body) }),
  generateVideo: (id: string, body: Record<string, unknown>) =>
    json<Job>(`/projects/${id}/generate/video`, { method: "POST", body: JSON.stringify(body) }),
  getJob: (jobId: string) => json<Job>(`/jobs/${jobId}`),
  importAsset: async (projectId: string, file: File, label = "") => {
    const form = new FormData();
    form.append("file", file);
    form.append("label", label);
    const res = await fetch(`${API}/projects/${projectId}/import`, { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<{ ok: boolean; project: Project }>;
  },
  deleteAsset: (projectId: string, assetId: string) =>
    json<{ ok: boolean; id: string; project: Project }>(`/projects/${projectId}/assets/${assetId}`, {
      method: "DELETE",
    }),
  assetUrl: (projectId: string, file: string) =>
    `${API}/projects/${projectId}/assets/${encodeURIComponent(file)}`,
};
