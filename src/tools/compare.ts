/**
 * Generic cross-cloud comparison. One tool, one CATALOG — each category composes
 * the existing live price functions (OCI native + Vantage + AWS bulk + Azure
 * Retail + GCP proxy) and lays clouds side by side.
 *
 * Honesty over a single number: units differ across clouds. Categories with a
 * common unit (storage $/GB-mo, serverless $/invocation+$/GB-s, DB/K8s per sizing)
 * get a monthlyEstimate; data-warehouse (per node-hr vs per TB scanned vs ECPU)
 * does NOT — comparable:false, components only. No misleading "winner".
 *
 * ponytail: region is a us|br preset (add presets when needed); compute uses
 * on-demand list price (no committed-use / spot).
 */

import { calculateStorageCost } from './storage.js';
import { calculateDatabaseCost } from './database.js';
import { calculateKubernetesCost } from './kubernetes.js';
import { getServerlessPricing } from '../data/fetcher.js';
import { getServicePrice } from './bundled.js';
import { getAzurePrice } from './cloudprice.js';
import { getGcpPrice } from './gcpprice.js';
import { getCloudInstancePrice } from './vantage.js';

const HOURS = 730;

const REGIONS: Record<'us' | 'br', { aws: string; azure: string; gcp: string }> = {
  us: { aws: 'us-east-1', azure: 'eastus', gcp: 'us-central1' },
  br: { aws: 'sa-east-1', azure: 'brazilsouth', gcp: 'southamerica-east1' },
};

type Category = 'object-storage' | 'serverless' | 'database-postgres' | 'kubernetes' | 'data-warehouse';

interface Component { item: string; price: number; unit: string }
interface CloudResult {
  cloud: string;
  service: string;
  components: Component[];
  monthlyEstimate: number | null;
  source: string;
  note?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sizing = Record<string, any>;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Run a per-cloud fetch, degrade to a note on failure instead of failing the whole compare. */
async function safe(cloud: string, service: string, source: string, fn: () => Promise<Omit<CloudResult, 'cloud' | 'service' | 'source'>>): Promise<CloudResult> {
  try {
    return { cloud, service, source, ...(await fn()) };
  } catch (e) {
    return { cloud, service, source, components: [], monthlyEstimate: null, note: `unavailable: ${e instanceof Error ? e.message : e}` };
  }
}

// ---- Azure/GCP/AWS-bundle row pickers ----
async function azureRows(query: string, region: string) {
  const r = (await getAzurePrice({ query, region, top: 100 })) as { items?: Array<{ meter: string; price: number; unit: string; product: string }> };
  return r.items || [];
}
async function gcpRows(service: string, query: string, region: string) {
  const r = (await getGcpPrice({ service, query, region })) as { skus?: Array<{ description: string; usd?: number; unit?: string }> };
  return r.skus || [];
}
function awsRows(service: string, query: string, region: string) {
  const r = getServicePrice({ vendor: 'aws', service, query, region, top: 100 }) as { items?: Array<{ label: string; usd: number; unit: string }> };
  return r.items || [];
}

// ================= categories =================

async function objectStorage(region: keyof typeof REGIONS, sizing: Sizing): Promise<{ comparable: boolean; comparison: CloudResult[]; caveats: string[] }> {
  const gb = Number(sizing.storageGB ?? 1000);
  const tier = (sizing.tier as 'standard' | 'infrequent' | 'archive') || 'standard';
  const R = REGIONS[region];

  const oci = await safe('OCI', 'Object Storage', 'OCI (bundled)', async () => {
    const c = calculateStorageCost({ objectStorageGB: gb, objectStorageTier: tier });
    const per = c.breakdown[0]?.pricePerGB ?? 0;
    return { components: [{ item: `Object Storage (${tier})`, price: per, unit: 'GB-mo' }], monthlyEstimate: round(c.totalMonthly) };
  });
  const aws = await safe('AWS', 'S3', 'AWS Price List', async () => {
    const rows = awsRows('S3', 'GB - first', R.aws).filter((x) => /GB-?Mo/i.test(x.unit) && /storage/i.test(x.label));
    const per = rows[0]?.usd;
    if (per == null) throw new Error('no S3 standard storage rate found');
    return { components: [{ item: rows[0].label.slice(0, 60), price: per, unit: rows[0].unit }], monthlyEstimate: round(per * gb) };
  });
  const azure = await safe('Azure', 'Blob Storage', 'prices.azure.com', async () => {
    const rows = (await azureRows('Hot LRS Data Stored', R.azure)).filter((x) => /GB/i.test(x.unit));
    const per = rows[0]?.price;
    if (per == null) throw new Error('no Blob Hot LRS rate found');
    return { components: [{ item: rows[0].meter, price: per, unit: rows[0].unit }], monthlyEstimate: round(per * gb) };
  });
  const gcp = await safe('GCP', 'Cloud Storage', 'Cloud Billing Catalog', async () => {
    const rows = (await gcpRows('Cloud Storage', 'Standard Storage', R.gcp)).filter((x) => x.usd != null && /gib.*mo|month/i.test(x.unit || ''));
    const per = rows[0]?.usd;
    if (per == null) throw new Error('no Standard Storage rate found');
    return { components: [{ item: rows[0].description.slice(0, 60), price: per, unit: rows[0].unit || 'GiB-mo' }], monthlyEstimate: round(per * gb) };
  });

  return {
    comparable: true,
    comparison: [oci, aws, azure, gcp],
    caveats: [`Monthly = per-GB rate × ${gb} GB, ${tier} tier. Excludes requests, egress, retrieval and min-duration fees.`],
  };
}

async function serverless(region: keyof typeof REGIONS, sizing: Sizing): Promise<{ comparable: boolean; comparison: CloudResult[]; caveats: string[] }> {
  const inv = Number(sizing.monthlyInvocations ?? 1_000_000);
  const ms = Number(sizing.avgDurationMs ?? 200);
  const mem = Number(sizing.memoryMB ?? 256);
  const gbSec = inv * (ms / 1000) * (mem / 1024);
  const R = REGIONS[region];

  const oci = await safe('OCI', 'Functions', 'OCI (bundled)', async () => {
    const rows = getServerlessPricing();
    const invRate = rows.find((r) => r.type === 'functions-invocations')?.pricePerUnit;
    const exRate = rows.find((r) => r.type === 'functions-execution')?.pricePerUnit;
    if (invRate == null || exRate == null) throw new Error('OCI Functions rates not found in bundled data');
    return {
      components: [
        { item: 'Invocations', price: invRate, unit: 'invocation' },
        { item: 'Execution', price: exRate, unit: 'GB-second' },
      ],
      monthlyEstimate: round(inv * invRate + gbSec * exRate, 4),
    };
  });
  const aws = await safe('AWS', 'Lambda', 'AWS Price List', async () => {
    const req = awsRows('Lambda', 'Request', R.aws).find((x) => /Requests/i.test(x.unit))?.usd;
    const gbs = awsRows('Lambda', 'GB-Second', R.aws).find((x) => /Second/i.test(x.unit) && !/Ephemeral/i.test(x.label))?.usd;
    if (req == null || gbs == null) throw new Error('Lambda request/GB-s rate not found');
    return {
      components: [{ item: 'Requests', price: req, unit: 'request' }, { item: 'Duration', price: gbs, unit: 'GB-second' }],
      monthlyEstimate: round(inv * req + gbSec * gbs, 4),
    };
  });
  const azure = await safe('Azure', 'Functions', 'prices.azure.com', async () => {
    const rows = await azureRows('Functions', R.azure);
    const exec = rows.find((x) => /Execution Time/i.test(x.meter))?.price;
    const execs = rows.find((x) => /Total Executions|Executions/i.test(x.meter))?.price;
    const comps: Component[] = [];
    if (exec != null) comps.push({ item: 'Execution Time', price: exec, unit: 'GB-s' });
    if (execs != null) comps.push({ item: 'Executions', price: execs, unit: 'executions' });
    if (!comps.length) throw new Error('Azure Functions consumption meters not found');
    // Estimate from Execution Time (GB-s) only — the per-execution meter's unit varies and isn't safely convertible.
    const monthly = exec != null ? round(gbSec * exec, 4) : null;
    return { components: comps, monthlyEstimate: monthly, note: 'Consumption plan; GB-s only (per-execution charge + free grant excluded).' };
  });
  const gcp = await safe('GCP', 'Cloud Run Functions', 'Cloud Billing Catalog', async () => {
    const rows = await gcpRows('Cloud Run Functions', '', R.gcp);
    const comps = rows.filter((x) => x.usd != null).slice(0, 4).map((x) => ({ item: x.description.slice(0, 45), price: x.usd!, unit: x.unit || '' }));
    if (!comps.length) throw new Error('Cloud Run Functions rates not found');
    return { components: comps, monthlyEstimate: null, note: 'GCP bills CPU-time + memory-time + requests separately; see components (no single estimate).' };
  });

  return {
    comparable: true,
    comparison: [oci, aws, azure, gcp],
    caveats: [`Workload: ${inv.toLocaleString()} invocations/mo × ${ms}ms × ${mem}MB = ${round(gbSec)} GB-s. Free tiers NOT deducted. GCP shown as components only.`],
  };
}

async function databasePostgres(region: keyof typeof REGIONS, sizing: Sizing): Promise<{ comparable: boolean; comparison: CloudResult[]; caveats: string[] }> {
  const ocpus = Number(sizing.ocpus ?? (sizing.vcpu ? Number(sizing.vcpu) / 2 : 1)) || 1;
  const memoryGB = Number(sizing.memoryGB ?? 16);
  const storageGB = Number(sizing.storageGB ?? 100);
  const rdsType = String(sizing.awsRdsInstanceType || 'db.m5.large');
  const R = REGIONS[region];

  const oci = await safe('OCI', 'Managed PostgreSQL', 'OCI (live SKUs)', async () => {
    const c = await calculateDatabaseCost({ type: 'postgresql', computeUnits: ocpus, storageGB, memoryGB });
    return { components: c.breakdown.map((b) => ({ item: b.item, price: b.unitPrice, unit: b.unit })), monthlyEstimate: round(c.totalMonthly), note: `${ocpus} OCPU / ${memoryGB} GB (min 1 OCPU/16GB)` };
  });
  const aws = await safe('AWS', `RDS ${rdsType}`, 'instances.vantage.sh', async () => {
    const r = (await getCloudInstancePrice({ provider: 'aws', service: 'rds', instanceType: rdsType, os: 'PostgreSQL', region: R.aws })) as { monthlyOnDemand: number; onDemandHourly: number; vcpu?: number; memoryGB?: number };
    return { components: [{ item: `${rdsType} PostgreSQL`, price: r.onDemandHourly, unit: 'hour' }], monthlyEstimate: round(r.monthlyOnDemand), note: `${r.vcpu}vCPU/${r.memoryGB}GB; storage billed separately` };
  });
  const azure = await safe('Azure', 'DB for PostgreSQL', 'prices.azure.com', async () => {
    const rows = (await azureRows('PostgreSQL', R.azure)).filter((x) => /vCore/i.test(x.meter) && /Hour/i.test(x.unit) && x.price > 0).sort((a, b) => a.price - b.price);
    const per = rows[0]?.price;
    if (per == null) throw new Error('PostgreSQL vCore rate not found');
    const vcpu = ocpus * 2;
    return { components: [{ item: rows[0].meter, price: per, unit: 'vCore-hr' }], monthlyEstimate: round(per * vcpu * HOURS), note: `${vcpu} vCore` };
  });
  const gcp = await safe('GCP', 'Cloud SQL PostgreSQL', 'Cloud Billing Catalog', async () => {
    const rows = (await gcpRows('Cloud SQL', 'PostgreSQL', R.gcp))
      .filter((x) => x.usd != null && x.usd > 0 && /vCPU/i.test(x.description) && /h$/i.test(x.unit || '') && !/Trial|Extended support/i.test(x.description))
      .sort((a, b) => a.usd! - b.usd!);
    const pick = rows[0];
    if (!pick) throw new Error('Cloud SQL PostgreSQL vCPU rate not found');
    const vcpu = ocpus * 2;
    return { components: [{ item: pick.description.slice(0, 55), price: pick.usd!, unit: 'vCPU-hr' }], monthlyEstimate: round(pick.usd! * vcpu * HOURS), note: `${vcpu} vCPU (compute only; cheapest edition)` };
  });

  return {
    comparable: true,
    comparison: [oci, aws, azure, gcp],
    caveats: [
      'OCI/RDS estimates include their bundle; Azure/GCP shown as compute (vCPU) only — add storage/HA separately.',
      'Azure/GCP pick the cheapest edition vCPU meter (often Burstable) — not necessarily the same tier as OCI/RDS general-purpose; see the meter name in components.',
      'RDS is priced per instance class (default db.m5.large) — pass awsRdsInstanceType to match.',
      '1 OCPU = 2 vCPU used for cross-mapping.',
    ],
  };
}

async function kubernetes(region: keyof typeof REGIONS, sizing: Sizing): Promise<{ comparable: boolean; comparison: CloudResult[]; caveats: string[] }> {
  const nodeCount = Number(sizing.nodeCount ?? 2);
  const vcpu = Number(sizing.vcpu ?? 2);
  const memoryGB = Number(sizing.memoryGB ?? 8);
  const R = REGIONS[region];

  const nodeMonthly = async (provider: 'aws' | 'gcp', instanceType: string) => {
    const r = (await getCloudInstancePrice({ provider, instanceType, region: provider === 'aws' ? R.aws : R.gcp })) as { monthlyOnDemand: number };
    return r.monthlyOnDemand;
  };

  const oci = await safe('OCI', 'OKE', 'OCI (live)', async () => {
    const c = calculateKubernetesCost({ clusterType: 'basic', nodeCount, nodeShape: 'VM.Standard.E5.Flex', nodeOcpus: Math.max(1, Math.round(vcpu / 2)), nodeMemoryGB: memoryGB });
    return { components: c.breakdown.map((b) => ({ item: b.item, price: b.unitPrice, unit: b.unit })), monthlyEstimate: round(c.totalMonthly), note: 'Basic control plane FREE' };
  });
  const aws = await safe('AWS', 'EKS', 'AWS bulk + Vantage', async () => {
    const cp = awsRows('EKS', 'cluster', R.aws).find((x) => /cluster usage/i.test(x.label))?.usd ?? 0.1; // ponytail: known control-plane fee fallback if the row lookup misses
    const nodes = await nodeMonthly('aws', String(sizing.awsNodeType || 'm5.large'));
    return { components: [{ item: 'Control plane', price: cp, unit: 'hour' }, { item: `${nodeCount}× node`, price: round(nodes), unit: 'node-mo' }], monthlyEstimate: round(cp * HOURS + nodes * nodeCount), note: `nodes = ${sizing.awsNodeType || 'm5.large'}` };
  });
  const azure = await safe('Azure', 'AKS', 'prices.azure.com', async () => {
    // AKS free control plane (Standard tier); node compute via Azure retail.
    const rows = (await azureRows(String(sizing.azureNodeType || 'D2s v5'), R.azure)).filter((x) => /Hour/i.test(x.unit) && !/Windows|Spot|Low Priority/i.test(x.meter));
    const per = rows[0]?.price;
    if (per == null) throw new Error('AKS node rate not found — pass azureNodeType');
    return { components: [{ item: 'Control plane (Free tier)', price: 0, unit: 'mo' }, { item: `${nodeCount}× ${rows[0].meter}`, price: per, unit: 'hour' }], monthlyEstimate: round(per * HOURS * nodeCount), note: 'Free control plane' };
  });
  const gcp = await safe('GCP', 'GKE', 'Cloud Billing Catalog + Vantage', async () => {
    const cpRows = (await gcpRows('Kubernetes Engine', 'cluster management', R.gcp)).filter((x) => x.usd != null);
    const cp = cpRows[0]?.usd ?? 0.1; // ponytail: known control-plane fee fallback if the row lookup misses
    const nodes = await nodeMonthly('gcp', String(sizing.gcpNodeType || 'e2-standard-2'));
    return { components: [{ item: 'Cluster management', price: cp, unit: 'hour' }, { item: `${nodeCount}× node`, price: round(nodes), unit: 'node-mo' }], monthlyEstimate: round(cp * HOURS + nodes * nodeCount), note: `nodes = ${sizing.gcpNodeType || 'e2-standard-2'}; one zonal cluster free` };
  });

  return {
    comparable: true,
    comparison: [oci, aws, azure, gcp],
    caveats: [
      `${nodeCount} nodes ~${vcpu}vCPU/${memoryGB}GB each, on-demand. Node types per cloud: pass awsNodeType/azureNodeType/gcpNodeType to align specs.`,
      'Control plane: OKE Basic & one GKE zonal cluster & AKS Free tier are $0; EKS and GKE Autopilot/enterprise charge ~$0.10/hr.',
    ],
  };
}

async function dataWarehouse(region: keyof typeof REGIONS, sizing: Sizing): Promise<{ comparable: boolean; comparison: CloudResult[]; caveats: string[] }> {
  const R = REGIONS[region];
  const ecpus = Number(sizing.ocpus ?? sizing.ecpus ?? 2);
  const storageGB = Number(sizing.storageGB ?? 1024);

  const oci = await safe('OCI', 'Autonomous Data Warehouse', 'OCI (live)', async () => {
    const c = await calculateDatabaseCost({ type: 'autonomous-data-warehouse', computeUnits: ecpus, storageGB });
    return { components: c.breakdown.map((b) => ({ item: b.item, price: b.unitPrice, unit: b.unit })), monthlyEstimate: round(c.totalMonthly), note: `${ecpus} ECPU + ${storageGB}GB (elastic $/ECPU-hr)` };
  });
  const aws = await safe('AWS', 'Redshift', 'AWS bulk', async () => {
    const rows = awsRows('Redshift', 'node', R.aws).filter((x) => /Hrs|Hour/i.test(x.unit)).slice(0, 3);
    if (!rows.length) throw new Error('Redshift node rate not found');
    return { components: rows.map((x) => ({ item: x.label.slice(0, 45), price: x.usd, unit: x.unit })), monthlyEstimate: null, note: 'Priced per node-hour (provisioned) — pick a node type; Serverless bills RPU-hr.' };
  });
  const azure = await safe('Azure', 'Synapse', 'prices.azure.com', async () => {
    const rows = (await azureRows('Synapse', R.azure)).slice(0, 3);
    if (!rows.length) throw new Error('Synapse rate not found');
    return { components: rows.map((x) => ({ item: x.meter, price: x.price, unit: x.unit })), monthlyEstimate: null, note: 'Dedicated (DWU-hr) or serverless (per TB processed).' };
  });
  const gcp = await safe('GCP', 'BigQuery', 'Cloud Billing Catalog', async () => {
    const rows = (await gcpRows('BigQuery', 'Analysis', R.gcp)).filter((x) => x.usd != null).slice(0, 3);
    if (!rows.length) throw new Error('BigQuery analysis rate not found');
    return { components: rows.map((x) => ({ item: x.description.slice(0, 45), price: x.usd!, unit: x.unit || '' })), monthlyEstimate: null, note: 'On-demand bills per TiB scanned; or flat-rate slots.' };
  });

  return {
    comparable: false,
    comparison: [oci, aws, azure, gcp],
    caveats: [
      'NOT directly comparable: OCI ADW = $/ECPU-hr, Redshift = $/node-hr, Synapse = DWU-hr or $/TB, BigQuery = $/TiB scanned. Components only, no single monthly.',
    ],
  };
}

const CATALOG: Record<Category, (region: keyof typeof REGIONS, sizing: Sizing) => Promise<{ comparable: boolean; comparison: CloudResult[]; caveats: string[] }>> = {
  'object-storage': objectStorage,
  serverless,
  'database-postgres': databasePostgres,
  kubernetes,
  'data-warehouse': dataWarehouse,
};

export interface CompareServiceParams {
  category: Category;
  region?: 'us' | 'br';
  sizing?: Sizing;
}

export async function compareService(params: CompareServiceParams) {
  const spec = CATALOG[params.category];
  if (!spec) {
    return { error: `Unknown category "${params.category}"`, categories: Object.keys(CATALOG) };
  }
  const region = params.region || 'us';
  const { comparable, comparison, caveats } = await spec(region, params.sizing || {});

  // Normalize any NaN estimate (a partial upstream) to null so it never shows as a number or wins cheapest.
  for (const c of comparison) if (c.monthlyEstimate != null && !Number.isFinite(c.monthlyEstimate)) c.monthlyEstimate = null;

  const priced = comparison.filter((c) => c.monthlyEstimate != null && Number.isFinite(c.monthlyEstimate)) as Array<CloudResult & { monthlyEstimate: number }>;
  const cheapest = comparable && priced.length ? priced.reduce((a, b) => (b.monthlyEstimate < a.monthlyEstimate ? b : a)).cloud : null;

  return {
    category: params.category,
    region,
    regionCodes: REGIONS[region],
    sizing: params.sizing || {},
    comparable,
    cheapest,
    comparison,
    caveats,
    currency: 'USD',
    hoursPerMonth: HOURS,
  };
}
