// Canvas skill — public type contract.
//
// Spec: docs/specs/design-tab-ASAGI-brief.md §5.
// Both the chat surface and the /canvas dashboard tab consume these shapes.
// Do NOT invent surface-specific variants.

export type CanvasSurface = 'deck' | 'poster' | 'web' | 'mobile' | 'motion' | 'infographic';

export interface BrandKit {
  name?:    string;
  logoUrl?: string;
  colors?:  string[];     // hex strings
  voice?:   string;       // tone description
}

export interface DesignBrief {
  brief:     string;
  surface?:  CanvasSurface;
  audience?: string;
  tone?:     string;
  scale?:    'single' | 'multi-page' | 'prototype';
  direction?: string;     // chosen direction key from DirectionPicker
  brandKit?: BrandKit;
}

export interface DiscoveryForm {
  surfaces:  { id: CanvasSurface; label: string; hint: string }[];
  audiences: string[];
  tones:     string[];
  scales:    { id: 'single' | 'multi-page' | 'prototype'; label: string }[];
}

export interface Direction {
  id:          string;
  name:        string;
  philosophy:  string;     // 1-line design philosophy
  exemplars:   string[];   // brand names that exemplify this
  paletteHint: string;
  typeHint:    string;
}

export interface TodoItem {
  id:     string;
  text:   string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolTrace {
  name:   string;
  args?:  Record<string, unknown>;
  ms?:    number;
  ok?:    boolean;
  /** Character count of the produced output — surfaced on the end marker so the
   *  activity log can show "✓ llm.complete · 34000ms · 12034 chars". */
  chars?: number;
}

export interface Artifact {
  id:        string;
  projectId: string;
  type:      'html' | 'pdf' | 'pptx' | 'svg' | 'mp4';
  title?:    string;
  /** For html: full document string. For binary types: file path on disk. */
  content:   string;
  /** Optional inline thumbnail (data: URL). */
  preview?:  string;
  createdAt: number;
  critique?: CritiqueResult;
}

export interface CritiqueResult {
  scores: {
    clarity:    number;   // 0–10
    hierarchy:  number;
    craft:      number;
    brandFit:   number;
    emotion:    number;
  };
  notes:    string[];
  multiAgent?: {
    asia?:   CritiqueResult;
    lucius?: CritiqueResult;
    joker?:  CritiqueResult;
  };
}

export interface CanvasProject {
  id:             string;
  briefId:        string;
  status:         'discovery' | 'direction' | 'building' | 'critique' | 'complete';
  brief:          DesignBrief;
  direction?:     Direction;
  artifacts:      Artifact[];
  conversationId?: string;
  createdAt:      number;
  updatedAt:      number;
}

// SSE event shapes — both surfaces consume these.
export type CanvasEvent =
  | { type: 'project.start';         payload: { projectId: string; briefId: string } }
  | { type: 'discovery.form.show';   payload: DiscoveryForm }
  | { type: 'direction.form.show';   payload: Direction[] }
  | { type: 'todo.update';           payload: TodoItem[] }
  | { type: 'tool.call';             payload: ToolTrace }
  | { type: 'chunk';                 payload: { text: string } }
  | { type: 'artifact.emit';         payload: Artifact }
  | { type: 'critique.result';       payload: CritiqueResult }
  | { type: 'project.complete';      payload: { projectId: string } }
  | { type: 'error';                 payload: { message: string } };
