import { describe, it, expect } from 'vitest';
import { calculateNetworkingCost, compareDataEgress } from '../src/tools/networking.js';
import { listComputeShapes } from '../src/tools/compute.js';
import { calculateDatabaseCost } from '../src/tools/database.js';
import { calculateMonthlyCost, convertUsdToBrl } from '../src/tools/calculator.js';
import {
  listServicesByCategory,
  listAIMLServices,
  listSecurityServices,
  SERVICE_CATEGORIES,
} from '../src/tools/services.js';

describe('calculateNetworkingCost', () => {
  it('bills the flexible load balancer as paid (no free-tier credit)', () => {
    const res = calculateNetworkingCost({ flexibleLoadBalancers: 1 });
    // Paid-by-default policy: LB gets no free credit.
    expect(res.freeCredits).toBe(0);
    expect(res.netCost).toBeCloseTo(res.totalMonthly, 2);
    expect(res.totalMonthly).toBeGreaterThan(0);
  });

  it('net cost never exceeds gross and is internally consistent', () => {
    const res = calculateNetworkingCost({ outboundDataGB: 50000, flexibleLoadBalancers: 2 });
    expect(res.netCost).toBeCloseTo(res.totalMonthly - res.freeCredits, 1);
  });
});

describe('compareDataEgress', () => {
  it('honors the OCI 10 TB free tier (no egress cost under 10 TB)', () => {
    const res = compareDataEgress(5000);
    expect(res.ociCost).toBe(0);
    // Competitor figures must be flagged as approximate/hardcoded.
    expect(res.notes.some((n) => /approximate|hardcoded/i.test(n))).toBe(true);
  });

  it('charges OCI egress only above 10 TB', () => {
    const res = compareDataEgress(20000);
    expect(res.ociCost).toBeGreaterThan(0);
  });
});

describe('listComputeShapes', () => {
  it('returns shapes with prices', () => {
    const res = listComputeShapes({});
    expect(res.shapes.length).toBeGreaterThan(0);
  });
});

describe('list_services_by_category consolidation', () => {
  it('exposes 14 categories', () => {
    expect(SERVICE_CATEGORIES).toHaveLength(14);
  });

  it('returns the same payload as the individual deprecated tools', () => {
    const viaNew = listServicesByCategory({ category: 'aiml' });
    const viaOld = listAIMLServices({});
    // The consolidated tool adds a `category` field but otherwise matches.
    const { category, ...rest } = viaNew as { category: string } & Record<string, unknown>;
    expect(category).toBe('aiml');
    expect(rest).toEqual(viaOld);

    const sec = listServicesByCategory({ category: 'security' }) as Record<string, unknown>;
    const { category: c2, ...secRest } = sec as { category: string } & Record<string, unknown>;
    expect(c2).toBe('security');
    expect(secRest).toEqual(listSecurityServices({}));
  });

  it('every advertised category dispatches without throwing', () => {
    for (const category of SERVICE_CATEGORIES) {
      expect(() => listServicesByCategory({ category })).not.toThrow();
    }
  });

  it('throws a helpful error on an unknown category', () => {
    // @ts-expect-error intentionally invalid category
    expect(() => listServicesByCategory({ category: 'nope' })).toThrow(/Unknown service category/);
  });
});

describe('calculateDatabaseCost - PostgreSQL 4-SKU model', () => {
  it('matches Oracle calculator: 1 OCPU / 16 GB / 744h ~= managed+compute+memory', async () => {
    const r = await calculateDatabaseCost({
      type: 'postgresql', computeUnits: 1, storageGB: 1, memoryGB: 16, hoursPerMonth: 744,
    });
    const by = (s: string) => r.breakdown.find((b) => b.item.includes(s))!.monthlyTotal;
    expect(by('managed')).toBeCloseTo(72.91, 1);   // B99060 @0.098
    expect(by('E5 - OCPU')).toBeCloseTo(22.32, 1); // B97384 @0.03
    expect(by('E5 - Memory')).toBeCloseTo(23.81, 1);// B97385 @0.002
    expect(r.totalMonthly).toBeGreaterThan(119);    // vs old broken ~$25
    expect(r.breakdown).toHaveLength(4);
  });

  it('defaults memory to computeUnits*16 when omitted', async () => {
    const r = await calculateDatabaseCost({ type: 'postgresql', computeUnits: 2, storageGB: 0 });
    const mem = r.breakdown.find((b) => b.item.includes('Memory'))!;
    expect(mem.quantity).toBe(32);
  });
});

describe('PostgreSQL minimums', () => {
  it('clamps below 1 OCPU / 16 GB to the floor', async () => {
    const r = await calculateDatabaseCost({ type: 'postgresql', computeUnits: 0.5, storageGB: 0, memoryGB: 4 });
    const ocpu = r.breakdown.find((b) => b.item.includes('managed'))!;
    const mem = r.breakdown.find((b) => b.item.includes('Memory'))!;
    expect(ocpu.quantity).toBe(1);
    expect(mem.quantity).toBe(16);
    expect(r.notes.some((n) => /minimum/i.test(n))).toBe(true);
  });
});

describe('Windows license + burst', () => {
  it('adds a Windows OS line at ~$0.092/OCPU and halves it at 0.5 baseline', () => {
    const full = calculateMonthlyCost({ compute: { shape: 'VM.Standard.E5.Flex', ocpus: 2, memoryGB: 16, os: 'windows' } });
    const w1 = full.breakdown.find((b) => b.item.includes('Windows'))!;
    expect(w1.unitPrice).toBeCloseTo(0.092, 3);
    expect(w1.monthlyTotal).toBeCloseTo(0.092 * 2 * 730, 1);
    const burst = calculateMonthlyCost({ compute: { shape: 'VM.Standard.E5.Flex', ocpus: 2, memoryGB: 16, os: 'windows', burstBaseline: 0.5 } });
    const w2 = burst.breakdown.find((b) => b.item.includes('Windows'))!;
    expect(w2.monthlyTotal).toBeCloseTo(w1.monthlyTotal / 2, 1);
  });
  it('adds no Windows line for linux', () => {
    const r = calculateMonthlyCost({ compute: { shape: 'VM.Standard.E5.Flex', ocpus: 1, memoryGB: 8 } });
    expect(r.breakdown.some((b) => b.item.includes('Windows'))).toBe(false);
  });
});

describe('Free-tier policy: paid Load Balancer', () => {
  it('applies no free credit to the flexible load balancer', () => {
    const r = calculateNetworkingCost({ flexibleLoadBalancers: 1, loadBalancerBandwidthMbps: 10 });
    expect(r.freeCredits).toBe(0);
    expect(r.netCost).toBeCloseTo(r.totalMonthly, 2);
  });
  it('models 10 TB egress as a $0 line (not a phantom credit offsetting LB)', () => {
    const r = calculateNetworkingCost({ outboundDataGB: 5000 });
    const egress = r.breakdown.find((b) => b.item.includes('Outbound'))!;
    expect(egress.monthlyTotal).toBe(0);
    expect(r.notes.some((n) => /free/i.test(n))).toBe(true);
    // LB stays paid even alongside free egress.
    const withLb = calculateNetworkingCost({ flexibleLoadBalancers: 1, outboundDataGB: 5000 });
    expect(withLb.netCost).toBeGreaterThan(0);
    expect(withLb.netCost).toBeCloseTo(withLb.totalMonthly, 2);
  });
});

describe('convertUsdToBrl', () => {
  it('grosses up: BRL = USD * 5.23 / 0.87', () => {
    const r = convertUsdToBrl({ usd: 100 });
    expect(r.brl).toBeCloseTo(601.15, 1);
    expect(r.fxRate).toBe(5.23);
    expect(r.taxDivisor).toBe(0.87);
  });
});
