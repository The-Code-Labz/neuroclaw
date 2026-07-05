// Canvas — curated visual directions (Phase 5: 20 schools).
// v1 ships 8 well-known systems plus the NeuroClaw house brand.
// Add more in Phase 5 of the ASAGI brief.

import type { Direction } from './types';

export const DIRECTIONS: Direction[] = [
  {
    id:          'editorial',
    name:        'Editorial Minimalism',
    philosophy:  'Typographic restraint, generous whitespace, monochrome accents.',
    exemplars:   ['Pentagram', 'Kenya Hara', 'The New York Times Magazine'],
    paletteHint: 'warm cream, near-black, single accent',
    typeHint:    'serif headline + grotesk body',
  },
  {
    id:          'linear',
    name:        'Linear / Vercel',
    philosophy:  'Dark mode, sharp geometry, neon edge-light. Built for builders.',
    exemplars:   ['Linear', 'Vercel', 'Cursor'],
    paletteHint: 'deep blue-black, electric cyan, faint violet',
    typeHint:    'Inter / Geist sans, tight tracking',
  },
  {
    id:          'stripe',
    name:        'Stripe Modern',
    philosophy:  'Bright gradients, soft 3D, precise illustration. Trust through polish.',
    exemplars:   ['Stripe', 'Figma marketing', 'Notion landing'],
    paletteHint: 'pastel gradient washes, indigo primary',
    typeHint:    'sohne / sans display, medium weights',
  },
  {
    id:          'anthropic',
    name:        'Anthropic Library',
    philosophy:  'Quiet, considered, almost monastic. Beige paper textures, slow rhythm.',
    exemplars:   ['Anthropic', 'Claude.ai', 'Apple Newsroom'],
    paletteHint: 'oat, ink, terracotta accent',
    typeHint:    'editorial serif, generous line-height',
  },
  {
    id:          'field-io',
    name:        'Field.io Motion',
    philosophy:  'Generative, kinetic, particle-based. Math as art.',
    exemplars:   ['Field.io', 'Universal Everything', 'Active Theory'],
    paletteHint: 'high-contrast B&W or saturated singletone',
    typeHint:    'monospace + variable display',
  },
  {
    id:          'apple',
    name:        'Apple Marketing',
    philosophy:  'Cinematic hero, product as protagonist, oversized type, scroll choreography.',
    exemplars:   ['Apple', 'Arc Browser', 'Rivian'],
    paletteHint: 'pure black or pure white, single hero color',
    typeHint:    'SF Pro Display, massive H1, thin body',
  },
  {
    id:          'sagmeister',
    name:        'Sagmeister Experimental',
    philosophy:  'Provocative, hand-crafted, breaks rules deliberately. Type as illustration.',
    exemplars:   ['Sagmeister & Walsh', 'Pentagram experimental', 'Wieden+Kennedy'],
    paletteHint: 'neon, primary clash, raw texture',
    typeHint:    'custom display, mixed weights, broken grid',
  },
  {
    id:          'figma',
    name:        'Figma / Notion Playful',
    philosophy:  'Rounded shapes, bright candy accents, micro-illustrations. Approachable software.',
    exemplars:   ['Figma', 'Notion', 'Linear illustrations'],
    paletteHint: 'pastel rainbow, soft purple primary',
    typeHint:    'rounded sans, generous radius',
  },
  {
    id:          'neuroclaw',
    name:        'NeuroClaw House',
    philosophy:  'Cyber-noir command surface. Dark-1 panels, cyan glow, neon micro-grid.',
    exemplars:   ['NeuroClaw dashboard', 'Cyberpunk HUDs', 'Severance terminals'],
    paletteHint: '#020617 base, #00b7ff neon, #00f5d4 secondary, #8b5cf6 violet',
    typeHint:    'Space Grotesk display, JetBrains Mono code',
  },
];
