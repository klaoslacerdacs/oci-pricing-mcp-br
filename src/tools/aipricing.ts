/**
 * Generative-AI pricing for Azure and GCP — the gap the Vantage instances MCP
 * doesn't cover (it's compute-instance only).
 *
 * - azure: LIVE via the public Azure Retail Prices API (prices.azure.com).
 * - gcp:   bundled snapshot of Gemini token prices — GCP has no unauthenticated
 *          pricing API, so scraping the JS pricing page isn't reliable.
 *          ponytail: refresh src/data/gcp-ai-pricing.json from source; wire the
 *          Cloud Billing Catalog API (needs a key) only if live GCP AI is needed.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pricingCache } from '../data/cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AZURE_API = 'https://prices.azure.com/api/retail/prices';

export interface GetAiPriceParams {
  provider: 'azure' | 'gcp';
  query?: string;
  region?: string; // azure only (armRegionName), e.g. eastus
  currency?: string; // azure only, default USD
  top?: number; // azure only, max rows (default 20)
}

interface AzureItem {
  productName: string;
  meterName: string;
  skuName: string;
  retailPrice: number;
  currencyCode: string;
  unitOfMeasure: string;
  armRegionName: string;
}

/** Live Azure AI/ML retail prices, filtered server-side. */
async function getAzureAiPrice(params: GetAiPriceParams) {
  const currency = params.currency || 'USD';
  const top = Math.min(params.top || 20, 100);

  let filter = `serviceFamily eq 'AI + Machine Learning'`;
  if (params.region) filter += ` and armRegionName eq '${params.region.replace(/'/g, "''")}'`;
  if (params.query) filter += ` and contains(meterName,'${params.query.replace(/'/g, "''")}')`;

  // The Azure Retail Prices API has no $top; it pages 1000 at a time via $skip.
  // So we cap client-side and report the raw match total.
  const url = `${AZURE_API}?currencyCode=${encodeURIComponent(currency)}&$filter=${encodeURIComponent(filter)}`;
  const cacheKey = `azure_ai_${currency}_${params.region || ''}_${params.query || ''}_${top}`;
  const cached = pricingCache.get<object>(cacheKey);
  if (cached) return cached;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Azure Retail API HTTP ${res.status}`);
  const data = (await res.json()) as { Items: AzureItem[]; NextPageLink: string | null };

  const items = data.Items.slice(0, top).map((i) => ({
    product: i.productName,
    meter: i.meterName,
    sku: i.skuName,
    price: i.retailPrice,
    currency: i.currencyCode,
    unit: i.unitOfMeasure,
    region: i.armRegionName,
  }));

  const result = {
    provider: 'Azure',
    source: 'prices.azure.com (live retail prices)',
    filters: { query: params.query || null, region: params.region || null, currency },
    returned: items.length,
    totalMatched: data.NextPageLink ? `${data.Items.length}+ (more pages)` : data.Items.length,
    items,
    notes: [
      `Showing ${items.length} of ${data.Items.length}${data.NextPageLink ? '+' : ''} matches — narrow with query/region.`,
      'serviceFamily = "AI + Machine Learning" (Azure OpenAI is now "Foundry Models").',
      'Token meters are usually per 1K/1M tokens — check the unit column.',
    ],
  };
  pricingCache.set(cacheKey, result, 720); // 12h
  return result;
}

let gcpCache: { source: string; asOf: string; currency: string; unit: string; note: string; models: Array<Record<string, unknown>> } | null = null;
function loadGcp() {
  if (!gcpCache) gcpCache = JSON.parse(readFileSync(join(__dirname, '../data/gcp-ai-pricing.json'), 'utf-8'));
  return gcpCache!;
}

/** Bundled GCP Gemini token prices. */
function getGcpAiPrice(params: GetAiPriceParams) {
  const data = loadGcp();
  const q = params.query?.toLowerCase();
  const models = q ? data.models.filter((m) => String(m.model).toLowerCase().includes(q)) : data.models;
  return {
    provider: 'GCP (Vertex AI / Gemini API)',
    source: data.source,
    asOf: data.asOf,
    currency: data.currency,
    unit: data.unit,
    count: models.length,
    models,
    note: data.note,
  };
}

export function getAiPrice(params: GetAiPriceParams) {
  if (params.provider === 'azure') return getAzureAiPrice(params);
  if (params.provider === 'gcp') return getGcpAiPrice(params);
  throw new Error(`Unknown provider "${params.provider}" — use "azure" or "gcp" (OCI AI: list_aiml_services)`);
}
