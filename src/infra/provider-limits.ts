// src/infra/provider-limits.ts
// Normalized shape every limit-window fetcher returns, so the dashboard renders
// them uniformly. Structurally matches the existing CodexUsageWindow/Snapshot in
// src/infra/codex-usage.ts (left untouched).

export interface LimitWindow {
  label: string;        // "5h", "Weekly", "Weekly (Sonnet)"
  usedPercent: number;  // 0–100, always "used" (invert "remaining" sources)
  resetAt?: number;     // unix ms
}

export interface ProviderLimits {
  ok: boolean;
  provider: string;
  windows: LimitWindow[];
  note?: string;        // e.g. "balance unavailable"
  error?: string;
}
