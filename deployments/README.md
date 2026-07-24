# Deployment descriptors

A deployment descriptor is the **runtime source of truth** for one
published Frontier Commerce instance: package/registry IDs, coin types,
and (under `evidence`) the merchant/cap/product IDs the deploy run
created. Apps, the gas station, the indexer and the observability
collector all load it at runtime — **never hard-code IDs in app code**,
because testnet packages rotate and coin types (EVE especially) rotate
between cycles.

This public repo deliberately contains **no live descriptor** — only
[`example.testnet.json`](example.testnet.json), a shape reference with
placeholder values. Your real `testnet.json` is **generated** by the
deploy flow:

```bash
cp examples/demo-consumer/deploy.config.example.json examples/demo-consumer/deploy.config.json
# edit deploy.config.json: your merchant name, products, CURRENT-cycle coin type
DEPLOYER_ADDRESS=0x... node --experimental-strip-types examples/demo-consumer/src/deploy-testnet.ts
# -> writes deployments/testnet.json for YOUR sovereign deployment
```

Everything in a descriptor is public on-chain data. Object IDs are not
secrets — capability *objects* (owned by your addresses) are the
authority, and possession of an ID grants nothing. Whether you commit
your real descriptor to your own (public or private) repo is your call;
the authors keep theirs in a private operations repo.

There is deliberately **no `mainnet.json`** and the SDK refuses one —
see the mainnet promotion checklist in
[docs/security-model.md](../docs/security-model.md).
