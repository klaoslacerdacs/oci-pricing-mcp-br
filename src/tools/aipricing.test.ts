import { describe, it, expect } from 'vitest';
import { getAiPrice } from './aipricing.js';

describe('getAiPrice gcp (bundled)', () => {
  it('returns Gemini models with a source and date', async () => {
    const r = (await getAiPrice({ provider: 'gcp' })) as { count: number; asOf: string; source: string };
    expect(r.count).toBeGreaterThan(0);
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.source).toContain('ai.google.dev');
  });

  it('filters by model query', async () => {
    const r = (await getAiPrice({ provider: 'gcp', query: 'flash-lite' })) as { models: Array<{ model: string }> };
    expect(r.models.length).toBeGreaterThan(0);
    expect(r.models.every((m) => m.model.toLowerCase().includes('flash-lite'))).toBe(true);
  });

  it('rejects unknown provider', async () => {
    // @ts-expect-error testing bad input at the trust boundary
    await expect(Promise.resolve().then(() => getAiPrice({ provider: 'oci' }))).rejects.toThrow();
  });
});
