/**
 * Mirror the AWS service prices that the Vantage instances MCP does NOT cover
 * into a local bundle (src/data/service-pricing.json).
 *
 *   npx tsx scripts/fetch-cloud-prices.ts
 *
 * AWS only: authoritative AWS Price List Bulk API (public, NO key). One row per
 * on-demand price dimension (captures tiers). Skips EC2/RDS/ElastiCache/
 * OpenSearch/Redshift (Vantage covers those). GCP is served LIVE at runtime by
 * get_gcp_price (Cloud Billing Catalog proxy) — not bundled.
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/data/service-pricing.json');

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

// ---------- AWS: Price List Bulk API (no key) ----------
const AWS_BASE = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws';
const AWS_CONFIG: Array<{ code: string; name: string }> = [
  { code: 'AWSLambda', name: 'Lambda' },
  { code: 'AmazonS3', name: 'S3' },
  { code: 'AmazonEKS', name: 'EKS' },
  { code: 'AmazonDynamoDB', name: 'DynamoDB' },
];
const AWS_REGIONS = ['us-east-1', 'sa-east-1'];

interface AwsOffer {
  products: Record<string, { productFamily?: string; attributes?: Record<string, string> }>;
  terms: { OnDemand?: Record<string, Record<string, { priceDimensions: Record<string, { description?: string; unit?: string; pricePerUnit?: { USD?: string } }> }>> };
}

async function fetchAws(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const { code, name } of AWS_CONFIG) {
    for (const region of AWS_REGIONS) {
      const res = await fetch(`${AWS_BASE}/${code}/current/${region}/index.json`, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) { console.error(`  aws ${name} @ ${region}: HTTP ${res.status} (skip)`); continue; }
      const offer = (await res.json()) as AwsOffer;
      let kept = 0;
      for (const [sku, terms] of Object.entries(offer.terms.OnDemand || {})) {
        const product = offer.products[sku];
        if (!product) continue;
        for (const term of Object.values(terms)) {
          for (const dim of Object.values(term.priceDimensions)) {
            const usd = Number(dim.pricePerUnit?.USD);
            if (!Number.isFinite(usd)) continue;
            rows.push({
              vendor: 'aws',
              service: name,
              region,
              family: product.productFamily || '',
              label: dim.description || product.attributes?.usagetype || sku,
              attrs: product.attributes || {},
              usd,
              unit: dim.unit || '',
            });
            kept++;
          }
        }
      }
      console.error(`  aws ${name} @ ${region}: ${kept} price dimensions`);
    }
  }
  return rows;
}

// ---------- assemble ----------
console.error('AWS (Price List Bulk API):');
const rows = await fetchAws();

const out = {
  source: 'AWS Price List Bulk API',
  asOf: new Date().toISOString().slice(0, 10),
  note: 'AWS services not covered by the Vantage instances MCP. One row per on-demand price dimension (authoritative, keyless). GCP is served live by get_gcp_price. Refresh: npx tsx scripts/fetch-cloud-prices.ts',
  rows,
};
writeFileSync(OUT, JSON.stringify(out));
console.error(`\nWrote ${rows.length} AWS rows to ${OUT}`);
