/**
 * Live GCP pricing via a Cloud Billing Catalog proxy (a Cloudflare Worker that
 * holds the GCP key server-side — none needed here). Covers GKE, Cloud Run,
 * BigQuery, Cloud SQL, etc. Worker base overridable via env GCP_PRICE_URL.
 */

import { pricingCache } from '../data/cache.js';

const BASE = (process.env.GCP_PRICE_URL || 'https://mcp-price-cf.nns.workers.dev').replace(/\/$/, '');

export interface GetGcpPriceParams {
  service?: string; // GCP serviceId (e.g. "9662-B51E-5089") or displayName substring (e.g. "Cloud SQL")
  query?: string; // SKU description substring
  region?: string; // filter SKUs whose regions include this, e.g. "southamerica-east1"
  usageType?: string; // exact, e.g. "OnDemand"
  pageSize?: number; // default 200
  pageToken?: string; // GCP native pagination
}

interface WorkerService { serviceId: string; displayName: string }
interface WorkerSku {
  skuId: string;
  description: string;
  resourceFamily?: string;
  resourceGroup?: string;
  usageType?: string;
  regions?: string[];
  unit?: string;
  usd?: number;
}

async function getJson<T>(path: string, timeout = 20000): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`GCP price proxy HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}

const looksLikeId = (s: string) => /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/i.test(s);

async function resolveServiceId(service: string): Promise<WorkerService | null> {
  if (looksLikeId(service)) return { serviceId: service.toUpperCase(), displayName: service };
  const cacheKey = 'gcpworker_services';
  let services = pricingCache.get<WorkerService[]>(cacheKey);
  if (!services) {
    const d = await getJson<{ items?: WorkerService[]; services?: WorkerService[] } | WorkerService[]>('/services');
    services = Array.isArray(d) ? d : d.items || d.services || [];
    pricingCache.set(cacheKey, services, 1440); // 24h — catalog is stable
  }
  const q = service.toLowerCase();
  // Prefer an exact displayName, else the shortest substring match (avoids "BigQuery BI Engine" when asked "BigQuery").
  const matches = services.filter((s) => s.displayName.toLowerCase().includes(q));
  if (!matches.length) return null;
  matches.sort((a, b) => a.displayName.length - b.displayName.length);
  return matches.find((s) => s.displayName.toLowerCase() === q) || matches[0];
}

export async function getGcpPrice(params: GetGcpPriceParams = {}) {
  // No service -> list services (optionally filtered).
  if (!params.service) {
    const d = await getJson<{ items?: WorkerService[]; services?: WorkerService[] } | WorkerService[]>(
      `/services${params.query ? `?q=${encodeURIComponent(params.query)}` : ''}`
    );
    const services = (Array.isArray(d) ? d : d.items || d.services || []).map((s) => ({ serviceId: s.serviceId, displayName: s.displayName }));
    return { provider: 'GCP', source: 'Cloud Billing Catalog (live proxy)', usage: 'Pass service (name or serviceId) to get its SKUs.', count: services.length, services };
  }

  const svc = await resolveServiceId(params.service);
  if (!svc) return { error: `No GCP service matching "${params.service}"`, hint: 'Call get_gcp_price with no service to list them.' };

  const pageSize = Math.min(params.pageSize || (params.region ? 1000 : 200), 1000);
  const buildUrl = (token?: string) => {
    const qs = new URLSearchParams();
    if (params.query) qs.set('q', params.query);
    if (params.usageType) qs.set('usageType', params.usageType);
    qs.set('pageSize', String(pageSize));
    if (token) qs.set('pageToken', token);
    return `/${svc.serviceId}?${qs}`;
  };

  const r = params.region?.toLowerCase();
  const inRegion = (s: WorkerSku) => !r || (s.regions || []).some((x) => x.toLowerCase() === r);

  // Region-specific SKUs are spread across native catalog pages, so walk a
  // bounded number of pages (max ~8) when a region filter is set.
  const maxPages = params.region ? 8 : 1;
  const matched: WorkerSku[] = [];
  let token = params.pageToken;
  let pages = 0;
  let nextPageToken: string | null = null;
  do {
    const d: { items?: WorkerSku[]; nextPageToken?: string } = await getJson(buildUrl(token));
    for (const s of d.items || []) if (inRegion(s)) matched.push(s);
    token = d.nextPageToken || undefined;
    nextPageToken = d.nextPageToken || null;
    pages++;
  } while (token && pages < maxPages && matched.length < 100);

  const items = matched.slice(0, 100);
  return {
    provider: 'GCP',
    source: 'Cloud Billing Catalog (live proxy)',
    service: svc.displayName,
    serviceId: svc.serviceId,
    filters: { query: params.query || null, region: params.region || null, usageType: params.usageType || null },
    returned: items.length,
    pagesScanned: pages,
    nextPageToken: pages >= maxPages ? nextPageToken : null,
    skus: items.map((s) => ({ description: s.description, resourceGroup: s.resourceGroup, usageType: s.usageType, regions: s.regions, usd: s.usd, unit: s.unit })),
    note: 'usd = last-tier unit price (units + nanos/1e9). With a region filter, up to 8 catalog pages are scanned; pass nextPageToken to continue.',
  };
}
