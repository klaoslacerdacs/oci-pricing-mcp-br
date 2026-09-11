/**
 * Local price lookup for GCP + AWS services NOT covered by the Vantage
 * instances MCP. Served from a bundled Infracost snapshot (no runtime key).
 * Refresh: scripts/fetch-cloud-prices.ts. See src/data/service-pricing.json.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Row {
  vendor: string;
  service: string;
  region: string;
  family: string;
  label: string;
  attrs: Record<string, string>;
  usd: number;
  unit: string;
}
interface Bundle {
  source: string;
  asOf: string;
  note: string;
  rows: Row[];
}

let cache: Bundle | null = null;
function bundle(): Bundle {
  if (!cache) cache = JSON.parse(readFileSync(join(__dirname, '../data/service-pricing.json'), 'utf-8'));
  return cache!;
}

export interface GetServicePriceParams {
  vendor?: 'gcp' | 'aws';
  service?: string; // substring, e.g. "Cloud SQL", "Lambda"
  query?: string; // substring on description/group
  region?: string; // substring, e.g. "sa-east-1", "southamerica-east1"
  top?: number; // default 30, max 100
}

export function getServicePrice(params: GetServicePriceParams = {}) {
  const b = bundle();
  const top = Math.min(params.top || 30, 100);

  if (!params.vendor && !params.service && !params.query) {
    // No filter: show what's in the mirror.
    const byVendor: Record<string, Set<string>> = {};
    for (const r of b.rows) (byVendor[r.vendor] ||= new Set()).add(r.service);
    return {
      source: b.source,
      asOf: b.asOf,
      totalRows: b.rows.length,
      available: Object.fromEntries(Object.entries(byVendor).map(([v, s]) => [v, [...s]])),
      usage: 'Filter by vendor ("gcp"|"aws"), service, query (description) and/or region.',
    };
  }

  const svc = params.service?.toLowerCase();
  const q = params.query?.toLowerCase();
  const reg = params.region?.toLowerCase();
  const matches = b.rows.filter((r) => {
    if (params.vendor && r.vendor !== params.vendor) return false;
    if (svc && !r.service.toLowerCase().includes(svc)) return false;
    if (reg && !r.region.toLowerCase().includes(reg)) return false;
    if (q) {
      const hay = (r.label + ' ' + Object.values(r.attrs).join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return {
    source: b.source,
    asOf: b.asOf,
    filters: { vendor: params.vendor || null, service: params.service || null, query: params.query || null, region: params.region || null },
    returned: Math.min(matches.length, top),
    totalMatched: matches.length,
    items: matches.slice(0, top).map((r) => ({ service: r.service, region: r.region, label: r.label, usd: r.usd, unit: r.unit })),
    note: b.note,
  };
}
