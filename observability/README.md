# Observability: the Frontier Commerce Operator dashboard

Optional but strongly recommended once real users pay you: a Grafana
dashboard + read-only collector that make a deployment operationally
legible without reading chain explorers. Battle-tested shape: this is the
generalised version of the dashboard the authors run for EF-Map
Intelligence on testnet.

It answers, at a glance:

- Is commerce healthy? Is intake paused anywhere (registry/merchant)?
- What package/registry/merchant/products is production actually using?
- What payments happened, from which wallet, was gas sponsored?
- What entitlement was granted, is it active, when does it expire?
- What is in the merchant treasury, and does **indexed accounting
  reconcile with on-chain state** (the load-bearing trust check)?
- Is the indexer fresh? Is the gas sponsor alive, funded, within budget?
- Are sponsorships being approved / rejected / failing?
- "User paid but is still locked" — a step-by-step support playbook panel.

## Truth layers (the design idea)

The dashboard deliberately keeps three layers apart so disagreement is
visible instead of hidden:

| Layer | Source | Tables |
|---|---|---|
| **Indexed truth** | `@frontier-commerce/indexer` event ledger (SQLite), mirrored to Postgres | `raw_events`, `payments`, `entitlement_*`, `refunds` |
| **On-chain truth** | sampled reads via gRPC (`treasury_value`, pause flags, product records) | `treasury_recon`, `chain_status`, `product_status` |
| **Runtime health** | gas station `/health`, collector self-reporting | `sponsor_health`, `poller_status`, `collector_runs` |

If indexed and on-chain treasury disagree, the **Treasury reconciliation**
stat goes MISMATCH — distrust the ledger, check the chain directly.

## Pieces

```
observability/
  collector/            @frontier-commerce/obs-collector - one Node loop, read-only:
                        indexer pollOnce -> SQLite -> Postgres mirror; sponsor /health
                        snapshots; per-tx gas-payer enrichment; 10-min treasury recon
  grafana/
    frontier-commerce-operator.json          the dashboard (56 panels)
    provisioning/datasources/…               Postgres datasource (uid commerce-postgres)
    provisioning/dashboards/…                file provider
  docker-compose.example.yml                 Postgres + Grafana + collector, self-contained
```

## What you must configure

1. **A deployment descriptor** — the collector reads merchant + products
   from `evidence.merchant` (the shape `deploy-testnet.ts` writes), or set
   `MERCHANT_ID` explicitly.
2. **Postgres** — any instance. Env: `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`
   (+ optional `PG_SCHEMA`, default `frontier_commerce`). The collector
   creates its schema/tables/views itself.
3. **Grafana** — provision the datasource with uid `commerce-postgres`
   (or repoint the dashboard) and file-provision the dashboard JSON.
4. Dashboard variables (top of the dashboard): `network` (explorer links),
   `currency` / `currency_smoke` (coin-type suffixes for revenue vs
   smoke-validation panels), `wallet` / `digest` (support lookups).
5. Optional: `SPONSOR_HEALTH_URL` → your gas station's private `/health`.
   Unset = sponsor panels stay empty; everything else works.

Quick start (self-contained example stack):

```bash
PGPASSWORD=choose-one GRAFANA_ADMIN_PASSWORD=choose-one \
  docker compose -f observability/docker-compose.example.yml up -d
# Grafana on http://127.0.0.1:3000 -> folder "Frontier Commerce"
```

## Fitting it into an existing stack

Every piece is replaceable: point the collector at your existing Postgres
(set `PG_SCHEMA` to avoid collisions), import the dashboard JSON into your
existing Grafana and repoint its datasource uid, or ignore the collector
entirely and adapt the schema/views (all in `collector.mjs`) to your own
indexer — the views are the contract the dashboard depends on.

The collector's SQLite ledger is a full, canonical indexer ledger — but if
you already run `@frontier-commerce/indexer` elsewhere, this one is just
an optional projection: re-polling is idempotent and a fresh ledger
rebuilds from the deployment's genesis.

## Security posture

Read-only by construction: no keys, no signing, no chain mutations. The
only credential is the Postgres password. Reach the gas station's
`/health` privately (docker network / localhost) — never expose Grafana or
Postgres to the internet without auth in front.
