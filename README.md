# OCI Pricing MCP Server — BR fork

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides Oracle Cloud Infrastructure pricing data to AI assistants like Claude.

> **Fork of [jasonwilbur/oci-pricing-mcp](https://github.com/jasonwilbur/oci-pricing-mcp)** with a corrected PostgreSQL cost model, live per-SKU pricing, Windows licensing, a paid-by-default free-tier policy, and USD→BRL conversion for Brazilian pricing. See [What's different in this fork](#whats-different-in-this-fork).

> **Important Note:** This server provides pricing data from Oracle's public pricing API and bundled data. We cannot guarantee that AI assistants will always interpret pricing correctly or identify the absolute cheapest options. Always verify pricing on [Oracle's official price list](https://www.oracle.com/cloud/price-list/) before making decisions. All API calls are free of charge (no authentication required).

## What's different in this fork

- **PostgreSQL cost model fixed.** OCI Managed PostgreSQL bills **4 SKUs**, not one: managed service (`B99060`, $0.098/OCPU/hr) + underlying E5 compute (`B97384`) + E5 memory (`B97385`) + optimized storage (`B99062`). Upstream modeled a single line at a stale $0.0336/OCPU, returning ~$25/mo where Oracle bills ~$119. `calculate_database_cost` now emits the full breakdown with **live per-SKU prices** and an optional `memoryGB` param, and enforces the **1 OCPU / 16 GB minimum**.
- **Live SKU pricing.** Prices are looked up live per part number (via Oracle's public API) with the bundled snapshot as fallback.
- **Windows licensing.** `calculate_monthly_cost` accepts `os: "windows"` (adds the `B88318` Windows OS license, $0.092/OCPU/hr) and `burstBaseline` (reduces the billed license OCPUs for burstable shapes).
- **Paid-by-default free-tier policy.** Estimates use **100% paid SKUs**. Always Free is applied **only** to network egress (≤10 TB/month), public IPs, and VCN — never to compute, storage, databases, load balancers, or other managed services. (Also fixed an upstream accounting bug where free egress created a phantom credit that zeroed out unrelated paid items like the load balancer.)
- **`convert_usd_brl` tool.** Converts USD to BRL grossing up Brazilian tax: `BRL = USD × fxRate ÷ taxDivisor` (defaults `5.23` / `0.87`, overridable via env `OCI_FX_BRL` / `OCI_TAX_DIVISOR` or per call).
- **Live multicloud compute.** `get_cloud_instance_price` and `compare_vm_oci_vs_cloud` pull **live** AWS/Azure/GCP instance pricing by proxying the public [Vantage instances MCP](https://instances.vantage.sh) (per-instance, avoids the unusable ~316 MB raw dumps). `compare_vm_oci_vs_cloud` applies the **OCPU↔vCPU de-para** (1 OCPU = 2 vCPU, RAM 1:1) against the OCI E5 shape. Endpoint overridable via env `VANTAGE_MCP_URL`. This replaces the old hardcoded competitor constants for compute — egress/k8s comparisons remain approximate.
- **Cross-cloud service de-para.** `map_cloud_services` looks up equivalent OCI/AWS/Azure/GCP service names across 160 services / 20 categories (bundled from Oracle's public mapping table).

## Why This Exists

AWS, Azure, and GCP all have pricing MCP servers. OCI did not - until now.

| Provider | Pricing MCP | Type |
|----------|-------------|------|
| AWS | [aws-pricing-mcp-server](https://awslabs.github.io/mcp/servers/aws-pricing-mcp-server) | Official |
| Azure | [azure-pricing-mcp](https://github.com/charris-msft/azure-pricing-mcp) | Community |
| GCP | [gcp-cost-mcp-server](https://github.com/nozomi-koborinai/gcp-cost-mcp-server) | Community |
| OCI | **oci-pricing-mcp** | Community |

### Example: "How much does a 4 OCPU, 32GB VM cost on OCI?"

**You ask Claude:**
> What's the monthly cost for a VM with 4 OCPUs and 32GB RAM on OCI?

**Claude responds (using this MCP):**
```
For a VM.Standard.E5.Flex with 4 OCPUs and 32GB RAM:

  OCPU cost:    4 OCPUs × $0.03/hr = $0.12/hr
  Memory cost:  32 GB × $0.002/hr  = $0.064/hr
  Total hourly: $0.184/hr

  Monthly cost (730 hrs): $134.32

For comparison, the Arm-based A1 shape would be significantly cheaper:

  A1 total:     4 × $0.01 + 32 × $0.0015 = $0.088/hr
  Monthly:      $64.24 (52% savings)
```

### Example: "Compare OCI vs AWS for data egress"

**You ask Claude:**
> How much would I save on OCI vs AWS for 5TB of monthly data egress?

**Claude responds (using this MCP):**
```
Data Egress Cost Comparison (5 TB/month):

  OCI:
    First 10 TB free → $0.00

  AWS:
    First 10 GB: free
    Next 9.99 TB @ $0.09/GB → ~$450/month

  Monthly savings with OCI: $450 (100% savings)

OCI includes 10 TB of free outbound data transfer monthly,
making it significantly more cost-effective for data-heavy workloads.
```

## Installation

### Quick Install (Recommended)

Runs straight from this GitHub repo (the `prepare` script builds it on install):

```bash
claude mcp add oci-pricing -- npx -y github:klaoslacerdacs/oci-pricing-mcp-br
```

### For Claude Desktop Users

Add this to your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "oci-pricing": {
      "command": "npx",
      "args": ["-y", "github:klaoslacerdacs/oci-pricing-mcp-br"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/klaoslacerdacs/oci-pricing-mcp-br.git
cd oci-pricing-mcp-br
npm install
npm run build
claude mcp add oci-pricing -- node /path/to/oci-pricing-mcp-br/dist/index.js
```

## Available Tools

### Core Tools

| Tool | Description |
|------|-------------|
| `get_pricing` | Get pricing for any OCI resource by service/type |
| `list_services` | List all OCI services with pricing categories |
| `compare_regions` | Compare pricing across regions (OCI has consistent global pricing) |
| `list_regions` | List all available OCI regions |
| `calculate_monthly_cost` | Estimate monthly spend for a configuration (supports `os: "windows"` + `burstBaseline`) |
| `convert_usd_brl` | Convert a USD amount to BRL with tax gross-up (`BRL = USD × 5.23 ÷ 0.87`) |
| `quick_estimate` | Get cost estimates for common deployment presets |

### Compute Tools

| Tool | Description |
|------|-------------|
| `list_compute_shapes` | List VM shapes (E4, E5, A1, GPU, etc.) with pricing |
| `get_compute_shape_details` | Get detailed info for a specific shape |
| `compare_compute_shapes` | Compare pricing between shapes |

### Storage Tools

| Tool | Description |
|------|-------------|
| `list_storage_options` | Block, object, file, archive storage pricing |
| `calculate_storage_cost` | Calculate cost for specific storage config |
| `compare_storage_tiers` | Compare all tiers for a given size |

### Database Tools

| Tool | Description |
|------|-------------|
| `list_database_options` | Autonomous DB, MySQL, PostgreSQL pricing |
| `calculate_database_cost` | Calculate database cost (PostgreSQL uses the 4-SKU live model; enforces 1 OCPU / 16 GB min) |
| `compare_database_options` | Compare options for workload type |

### Networking Tools

| Tool | Description |
|------|-------------|
| `list_networking_options` | Load balancers, FastConnect, VPN, egress |
| `calculate_networking_cost` | Calculate networking cost with free tier |
| `compare_data_egress` | Compare OCI egress vs AWS/Azure/GCP |

### Kubernetes Tools

| Tool | Description |
|------|-------------|
| `list_kubernetes_options` | OKE cluster options (Basic is FREE) |
| `calculate_kubernetes_cost` | Calculate cluster cost |
| `compare_kubernetes_providers` | Compare OKE vs EKS/AKS/GKE |

### Multicloud Compute Tools (live, via Vantage)

| Tool | Description |
|------|-------------|
| `get_cloud_instance_price` | Live On-Demand price + specs for an AWS/Azure/GCP instance type, by region |
| `compare_vm_oci_vs_cloud` | Compare a cloud VM vs the equivalent OCI E5 shape, with OCPU↔vCPU de-para (1 OCPU = 2 vCPU) |

Example — `t3.medium` in São Paulo vs OCI: `$49.06/mo` (AWS) vs `$27.74/mo` (OCI 1 OCPU / 4 GB) → OCI ~77% cheaper. Cloud price is On-Demand Linux; add Savings Plans/Reserved for committed discounts. Provider defaults: `us-east-1` / `eastus` / `us-central1`.

### Cross-Cloud Service Mapping

| Tool | Description |
|------|-------------|
| `map_cloud_services` | Find equivalent OCI/AWS/Azure/GCP service names (160 services, 20 categories). Filter by `query` or `category`; no args lists categories. |

Each cloud field is a **list** of equivalent products (`[]` when a cloud has no equivalent). Example — `query: "bedrock"` → OCI `["Generative AI", "Generative AI Agents"]` = AWS `["Bedrock"]` = Azure `["OpenAI Service"]` = GCP `["Vertex AI Search and Conversation"]`. Name equivalence only; verify feature parity per provider.

### Generative-AI Pricing (fills the Vantage gap)

Vantage covers compute instances only, not AI. This tool fills Azure + GCP:

| Tool | Description |
|------|-------------|
| `get_ai_price` | `provider: "azure"` → **live** AI/ML meters from `prices.azure.com` (filter by `query`/`region`/`currency`, capped by `top`). `provider: "gcp"` → **bundled** Gemini token prices (source + `asOf` date). OCI AI: use `list_aiml_services`. |

Azure is live and huge — always pass a `query` (matches `meterName`, e.g. `"gpt"`, `"grok"`, `"img"`) and ideally a `region`. GCP has no unauthenticated pricing API, so it's a curated snapshot of `ai.google.dev/gemini-api/docs/pricing` — refresh `src/data/gcp-ai-pricing.json` when prices change.

### Any Azure / GCP Service (beyond Vantage's instances)

Vantage covers compute/DB *instances*. For everything else — AKS/GKE, Cloud Run, BigQuery, managed databases (PostgreSQL/MySQL/SQL), caches:

| Tool | Description |
|------|-------------|
| `get_azure_price` | **Live**, no key. Any Azure service via `prices.azure.com`. Pass `query` (matches serviceName/productName/meterName) and/or exact `serviceName`, plus `region`/`currency`/`top`. |
| `get_service_price` | **Local**, no key. GCP + AWS services (GKE, Cloud Run, BigQuery, Cloud SQL, Lambda, S3, EKS, DynamoDB) from a bundled Infracost snapshot. Filter by `vendor`/`service`/`query`/`region`; no args lists what's mirrored. |

- **Azure** is live from `prices.azure.com`. Example: `get_azure_price({ query: "PostgreSQL", region: "brazilsouth" })` → `Azure Database for PostgreSQL · vCore · $0.12/hr`.
- **GCP + AWS** (the services Vantage doesn't cover) are bundled from the [Infracost Cloud Pricing API](https://www.infracost.io/docs/supported_resources/cloud_pricing_api/) into `src/data/infracost-pricing.json` — no runtime key. Example: `get_service_price({ vendor: "gcp", service: "Cloud SQL", query: "PostgreSQL", region: "southamerica-east1" })` → `Cloud SQL for PostgreSQL · Regional vCPU · São Paulo · $0.21/hr`.
- Refresh the snapshot: `INFRACOST_API_KEY=ico-... npx tsx scripts/fetch-infracost.ts` (key from `infracost auth login`, read from env only — never committed). Edit the `CONFIG` list in that script to add services/regions. Note: any single service/region is capped at 1000 SKUs by the API.

### Service Category Tools

| Tool | Description |
|------|-------------|
| `list_services_by_category` | **Preferred.** List services in any category: `aiml`, `observability`, `integration`, `security`, `analytics`, `developer`, `media`, `vmware`, `edge`, `governance`, `exadata`, `cache`, `disaster-recovery`, `additional` |
| `get_services_summary` | Summary of all service categories with counts |

> The individual `list_*_services` tools (e.g. `list_aiml_services`, `list_security_services`) still work but are **deprecated** in favor of `list_services_by_category` — prefer passing a `category` to the one tool above.

### Utility Tools

| Tool | Description |
|------|-------------|
| `get_free_tier` | OCI Always Free tier details |
| `get_pricing_info` | Pricing data metadata |

### Real-Time Pricing Tools

| Tool | Description |
|------|-------------|
| `fetch_realtime_pricing` | Fetch live pricing directly from Oracle's API (full product catalog) |
| `list_realtime_categories` | List all service categories from the live API |

## Usage Examples

### Ask Claude about OCI pricing

```
What's the cost of running a VM.Standard.E5.Flex with 4 OCPUs and 32GB RAM?
```

```
Compare OCI block storage tiers for 1TB of data
```

```
Estimate monthly cost for a Kubernetes cluster with 3 nodes
```

```
How much would I save using OCI vs AWS for 5TB of monthly data egress?
```

### Quick Estimates

```
Give me a quick estimate for a small web app on OCI
```

Available presets:
- `small-web-app` - 1 OCPU, 8GB, 100GB storage, LB
- `medium-api-server` - 4 OCPU, 32GB, 500GB storage
- `large-database` - 8 OCPU, 128GB, Autonomous DB
- `ml-training` - 8x A100 GPUs (part-time)
- `kubernetes-cluster` - 3 nodes, 4 OCPU each

### Brazilian pricing (BRL)

Estimate in USD, then convert with tax gross-up:

```
What's the monthly PostgreSQL cost for 1 OCPU / 16 GB, and how much is that in BRL?
```

`convert_usd_brl` applies `BRL = USD × fxRate ÷ taxDivisor`. Defaults are `fxRate=5.23` and `taxDivisor=0.87` (~13% tax gross-up); override per call or via env:

```json
{
  "mcpServers": {
    "oci-pricing": {
      "command": "npx",
      "args": ["-y", "github:klaoslacerdacs/oci-pricing-mcp-br"],
      "env": { "OCI_FX_BRL": "5.23", "OCI_TAX_DIVISOR": "0.87" }
    }
  }
}
```

## OCI Pricing Highlights

### Key Differentiators

- **Consistent Global Pricing**: Unlike AWS/Azure/GCP, OCI prices are the same across all commercial regions
- **10 TB Free Egress**: First 10 TB of outbound data transfer is free monthly
- **Free Kubernetes Control Plane**: OKE Basic clusters have no management fee
- **Network Load Balancer**: Completely free (no hourly or data charges)
- **Always Free Tier**: Never expires - 4 Arm OCPUs, 24GB RAM, 200GB storage, 2 Autonomous DBs

> **This fork's estimator is paid-by-default:** Always Free is applied only to network egress (≤10 TB), public IPs, and VCN — never to compute, storage, databases, load balancers, or other managed services. The Always Free tier above is informational, not subtracted from estimates.

### Cost-Effective Shapes

| Shape | OCPU Price | Best For |
|-------|------------|----------|
| VM.Standard.A1.Flex (Arm) | $0.01/hr | Best value, Arm workloads |
| VM.Standard.E5.Flex | $0.03/hr | New x86 deployments |
| VM.Standard.E4.Flex | $0.025/hr | Previous gen, still good |

### OCPU vs vCPU

1 OCPU = 2 vCPUs for x86 architectures. OCPUs represent physical cores, so OCI's $0.03/OCPU/hr is equivalent to $0.015/vCPU/hr.

## Data Sources

This MCP server supports two data modes:

### Bundled Data (Default)

Pricing data is synced from Oracle's public pricing API and bundled with the server. This provides fast, offline access to the complete OCI pricing catalog.

- **Products**: 640+ SKUs (full API dataset)
- **Categories**: 110+ service categories
- **Detailed compute shapes**: curated shapes with OCPU/memory breakdowns
- **Timestamps**: `apiLastUpdated` and `bundledDataGenerated` for verification (see `get_pricing_info`)

The raw-product snapshot and timestamps are **auto-refreshed monthly** from Oracle's live
API via the [`refresh-data` GitHub Action](.github/workflows/refresh-data.yml) (curated
category structures are preserved). You can also refresh locally with `npm run generate-data`,
or get always-live pricing at call time with the `fetch_realtime_pricing` tool.

### Real-Time API

For the most current pricing between releases, use `fetch_realtime_pricing` which queries Oracle's API directly:

```
https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/
```

- **Authentication**: None required (public API)
- **Multi-currency**: USD, EUR, GBP, JPY, AUD, CAD, and more
- **Updates**: Oracle updates pricing data periodically

## FAQ

### Does OCI have a pricing API?

Yes! Oracle provides a public pricing API at `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/` that returns all OCI product pricing in JSON format. No authentication is required. This MCP server uses this API for the `fetch_realtime_pricing` tool.

### Where does the pricing data come from?

- **Bundled data**: Full dataset synced from Oracle's public pricing API and included in the npm package
- **Real-time data**: Fetched directly from Oracle's public pricing API on-demand

### How often is the bundled data updated?

The bundled pricing data is synced from Oracle's API with each npm release. Check `metadata.bundledDataGenerated` for the sync date. Use `fetch_realtime_pricing` between releases to check for updates.

### Why are prices the same across all regions?

Unlike AWS, Azure, and GCP, Oracle Cloud Infrastructure maintains **consistent global pricing** across all commercial regions. This simplifies cost planning and means you can deploy anywhere without price variations.

### What's the difference between OCPU and vCPU?

1 OCPU = 2 vCPUs for x86 architectures. OCPUs represent physical cores with hyper-threading, so OCI's $0.03/OCPU/hr is equivalent to $0.015/vCPU/hr when comparing to AWS/Azure/GCP.

### Can I query my actual OCI spend?

This MCP server provides pricing data, not account spend. For actual usage and spend tracking, you would need to use the OCI Cost Management APIs with proper authentication. This could be added as a future enhancement.

### What's NOT included in the pricing data?

The bundled data includes the full product set from Oracle's public pricing API. However, some pricing is not available through this API:

- **Committed use discounts** - Only Pay-As-You-Go pricing is shown; annual/3-year commits require Oracle sales
- **Government/sovereign cloud** - Dedicated government regions have separate pricing
- **Oracle SaaS products** - Fusion Apps, NetSuite, etc. are separate from OCI IaaS
- **Custom/negotiated pricing** - Enterprise agreements with volume discounts
- **Support costs** - Premier Support pricing is separate

For these, contact [Oracle Sales](https://www.oracle.com/cloud/contact/) or check the [Oracle Cloud Price List](https://www.oracle.com/cloud/price-list/) directly.

### How do I verify the pricing is accurate?

Each bundled data release includes timestamps:
- `apiLastUpdated`: When Oracle last updated their pricing API
- `bundledDataGenerated`: When this package synced the data

You can verify prices against [Oracle's official price list](https://www.oracle.com/cloud/price-list/) or use the `fetch_realtime_pricing` tool to get live data.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
node dist/index.js

# Watch mode
npm run dev
```

## Credits

Fork maintained by **[klaoslacerdacs](https://github.com/klaoslacerdacs)**.

Based on the original [oci-pricing-mcp](https://github.com/jasonwilbur/oci-pricing-mcp) by **Jason Wilbur** — [jasonwilbur.com](https://jasonwilbur.com).

## License

Apache 2.0 (inherited from upstream).

## Contributing

Issues and pull requests for this fork: [klaoslacerdacs/oci-pricing-mcp-br](https://github.com/klaoslacerdacs/oci-pricing-mcp-br). Upstream fixes are welcome back at the [original repo](https://github.com/jasonwilbur/oci-pricing-mcp).
