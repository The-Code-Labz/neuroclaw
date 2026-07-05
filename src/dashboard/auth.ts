import { createHash, timingSafeEqual } from 'crypto';

// Constant-time dashboard-token comparison. A plain `provided !== expected`
// short-circuits at the first differing byte, leaking the token length and
// content to a co-resident process that can time requests (the loopback-only
// bind blocks remote timing, but not local). Hashing both sides to a fixed
// 32-byte digest before timingSafeEqual keeps the compare constant-time AND
// length-independent (timingSafeEqual itself throws on unequal lengths).
export function tokenMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
