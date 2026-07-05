import fs from 'fs';
import path from 'path';

const IGNORE_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage', '.nyc_output',
]);
const IGNORE_EXTS = new Set([
  '.db', '.sqlite', '.sqlite3', '.db-shm', '.db-wal', '.log',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.ogg',
  '.zip', '.tar', '.gz', '.bz2',
  '.bin', '.exe', '.dll', '.so',
]);

export function scanTree(dir: string, maxDepth = 4): string {
  const lines: string[] = [`Working directory: ${dir}`];

  function walk(current: string, prefix: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = entries.filter((e) => {
      if (IGNORE_NAMES.has(e.name)) return false;
      if (e.name.startsWith('.') && e.name !== '.env.example') return false;
      if (e.isFile() && IGNORE_EXTS.has(path.extname(e.name).toLowerCase())) return false;
      return true;
    });
    visible.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    visible.forEach((entry, idx) => {
      const isLast = idx === visible.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), childPrefix, depth + 1);
      }
    });
  }

  walk(dir, '', 1);
  return lines.join('\n');
}
