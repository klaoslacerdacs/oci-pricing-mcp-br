import { describe, it, expect } from 'vitest';
import { getAzurePrice, getGcpPrice } from './cloudprice.js';

describe('getAzurePrice guards', () => {
  it('requires a filter', async () => {
    const r = (await getAzurePrice({})) as { error?: string };
    expect(r.error).toBeTruthy();
  });
});

describe('getGcpPrice without key', () => {
  it('returns a clear error + how-to, not a throw', async () => {
    const saved = process.env.GCP_API_KEY;
    delete process.env.GCP_API_KEY;
    const r = (await getGcpPrice({ service: 'Kubernetes' })) as { error?: string; howTo?: string };
    expect(r.error).toMatch(/API key/i);
    expect(r.howTo).toContain('GCP_API_KEY');
    if (saved) process.env.GCP_API_KEY = saved;
  });
});
