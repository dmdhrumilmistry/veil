/** Rough strength estimate: charset entropy x length, with penalties for repetition. */
export function strength(p: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!p) return { score: 0, label: '' };
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/\d/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 33;
  const unique = new Set(p).size;
  const bits = Math.log2(Math.max(pool, 2)) * Math.min(p.length, unique * 2.5);
  if (bits < 40) return { score: 1, label: 'Weak' };
  if (bits < 60) return { score: 2, label: 'Fair' };
  if (bits < 80) return { score: 3, label: 'Strong' };
  return { score: 4, label: 'Excellent' };
}

export const MIN_PASSPHRASE = 10;
