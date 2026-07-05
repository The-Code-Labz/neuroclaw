import { logger } from '../../utils/logger';
import { clearSkillCache, listSkills, type SkillRecord } from '../skill-loader';
import { exportCodexSkills, isCodexSkillExportAvailable } from './codex';
import { exportAntigravitySkills, isAntigravitySkillExportAvailable } from './antigravity';

export interface SkillExporter {
  name: string;
  isAvailable(repoRoot: string): Promise<boolean>;
  export(skills: SkillRecord[], repoRoot: string): Promise<{ written: string[]; skipped: string[] }>;
}

export interface SkillExportSummary {
  exporter: string;
  written:  string[];
  skipped:  string[];
  error?:    string;
}

const exporters: SkillExporter[] = [
  {
    name: 'codex',
    isAvailable: isCodexSkillExportAvailable,
    export: exportCodexSkills,
  },
  {
    name: 'antigravity',
    isAvailable: isAntigravitySkillExportAvailable,
    export: exportAntigravitySkills,
  },
];

export async function syncSkillExports(opts: { repoRoot?: string; refresh?: boolean } = {}): Promise<SkillExportSummary[]> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  if (opts.refresh) clearSkillCache();
  const skills = listSkills();
  const summaries: SkillExportSummary[] = [];

  for (const exporter of exporters) {
    try {
      if (!(await exporter.isAvailable(repoRoot))) {
        summaries.push({ exporter: exporter.name, written: [], skipped: ['exporter unavailable'] });
        continue;
      }
      const result = await exporter.export(skills, repoRoot);
      summaries.push({ exporter: exporter.name, ...result });
      if (result.written.length > 0 || result.skipped.length > 0) {
        logger.info('skill export synced', { exporter: exporter.name, written: result.written, skipped: result.skipped });
      }
    } catch (err) {
      const message = (err as Error).message;
      logger.warn('skill export failed', { exporter: exporter.name, error: message });
      summaries.push({ exporter: exporter.name, written: [], skipped: [], error: message });
    }
  }

  return summaries;
}
