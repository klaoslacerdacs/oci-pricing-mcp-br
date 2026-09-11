import { describe, it, expect } from 'vitest';
import { getServicePrice } from './bundled.js';

describe('getServicePrice (bundled Infracost)', () => {
  it('lists mirrored vendors/services with no args', () => {
    const r = getServicePrice() as { available: Record<string, string[]>; totalRows: number };
    expect(r.totalRows).toBeGreaterThan(0);
    expect(Object.keys(r.available)).toEqual(expect.arrayContaining(['gcp', 'aws']));
  });

  it('filters by vendor + service + region', () => {
    const r = getServicePrice({ vendor: 'gcp', service: 'Cloud SQL', region: 'southamerica-east1' }) as {
      totalMatched: number;
      items: Array<{ service: string; region: string; label: string; usd: number }>;
    };
    expect(r.totalMatched).toBeGreaterThan(0);
    expect(r.items.every((i) => i.service === 'Cloud SQL' && i.region === 'southamerica-east1')).toBe(true);
    expect(r.items.every((i) => typeof i.usd === 'number')).toBe(true);
  });

  it('AWS rows have a non-empty label (attrs-derived, not blank)', () => {
    const r = getServicePrice({ vendor: 'aws', service: 'Lambda', top: 5 }) as { items: Array<{ label: string }> };
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.label.trim().length > 0)).toBe(true);
  });

  it('caps rows at top', () => {
    const r = getServicePrice({ vendor: 'aws', top: 5 }) as { returned: number };
    expect(r.returned).toBeLessThanOrEqual(5);
  });
});
