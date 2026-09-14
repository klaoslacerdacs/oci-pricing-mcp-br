import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point the disk cache at a temp dir BEFORE importing the module (CACHE_DIR is
// read at module load).
process.env.GCP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'gcpcache-'));

describe('GCP disk cache round-trip', () => {
  let diskGet: typeof import('./gcpprice.js').diskGet;
  let diskSet: typeof import('./gcpprice.js').diskSet;
  beforeAll(async () => {
    ({ diskGet, diskSet } = await import('./gcpprice.js'));
  });

  it('reads back what it wrote', () => {
    const url = '/SVC?q=postgres&region=us-central1';
    expect(diskGet(url)).toBeNull(); // cold
    diskSet(url, { items: [{ skuId: 'x', description: 'pg', usd: 1.23 }] });
    expect(diskGet<{ items: unknown[] }>(url)!.items).toHaveLength(1);
  });

  it('keys are distinct per url', () => {
    diskSet('/A', { v: 1 });
    diskSet('/B', { v: 2 });
    expect(diskGet<{ v: number }>('/A')!.v).toBe(1);
    expect(diskGet<{ v: number }>('/B')!.v).toBe(2);
  });
});
