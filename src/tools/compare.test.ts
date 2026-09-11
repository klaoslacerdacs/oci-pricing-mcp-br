import { describe, it, expect } from 'vitest';
import { compareService } from './compare.js';
import { getServerlessPricing } from '../data/fetcher.js';

// Asserts on the OCI leg (local, deterministic) and the estimate arithmetic.
// compareService fans out to live cloud sources too (which safe() degrades on
// failure), so these are integration-flavored — allow a generous timeout.
const T = 20000;

describe('compareService', () => {
  it('rejects an unknown category', async () => {
    const r = (await compareService({ category: 'nope' as never })) as { error?: string; categories?: string[] };
    expect(r.error).toBeTruthy();
    expect(r.categories).toContain('object-storage');
  });

  it('object-storage: OCI monthly = per-GB × GB', async () => {
    const r = (await compareService({ category: 'object-storage', sizing: { storageGB: 1000, tier: 'standard' } })) as {
      comparable: boolean;
      comparison: Array<{ cloud: string; components: Array<{ price: number }>; monthlyEstimate: number | null }>;
    };
    expect(r.comparable).toBe(true);
    const oci = r.comparison.find((c) => c.cloud === 'OCI')!;
    expect(oci.monthlyEstimate).toBeCloseTo(oci.components[0].price * 1000, 2);
  }, T);

  it('serverless: OCI estimate = inv×invRate + gbSec×execRate', async () => {
    const inv = 1_000_000, ms = 200, mem = 256;
    const gbSec = inv * (ms / 1000) * (mem / 1024);
    const rows = getServerlessPricing();
    const invRate = rows.find((x) => x.type === 'functions-invocations')!.pricePerUnit;
    const exRate = rows.find((x) => x.type === 'functions-execution')!.pricePerUnit;
    const r = (await compareService({ category: 'serverless', sizing: { monthlyInvocations: inv, avgDurationMs: ms, memoryMB: mem } })) as {
      comparison: Array<{ cloud: string; monthlyEstimate: number | null }>;
    };
    const oci = r.comparison.find((c) => c.cloud === 'OCI')!;
    expect(oci.monthlyEstimate).toBeCloseTo(inv * invRate + gbSec * exRate, 4);
  }, T);

  it('cache-redis: OCI monthly = rate × GB × 730', async () => {
    const gb = 16;
    const r = (await compareService({ category: 'cache-redis', sizing: { memoryGB: gb } })) as { comparison: Array<{ cloud: string; components: Array<{ price: number }>; monthlyEstimate: number | null }> };
    const oci = r.comparison.find((c) => c.cloud === 'OCI')!;
    expect(oci.monthlyEstimate).toBeCloseTo(oci.components[0].price * gb * 730, 2);
  }, T);

  it('load-balancer: OCI monthly = (inst + bw×Mbps) × 730', async () => {
    const mbps = 100;
    const r = (await compareService({ category: 'load-balancer', sizing: { bandwidthMbps: mbps } })) as { comparison: Array<{ cloud: string; components: Array<{ price: number }>; monthlyEstimate: number | null }> };
    const oci = r.comparison.find((c) => c.cloud === 'OCI')!;
    const [inst, bw] = oci.components;
    expect(oci.monthlyEstimate).toBeCloseTo((inst.price + bw.price * mbps) * 730, 2);
  }, T);

  it('data-warehouse is components-only (comparable:false)', async () => {
    const r = (await compareService({ category: 'data-warehouse', sizing: { ocpus: 2, storageGB: 1024 } })) as { comparable: boolean; cheapest: string | null };
    expect(r.comparable).toBe(false);
    expect(r.cheapest).toBeNull();
  }, T);
});
