/**
 * Live Azure price lookup for services NOT covered by the Vantage instances MCP
 * (AKS, databases, caches, storage, etc.). The Azure Retail Prices API is public
 * and keyless. GCP + AWS non-instance services are served locally instead — see
 * src/tools/bundled.ts (getServicePrice).
 */

import { pricingCache } from '../data/cache.js';

const AZURE_API = 'https://prices.azure.com/api/retail/prices';

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
