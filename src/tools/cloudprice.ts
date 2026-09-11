/**
 * General cross-cloud price lookup for services NOT covered by the Vantage
 * instances MCP (which is compute/DB *instances* only): AKS, GKE, Cloud Run,
 * BigQuery, managed databases, caches, etc.
 *
 * - Azure: LIVE, no key — the Retail Prices API covers every Azure service.
 * - GCP:   LIVE via the Cloud Billing Catalog API, which REQUIRES an API key
 *          (env GCP_API_KEY). There is no unauthenticated GCP price source.
 */

import { pricingCache } from '../data/cache.js';

const AZURE_API = 'https://prices.azure.com/api/retail/prices';
const GCP_API = 'https://cloudbilling.googleapis.com/v1';

const esc = (s: string) => s.replace(/'/g, "''"); // OData literal escape

export interface GetAzurePriceParams {
  query?: string; // matches serviceName/productName/meterName
  serviceName?: string; // exact, e.g. "Azure Kubernetes Service"
  region?: string; // armRegionName, e.g. eastus
  currency?: string; // default USD
  top?: number; // default 20, max 100
}

export async function getAzurePrice(params: GetAzurePriceParams) {
  if (!params.query && !params.serviceName) {
    return { error: 'Pass query or serviceName — the full Azure catalog is too large to return unfiltered.' };
  }
  const currency = params.currency || 'USD';
  const top = Math.min(params.top || 20, 100);

  const clauses: string[] = [];
  if (params.serviceName) clauses.push(`serviceName eq '${esc(params.serviceName)}'`);
  if (params.query) {
    const q = esc(params.query);
    clauses.push(`(contains(serviceName,'${q}') or contains(productName,'${q}') or contains(meterName,'${q}'))`);
  }
  if (params.region) clauses.push(`armRegionName eq '${esc(params.region)}'`);
  const filter = clauses.join(' and ');

  const cacheKey = `azuresvc_${currency}_${filter}_${top}`;
  const cached = pricingCache.get<object>(cacheKey);
  if (cached) return cached;

  const url = `${AZURE_API}?currencyCode=${encodeURIComponent(currency)}&$filter=${encodeURIComponent(filter)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Azure Retail API HTTP ${res.status}`);
  const data = (await res.json()) as {
    Items: Array<{ serviceName: string; productName: string; meterName: string; retailPrice: number; currencyCode: string; unitOfMeasure: string; armRegionName: string; type: string }>;
    NextPageLink: string | null;
  };

  const items = data.Items.slice(0, top).map((i) => ({
    service: i.serviceName,
    product: i.productName,
    meter: i.meterName,
    price: i.retailPrice,
    currency: i.currencyCode,
    unit: i.unitOfMeasure,
    region: i.armRegionName,
    type: i.type,
  }));

  const result = {
    provider: 'Azure',
    source: 'prices.azure.com (live retail prices)',
    filters: { query: params.query || null, serviceName: params.serviceName || null, region: params.region || null, currency },
    returned: items.length,
    totalMatched: data.NextPageLink ? `${data.Items.length}+ (more pages)` : data.Items.length,
    items,
    note: `Showing ${items.length} of ${data.Items.length}${data.NextPageLink ? '+' : ''} — narrow with region or a more specific query. Check the unit column (per Hour / 1M tokens / GB, etc.).`,
  };
  pricingCache.set(cacheKey, result, 720);
  return result;
}

export interface GetGcpPriceParams {
  service?: string; // GCP service displayName substring, e.g. "Kubernetes", "BigQuery", "Cloud Run"
  query?: string; // SKU description substring, e.g. "N2 Instance Core"
}

interface GcpSku {
  description: string;
  category?: { resourceFamily?: string; resourceGroup?: string; usageType?: string };
  serviceRegions?: string[];
  pricingInfo?: Array<{ pricingExpression?: { usageUnitDescription?: string; tieredRates?: Array<{ unitPrice?: { currencyCode?: string; units?: string; nanos?: number } }> } }>;
}

function skuPrice(s: GcpSku) {
  const rate = s.pricingInfo?.[0]?.pricingExpression?.tieredRates?.slice(-1)[0]?.unitPrice;
  if (!rate) return null;
  return {
    price: Number(rate.units || 0) + (rate.nanos || 0) / 1e9,
    currency: rate.currencyCode || 'USD',
    unit: s.pricingInfo?.[0]?.pricingExpression?.usageUnitDescription || '',
  };
}

/** GCP Cloud Billing Catalog. Needs GCP_API_KEY. No service -> list services. */
export async function getGcpPrice(params: GetGcpPriceParams) {
  const key = process.env.GCP_API_KEY;
  if (!key) {
    return {
      error: 'GCP live pricing needs an API key.',
      howTo: 'Set env GCP_API_KEY to a key with the Cloud Billing Catalog API enabled (console.cloud.google.com/apis/library/cloudbilling.googleapis.com). GCP has no unauthenticated price API.',
      keylessAlternative: 'For Gemini/generative-AI prices use get_ai_price (provider "gcp") — a bundled snapshot that needs no key.',
    };
  }

  // Resolve service list (cached — the catalog is stable).
  const svcKey = 'gcp_services';
  let services = pricingCache.get<Array<{ serviceId: string; displayName: string }>>(svcKey);
  if (!services) {
    const all: Array<{ serviceId: string; displayName: string }> = [];
    let pageToken = '';
    do {
      const u = `${GCP_API}/services?key=${encodeURIComponent(key)}&pageSize=5000${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`GCP Catalog HTTP ${r.status}`);
      const d = (await r.json()) as { services: Array<{ serviceId: string; displayName: string }>; nextPageToken?: string };
      all.push(...(d.services || []));
      pageToken = d.nextPageToken || '';
    } while (pageToken);
    services = all;
    pricingCache.set(svcKey, services, 1440); // 24h
  }

  if (!params.service) {
    const q = params.query?.toLowerCase();
    const list = (q ? services.filter((s) => s.displayName.toLowerCase().includes(q)) : services)
      .map((s) => ({ serviceId: s.serviceId, displayName: s.displayName }));
    return { provider: 'GCP', source: 'Cloud Billing Catalog API (live)', usage: 'Pass service (displayName substring) to list its SKUs.', count: list.length, services: list };
  }

  const svc = services.find((s) => s.displayName.toLowerCase().includes(params.service!.toLowerCase()));
  if (!svc) return { error: `No GCP service matching "${params.service}"`, hint: 'Call get_gcp_price with no service to list them.' };

  // Page through the service's SKUs.
  const skus: GcpSku[] = [];
  let pageToken = '';
  do {
    const u = `${GCP_API}/services/${svc.serviceId}/skus?key=${encodeURIComponent(key)}&pageSize=5000${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`GCP Catalog SKUs HTTP ${r.status}`);
    const d = (await r.json()) as { skus: GcpSku[]; nextPageToken?: string };
    skus.push(...(d.skus || []));
    pageToken = d.nextPageToken || '';
  } while (pageToken);

  const q = params.query?.toLowerCase();
  const rows = skus
    .filter((s) => !q || s.description.toLowerCase().includes(q))
    .slice(0, 50)
    .map((s) => ({
      description: s.description,
      family: s.category?.resourceFamily,
      usageType: s.category?.usageType,
      regions: s.serviceRegions,
      ...(skuPrice(s) || { price: null }),
    }));

  return {
    provider: 'GCP',
    source: 'Cloud Billing Catalog API (live)',
    service: svc.displayName,
    filters: { query: params.query || null },
    returned: rows.length,
    totalSkus: skus.length,
    skus: rows,
    note: 'Price is the last tiered rate (units + nanos). GCP prices vary by region/usageType (on-demand vs commit) — check those fields.',
  };
}
