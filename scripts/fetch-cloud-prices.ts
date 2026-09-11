/**
 * Mirror the GCP + AWS service prices that the Vantage instances MCP does NOT
 * cover into a local bundle (src/data/infracost-pricing.json).
 *
 *   npx tsx scripts/fetch-cloud-prices.ts
 *
 * - AWS: authoritative AWS Price List Bulk API (public, NO key). Refreshed every
 *   run. One row per on-demand price dimension (captures tiers).
 * - GCP: Infracost Cloud Pricing API — needs INFRACOST_API_KEY (ico-...) in env.
 *   If the key is absent, existing GCP rows in the bundle are kept as-is (only
 *   AWS is refreshed). The key is read from env only — never write it into the repo.
 *
 * Skips instance families Vantage already serves (EC2/RDS/ElastiCache/
 * OpenSearch/Redshift, GCP Compute Engine).
 */

import { readFileSync, writeFileSync } from 'fs';
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

// ---------- GCP: Infracost (needs key) ----------
const IC_API = 'https://pricing.api.infracost.io/graphql';
const GCP_CONFIG: Array<{ service: string; regions: string[] }> = [
  { service: 'Kubernetes Engine', regions: ['us-central1', 'southamerica-east1'] },
  { service: 'Cloud Run', regions: ['us-central1', 'southamerica-east1'] },
  { service: 'BigQuery', regions: ['us-central1', 'southamerica-east1'] },
  { service: 'Cloud SQL', regions: ['us-central1', 'southamerica-east1'] },
];

async function fetchGcp(key: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const { service, regions } of GCP_CONFIG) {
    for (const region of regions) {
      const query = `{ products(filter: {vendorName: "gcp", service: "${service}", region: "${region}"}) { productFamily attributes { key value } prices { USD unit } } }`;
      const res = await fetch(IC_API, {
        method: 'POST',
        headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`gcp ${service}/${region}: HTTP ${res.status}`);
      const json = (await res.json()) as { data?: { products: Array<{ productFamily: string; attributes: Array<{ key: string; value: string }>; prices: Array<{ USD: string; unit: string }> }> }; error?: string };
      if (json.error) throw new Error(`gcp ${service}/${region}: ${json.error}`);
      let kept = 0;
      for (const p of json.data?.products || []) {
        const price = p.prices?.[0];
        if (!price || price.USD == null) continue;
        const attrs = Object.fromEntries(p.attributes.map((a) => [a.key, a.value]));
        rows.push({ vendor: 'gcp', service, region, family: p.productFamily, label: attrs.description || Object.values(attrs).slice(0, 3).join(' · '), attrs, usd: Number(price.USD), unit: price.unit || '' });
        kept++;
      }
      console.error(`  gcp ${service} @ ${region}: ${kept} priced`);
    }
  }
  return rows;
}

// ---------- assemble ----------
console.error('AWS (Price List Bulk API):');
const awsRows = await fetchAws();

const key = process.env.INFRACOST_API_KEY;
let gcpRows: Row[];
if (key) {
  console.error('GCP (Infracost):');
  gcpRows = await fetchGcp(key);
} else {
  console.error('GCP: no INFRACOST_API_KEY — keeping existing GCP rows from the bundle.');
  try {
    const existing = JSON.parse(readFileSync(OUT, 'utf-8')) as { rows: Row[] };
    gcpRows = existing.rows.filter((r) => r.vendor === 'gcp');
  } catch {
    gcpRows = [];
  }
  console.error(`  kept ${gcpRows.length} GCP rows`);
}

const rows = [...gcpRows, ...awsRows];
const out = {
  source: 'AWS Price List Bulk API (aws) + Infracost Cloud Pricing API (gcp)',
  asOf: new Date().toISOString().slice(0, 10),
  note: 'GCP+AWS services not covered by the Vantage instances MCP. AWS: one row per on-demand price dimension (authoritative, keyless). GCP: first listed USD rate per product. Refresh: npx tsx scripts/fetch-cloud-prices.ts (GCP needs INFRACOST_API_KEY).',
  rows,
};
writeFileSync(OUT, JSON.stringify(out));
console.error(`\nWrote ${rows.length} rows (${gcpRows.length} gcp + ${awsRows.length} aws) to ${OUT}`);
