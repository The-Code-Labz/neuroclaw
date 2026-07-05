// Canvas — project & artifact store.
//
// v1 uses an in-process map (cheap, fine for one user) with a JSON snapshot to
// disk so the workspace tab can survive a server restart. Phase 5 will route
// these through NeuroVault as `type: 'project'` memories per the ASAGI brief
// §7 "Data contracts".

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import type { CanvasProject, Artifact, DesignBrief, Direction, CritiqueResult } from './types';

const ROOT = path.resolve(process.cwd(), '.canvas-projects');
fs.mkdirSync(ROOT, { recursive: true });

const projects: Map<string, CanvasProject> = new Map();
const artifacts: Map<string, Artifact> = new Map();

/** Hydrate any persisted projects on module load (best-effort). */
function hydrate(): void {
  try {
    for (const f of fs.readdirSync(ROOT)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(ROOT, f), 'utf-8');
        const p = JSON.parse(raw) as CanvasProject;
        if (p && p.id) {
          projects.set(p.id, p);
          for (const a of p.artifacts || []) artifacts.set(a.id, a);
        }
      } catch (err) {
        logger.warn('canvas/store: hydrate failed', { file: f, err: (err as Error).message });
      }
    }
  } catch (err) {
    logger.warn('canvas/store: hydrate scan failed', { err: (err as Error).message });
  }
}
hydrate();

function persist(p: CanvasProject): void {
  try {
    fs.writeFileSync(path.join(ROOT, `${p.id}.json`), JSON.stringify(p, null, 2));
  } catch (err) {
    logger.warn('canvas/store: persist failed', { id: p.id, err: (err as Error).message });
  }
}

export function createProject(brief: DesignBrief): CanvasProject {
  const now = Date.now();
  const p: CanvasProject = {
    id:        randomUUID(),
    briefId:   randomUUID(),
    status:    'discovery',
    brief,
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  projects.set(p.id, p);
  persist(p);
  return p;
}

export function getProject(id: string): CanvasProject | undefined {
  return projects.get(id);
}

export function listProjects(): CanvasProject[] {
  return Array.from(projects.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function updateProject(id: string, patch: Partial<CanvasProject>): CanvasProject | undefined {
  const p = projects.get(id);
  if (!p) return undefined;
  Object.assign(p, patch, { updatedAt: Date.now() });
  persist(p);
  return p;
}

export function setDirection(id: string, d: Direction): CanvasProject | undefined {
  return updateProject(id, { direction: d, status: 'building' });
}

export function attachArtifact(projectId: string, artifact: Artifact): Artifact | undefined {
  const p = projects.get(projectId);
  if (!p) return undefined;
  p.artifacts.push(artifact);
  artifacts.set(artifact.id, artifact);
  updateProject(projectId, { status: 'building' });
  return artifact;
}

export function getArtifact(id: string): Artifact | undefined {
  return artifacts.get(id);
}

export function setArtifactCritique(id: string, critique: CritiqueResult): Artifact | undefined {
  const a = artifacts.get(id);
  if (!a) return undefined;
  a.critique = critique;
  // re-persist owning project
  for (const p of projects.values()) {
    if (p.artifacts.some(x => x.id === id)) {
      updateProject(p.id, {});
      break;
    }
  }
  return a;
}

export function findProjectByArtifact(artifactId: string): CanvasProject | undefined {
  for (const p of projects.values()) {
    if (p.artifacts.some(a => a.id === artifactId)) return p;
  }
  return undefined;
}

export function deleteProject(id: string): boolean {
  const p = projects.get(id);
  if (!p) return false;
  for (const a of p.artifacts) artifacts.delete(a.id);
  projects.delete(id);
  try { fs.unlinkSync(path.join(ROOT, `${id}.json`)); } catch { /* ignore */ }
  return true;
}

export const CANVAS_ROOT = ROOT;
