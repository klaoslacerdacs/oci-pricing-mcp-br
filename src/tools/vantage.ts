/**
 * Multicloud compute pricing via the public Vantage instances MCP
 * (instances.vantage.sh — ex ec2instances.info). Live AWS/Azure/GCP instance
 * pricing on demand, plus the OCPU<->vCPU de-para against OCI E5 compute.
 *
 * Why proxy the Vantage MCP instead of the raw dataset: the open JSON dumps are
 * huge (EC2 ~316MB), unusable at runtime. The MCP answers per-instance with a
 * few KB. Endpoint URL is overridable via VANTAGE_MCP_URL.
 */

import { pricingCache } from '../data/cache.js';
import { calculateMonthlyCost } from './calculator.js';

const VANTAGE_URL =
  process.env.VANTAGE_MCP_URL ||
  'https://instances-mcp.vantage.sh/mcp/7df14383-f859-48e5-9e51-c7f169b2fed0';

const HOURS_PER_MONTH = 730;

type Provider = 'aws' | 'azure' | 'gcp';

interface ProviderCfg {
  detailTool: string;
  regionTool: string;
  defaultRegion: string;
  label: string;
}

const PROVIDERS: Record<Provider, ProviderCfg> = {
  aws: { detailTool: 'get-ec2-instance', regionTool: 'get-ec2-region-pricing', defaultRegion: 'us-east-1', label: 'AWS EC2' },
  azure: { detailTool: 'get-azure-instance', regionTool: 'get-azure-region-pricing', defaultRegion: 'eastus', label: 'Azure' },
  gcp: { detailTool: 'get-gcp-instance', regionTool: 'get-gcp-region-pricing', defaultRegion: 'us-central1', label: 'GCP' },
};

/** Call the Vantage MCP (JSON-RPC over streamable HTTP) and return the text payload. Cached. */
async function callVantage(tool: string, args: Record<string, string>): Promise<string> {
  const cacheKey = `vantage_${tool}_${Object.values(args).join('_')}`;
  const cached = pricingCache.get<string>(cacheKey);
  if (cached) return cached;

  const res = await fetch(VANTAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Vantage MCP HTTP ${res.status}`);

  // Response is SSE: one or more `data: {json}` lines. Take the one carrying the JSON-RPC envelope.
  const body = await res.text();
  const line = body.split('\n').reverse().find((l) => l.startsWith('data:') && l.includes('"jsonrpc"'));
  if (!line) throw new Error('Vantage MCP: no data frame in response');
  const env = JSON.parse(line.slice(line.indexOf(':') + 1).trim()) as {
    error?: { message: string };
    result?: { content: Array<{ text: string }> };
  };
  if (env.error) throw new Error(`Vantage MCP: ${env.error.message}`);
  const text = env.result?.content?.[0]?.text;
  if (!text) throw new Error('Vantage MCP: empty result');

  pricingCache.set(cacheKey, text, 720); // 12h — instance pricing barely moves
  return text;
}

/** First `$X/hr` on the row for the given OS in a region-pricing markdown table. */
export function parseOnDemandHourly(md: string, os: string): number {
  const osEsc = os.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = md.split('\n').find((l) => new RegExp(`\\|\\s*${osEsc}\\s*\\|`, 'i').test(l));
  const m = row?.match(/\$([0-9.]+)\s*\/\s*hr/i);
  if (!m) throw new Error(`On-Demand price not found for OS "${os}"`);
  return parseFloat(m[1]);
}

export function parseSpec(md: string, label: RegExp): number | undefined {
  const m = md.match(label);
  return m ? parseFloat(m[1]) : undefined;
}

export interface CloudInstancePriceParams {
  provider: Provider;
  instanceType: string;
  region?: string;
  os?: string; // for RDS this selects the engine (PostgreSQL/MySQL/MariaDB/SQL Server/Oracle...)
  service?: 'ec2' | 'rds'; // aws only; rds prices managed databases (db.* instance types)
}

/** Raw live price + specs for one cloud instance type (EC2/RDS/Azure/GCP). */
export async function getCloudInstancePrice(params: CloudInstancePriceParams) {
  const cfg = PROVIDERS[params.provider];
  if (!cfg) throw new Error(`Unknown provider: ${params.provider}`);
  const rds = params.provider === 'aws' && params.service === 'rds';
  const detailTool = rds ? 'get-rds-instance' : cfg.detailTool;
  const regionTool = rds ? 'get-rds-region-pricing' : cfg.regionTool;
  const region = params.region || cfg.defaultRegion;
  const os = params.os || (rds ? 'PostgreSQL' : 'Linux'); // RDS "os" column = DB engine

  const [detail, pricing] = await Promise.all([
    callVantage(detailTool, { instanceType: params.instanceType }),
    callVantage(regionTool, { instanceType: params.instanceType, region }),
  ]);

  const vcpu = parseSpec(detail, /vCPUs:\s*([0-9.]+)/i);
  const memoryGB = parseSpec(detail, /Memory \(GiB\):\s*([0-9.]+)/i);
  const hourly = parseOnDemandHourly(pricing, os);

  return {
    provider: rds ? 'AWS RDS' : cfg.label,
    instanceType: params.instanceType,
    region,
    [rds ? 'engine' : 'os']: os,
    vcpu,
    memoryGB,
    onDemandHourly: hourly,
    monthlyOnDemand: Math.round(hourly * HOURS_PER_MONTH * 100) / 100,
    source: 'instances.vantage.sh (live)',
  };
}

export interface CompareVmParams extends CloudInstancePriceParams {}

// AWS burstable (T-family) baseline CPU utilization per vCPU (AWS docs).
const T_BASELINES: Record<string, Record<string, number>> = {
  t2: { nano: 0.05, micro: 0.1, small: 0.2, medium: 0.2, large: 0.3, xlarge: 0.225, '2xlarge': 0.16875 },
  t3: { nano: 0.05, micro: 0.1, small: 0.2, medium: 0.2, large: 0.3, xlarge: 0.4, '2xlarge': 0.4 },
};
T_BASELINES.t3a = T_BASELINES.t3;
T_BASELINES.t4g = T_BASELINES.t3;

/**
 * De-para for AWS T2/T3 burstable vs OCI burstable VMs.
 * OCI burstable bills compute at a baseline fraction (12.5% or 50% of OCPUs);
 * bursting above it is free. Pick the smallest OCI baseline whose sustained
 * vCPU capacity (ocpus × 2 × baseline) covers the T-instance's sustained vCPUs.
 */
export function chooseOciBurstBaseline(instanceType: string, vcpu: number, ocpus: number) {
  const m = instanceType.match(/^(t[0-9]a?g?)\.([a-z0-9]+)$/i);
  const perVcpu = m && T_BASELINES[m[1].toLowerCase()]?.[m[2].toLowerCase()];
  if (!perVcpu) return null;
  const sustainedVcpu = Math.round(vcpu * perVcpu * 1000) / 1000;
  const baseline = [0.125, 0.5].find((b) => ocpus * 2 * b >= sustainedVcpu) ?? 1;
  return { awsBaselinePerVcpu: perVcpu, sustainedVcpu, ociBaseline: baseline === 1 ? undefined : baseline };
}

/**
 * Compare a real cloud VM against the equivalent OCI E5 shape.
 * De-para: OCI sells OCPUs (1 OCPU = 1 physical core = 2 vCPUs); the other clouds
 * sell vCPUs (threads). So N vCPU -> N/2 OCPU on OCI, same RAM.
 */
export async function compareVmOciVsCloud(params: CompareVmParams) {
  const cloud = await getCloudInstancePrice(params);

  if (cloud.vcpu === undefined || cloud.memoryGB === undefined) {
    return { error: 'Could not read vCPU/memory from Vantage; cannot size OCI equivalent', cloud };
  }

  // ponytail: E5.Flex is whole-OCPU; round up odd vCPU counts. Fractional OCPU not offered.
  const ocpus = Math.max(1, Math.round(cloud.vcpu / 2));
  // AWS T2/T3 are burstable: match with an OCI burstable baseline of equal sustained capacity.
  const burstMatch = params.provider === 'aws' && params.service !== 'rds'
    ? chooseOciBurstBaseline(params.instanceType, cloud.vcpu, ocpus)
    : null;
  const oci = calculateMonthlyCost({
    compute: { shape: 'VM.Standard.E5.Flex', ocpus, memoryGB: cloud.memoryGB, burstBaseline: burstMatch?.ociBaseline },
  });

  const ociMonthly = oci.totalMonthly;
  const diff = Math.round((cloud.monthlyOnDemand - ociMonthly) * 100) / 100;
  const pct = ociMonthly > 0 ? Math.round((diff / ociMonthly) * 100) : 0;

  return {
    config: { vcpu: cloud.vcpu, memoryGB: cloud.memoryGB },
    cloud: {
      provider: cloud.provider,
      instanceType: cloud.instanceType,
      region: cloud.region,
      monthlyOnDemand: cloud.monthlyOnDemand,
      hourly: cloud.onDemandHourly,
    },
    oci: {
      shape: 'VM.Standard.E5.Flex',
      ocpus,
      ...(burstMatch?.ociBaseline ? { burstBaseline: burstMatch.ociBaseline } : {}),
      memoryGB: cloud.memoryGB,
      region: 'any commercial (flat pricing)',
      monthly: ociMonthly,
      breakdown: oci.breakdown,
    },
    depara: burstMatch?.ociBaseline
      ? `${cloud.vcpu} vCPU = ${ocpus} OCPU (1 OCPU = 2 vCPU); RAM 1:1. Burstable: ${params.instanceType} baseline ${burstMatch.awsBaselinePerVcpu * 100}%/vCPU (${burstMatch.sustainedVcpu} sustained vCPU) → OCI burstable baseline ${burstMatch.ociBaseline} (${ocpus * 2 * burstMatch.ociBaseline} sustained vCPU)`
      : `${cloud.vcpu} vCPU = ${ocpus} OCPU (1 OCPU = 2 vCPU); RAM 1:1`,
    verdict:
      diff > 0
        ? `OCI is $${Math.abs(diff)}/mo cheaper (${Math.abs(pct)}%)`
        : diff < 0
          ? `${cloud.provider} is $${Math.abs(diff)}/mo cheaper (${Math.abs(pct)}%)`
          : 'Same price',
    currency: 'USD',
    notes: [
      ...(burstMatch?.ociBaseline
        ? ['Burstable match: AWS T-family accrues credits (surplus billed in unlimited mode); OCI bursting above baseline is free but not guaranteed. Sustained-capacity equivalence, not identical behavior.']
        : []),
      'Cloud price = On-Demand Linux; add Savings Plans/Reserved for committed discounts.',
      'OCI E5 has flat global pricing; the other clouds vary by region (esp. sa-east-1 premium).',
      'Storage and egress not included — use calculate_storage_cost / compare_data_egress.',
    ],
  };
}
