/**
 * One-shot: mirror the GCP + AWS service prices that the Vantage instances MCP
 * does NOT cover into a local bundle (src/data/infracost-pricing.json).
 *
 * Source: Infracost Cloud Pricing API (GraphQL). Needs a key:
 *   INFRACOST_API_KEY=ico-... npx tsx scripts/fetch-infracost.ts
 * The key is read from env only — never write it into the repo.
 *
 * Skips instance families Vantage already serves (EC2/RDS/ElastiCache/
 * OpenSearch/Redshift, GCP Compute Engine).
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const API = 'https://pricing.api.infracost.io/graphql';
const KEY = process.env.INFRACOST_API_KEY;
if (!KEY) {
  console.error('Set INFRACOST_API_KEY (ico-...) in the env.');
  process.exit(1);
}

// vendor -> services Vantage doesn't cover -> regions to snapshot
const CONFIG: Array<{ vendor: string; service: string; regions: string[] }> = [
  { vendor: 'gcp', service: 'Kubernetes Engine', regions: ['us-central1', 'southamerica-east1'] },
  { vendor: 'gcp', service: 'Cloud Run', regions: ['us-central1', 'southamerica-east1'] },
  { vendor: 'gcp', service: 'BigQuery', regions: ['us-central1', 'southamerica-east1'] },
  { vendor: 'gcp', service: 'Cloud SQL', regions: ['us-central1', 'southamerica-east1'] },
  { vendor: 'aws', service: 'AWSLambda', regions: ['us-east-1', 'sa-east-1'] },
  { vendor: 'aws', service: 'AmazonS3', regions: ['us-east-1', 'sa-east-1'] },
  { vendor: 'aws', service: 'AmazonEKS', regions: ['us-east-1', 'sa-east-1'] },
  { vendor: 'aws', service: 'AmazonDynamoDB', regions: ['us-east-1', 'sa-east-1'] },
];

interface Product {
  productFamily: string;
  attributes: Array<{ key: string; value: string }>;
  prices: Array<{ USD: string; unit: string }>;
}

async function fetchProducts(vendor: string, service: string, region: string): Promise<Product[]> {
  const query = `{ products(filter: {vendorName: "${vendor}", service: "${service}", region: "${region}"}) { productFamily attributes { key value } prices { USD unit } } }`;
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'X-Api-Key': KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${service}/${region}: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { products: Product[] }; error?: string };
  if (json.error) throw new Error(`${service}/${region}: ${json.error}`);
  return json.data?.products || [];
}

// GCP products carry a human "description"; AWS products don't — they use
// usagetype/operation/instanceType/etc. So build a readable label per vendor and
// keep a trimmed attribute map so every field stays searchable.
const AWS_LABEL_KEYS = ['usagetype', 'operation', 'instanceType', 'instanceFamily', 'volumeApiName', 'group', 'groupDescription', 'storageClass'];

function label(attr: Record<string, string>, vendor: string): string {
  if (attr.description) return attr.description;
  if (vendor === 'aws') {
    const parts = AWS_LABEL_KEYS.map((k) => attr[k]).filter(Boolean);
    if (parts.length) return parts.join(' · ');
  }
  return Object.values(attr).slice(0, 3).join(' · ');
}

const rows: Array<{ vendor: string; service: string; region: string; family: string; label: string; attrs: Record<string, string>; usd: number; unit: string }> = [];

for (const { vendor, service, regions } of CONFIG) {
  for (const region of regions) {
    const products = await fetchProducts(vendor, service, region);
    let kept = 0;
    for (const p of products) {
      const price = p.prices?.[0];
      if (!price || price.USD == null) continue; // skip products with no listed price
      const attr = Object.fromEntries(p.attributes.map((a) => [a.key, a.value]));
      rows.push({
        vendor,
        service,
        region,
        family: p.productFamily,
        label: label(attr, vendor),
        attrs: attr,
        usd: Number(price.USD),
        unit: price.unit || '',
      });
      kept++;
    }
    console.error(`  ${vendor} ${service} @ ${region}: ${products.length} products, ${kept} priced`);
  }
}

const out = {
  source: 'Infracost Cloud Pricing API (pricing.api.infracost.io)',
  asOf: new Date().toISOString().slice(0, 10),
  note: 'Snapshot of GCP+AWS services not covered by the Vantage instances MCP. Price is the first listed USD rate per product; some products have multiple tiers/purchase options. Refresh: INFRACOST_API_KEY=... npx tsx scripts/fetch-infracost.ts',
  rows,
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), '../src/data/infracost-pricing.json');
writeFileSync(outPath, JSON.stringify(out));
console.error(`\nWrote ${rows.length} rows to ${outPath}`);
