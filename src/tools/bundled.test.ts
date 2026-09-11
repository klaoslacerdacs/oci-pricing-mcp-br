import { describe, it, expect } from 'vitest';
import { getServicePrice } from './bundled.js';

describe('getServicePrice (bundled AWS Price List)', () => {
  it('lists mirrored services with no args', () => {
    const r = getServicePrice() as { available: Record<string, string[]>; totalRows: number };
    expect(r.totalRows).toBeGreaterThan(0);
    expect(Object.keys(r.available)).toContain('aws');
  });

  it('filters by service + region and prices are numbers', () => {
    const r = getServicePrice({ vendor: 'aws', service: 'Lambda', region: 'sa-east-1' }) as {
      totalMatched: number;
      items: Array<{ service: string; region: string; usd: number }>;
    };
    expect(r.totalMatched).toBeGreaterThan(0);
    expect(r.items.every((i) => i.service === 'Lambda' && i.region === 'sa-east-1')).toBe(true);
    expect(r.items.every((i) => typeof i.usd === 'number')).toBe(true);
  });

  it('AWS rows have a non-empty label (from AWS descriptions)', () => {
    const r = getServicePrice({ vendor: 'aws', service: 'EKS', query: 'cluster' }) as { items: Array<{ label: string; usd: number }> };
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.label.trim().length > 0)).toBe(true);
  });

  it('caps rows at top', () => {
    const r = getServicePrice({ vendor: 'aws', top: 5 }) as { returned: number };
    expect(r.returned).toBeLessThanOrEqual(5);
  });
});
