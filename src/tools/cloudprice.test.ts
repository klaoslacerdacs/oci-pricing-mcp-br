import { describe, it, expect } from 'vitest';
import { getAzurePrice } from './cloudprice.js';

describe('getAzurePrice guards', () => {
  it('requires a filter', async () => {
    const r = (await getAzurePrice({})) as { error?: string };
    expect(r.error).toBeTruthy();
  });
});
