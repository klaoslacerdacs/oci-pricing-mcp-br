/**
 * Cross-cloud service de-para (OCI <-> AWS <-> Azure <-> GCP).
 * Bundled from Oracle's public service-mapping table (160 services, 20 categories).
 * Name equivalence only — not sizing/pricing.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServiceMapRow {
  category: string;
  service: string;
  oci: string[]; // one entry per equivalent product; [] = no equivalent on that cloud
  aws: string[];
  azure: string[];
  gcp: string[];
  info: string;
}

let cache: ServiceMapRow[] | null = null;
function rows(): ServiceMapRow[] {
  if (!cache) cache = JSON.parse(readFileSync(join(__dirname, '../data/service-mapping.json'), 'utf-8'));
  return cache!;
}

export interface MapCloudServicesParams {
  query?: string;
  category?: string;
}

/** Look up cross-cloud service equivalents. No args -> list categories. */
export function mapCloudServices(params: MapCloudServicesParams = {}) {
  const all = rows();

  if (!params.query && !params.category) {
    const categories: Record<string, number> = {};
    for (const r of all) categories[r.category] = (categories[r.category] || 0) + 1;
    return {
      totalServices: all.length,
      categories,
      usage: 'Pass query (matches any cloud/service name) or category to filter.',
    };
  }

  const q = params.query?.toLowerCase();
  const cat = params.category?.toLowerCase();
  const matches = all.filter((r) => {
    if (cat && r.category.toLowerCase() !== cat) return false;
    if (q) {
      const hay = [r.service, ...r.oci, ...r.aws, ...r.azure, ...r.gcp];
      if (!hay.some((f) => f.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  return {
    matchCount: matches.length,
    filters: { query: params.query || null, category: params.category || null },
    services: matches,
    source: "Oracle cross-cloud service mapping (bundled). Name equivalence only — verify feature parity per provider.",
  };
}
