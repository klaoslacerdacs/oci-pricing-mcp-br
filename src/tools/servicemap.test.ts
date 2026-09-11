import { describe, it, expect } from 'vitest';
import { mapCloudServices } from './servicemap.js';

describe('mapCloudServices', () => {
  it('lists categories when called with no args', () => {
    const r = mapCloudServices() as { totalServices: number; categories: Record<string, number> };
    expect(r.totalServices).toBe(160);
    expect(Object.keys(r.categories).length).toBe(20);
  });

  it('matches a product name in any cloud column', () => {
    const r = mapCloudServices({ query: 'bedrock' }) as { matchCount: number; services: Array<{ oci: string[]; aws: string[] }> };
    expect(r.matchCount).toBe(1);
    expect(r.services[0].aws).toContain('AWS Bedrock');
    expect(r.services[0].oci).toContain('Generative AI New');
  });

  it('keeps multi-product cells as separate list entries (fidelity)', () => {
    const r = mapCloudServices({ query: 'Speaker Recognition' }) as { services: Array<{ azure: string[] }> };
    // must not be one mashed-together string
    expect(r.services[0].azure).toEqual(['Speaker Recognition', 'Speech to Text', 'Speech Translation']);
  });

  it('filters by category', () => {
    const r = mapCloudServices({ category: 'Compute' }) as { matchCount: number };
    expect(r.matchCount).toBe(15);
  });
});
