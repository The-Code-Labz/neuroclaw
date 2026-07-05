// @neuroclaw/canvas — public surface.
//
// Per the ASAGI brief (docs/specs/design-tab-ASAGI-brief.md §5), both the
// chat surface and the /canvas tab consume this module. Do not add public
// exports without architecture review.

export { generate, critique, iterate, exportArtifact, readArtifactFile } from './engine';
export type {
  CanvasEvent, DesignBrief, Direction, Artifact, CritiqueResult,
  CanvasProject, BrandKit, DiscoveryForm, TodoItem, CanvasSurface,
} from './types';
export { DIRECTIONS } from './directions';
export {
  listProjects, getProject, getArtifact, deleteProject,
} from './store';
export { CANVAS_CSP, withCspMeta, escapeHtmlAttr, escapeHtmlText } from './srcdoc';
