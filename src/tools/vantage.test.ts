import { describe, it, expect } from 'vitest';
import { parseOnDemandHourly, parseSpec } from './vantage.js';

// Canned Vantage markdown (real shape: leading pipe, padded OS cells).
const REGION_MD = `
| OS              | On Demand  | Spot Min   |
| --------------- | ---------- | ---------- |
| Linux           | $0.0672/hr | $0.0144/hr |
| Linux SQL Web   | $0.1348/hr | N/A        |
| Windows         | $0.0856/hr | $0.0251/hr |
`;

const DETAIL_MD = `# t3.medium\n- vCPUs: 2\n- Memory (GiB): 4\n`;

describe('vantage markdown parsing', () => {
  it('reads the exact-OS On-Demand row, not a prefix match', () => {
    expect(parseOnDemandHourly(REGION_MD, 'Linux')).toBe(0.0672); // not 0.1348 (Linux SQL Web)
    expect(parseOnDemandHourly(REGION_MD, 'Windows')).toBe(0.0856);
  });
  it('throws when the OS is absent', () => {
    expect(() => parseOnDemandHourly(REGION_MD, 'Plan9')).toThrow();
  });
  it('reads vCPU and memory specs', () => {
    expect(parseSpec(DETAIL_MD, /vCPUs:\s*([0-9.]+)/i)).toBe(2);
    expect(parseSpec(DETAIL_MD, /Memory \(GiB\):\s*([0-9.]+)/i)).toBe(4);
  });
});
