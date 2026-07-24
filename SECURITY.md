# Security policy

## Status

Frontier Commerce is **testnet-proven, pre-mainnet infrastructure**. It has
had internal adversarial review (see `docs/decision-log.md` for the
findings and their remediation) but **no external security audit**. Nothing is deployed to mainnet, and the SDK
deliberately refuses mainnet deployment descriptors until the promotion
checklist in [docs/security-model.md](docs/security-model.md) is executed.

Do not put funds you cannot afford to lose behind this code, on any network.

## Supported versions

The `main` branch only. There are no maintained release lines yet; breaking
changes may land at any time pre-mainnet.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting: go to the repository's
**Security** tab → **Report a vulnerability**. That opens a private advisory
visible only to you and the maintainer.

What to include: the affected component (Move package, SDK, gas station,
indexer), a description of the impact (e.g. funds movement, entitlement
forgery, sponsor drain, authority bypass), and reproduction steps or a
proof-of-concept against **localnet** (`sui start --force-regenesis`) —
please do not demonstrate exploits against other people's live deployments.

You can expect an acknowledgement within a few days. This is a solo-operated
open-source project: there is no bug-bounty programme and no SLA, but real
findings will be taken seriously, fixed, and credited if you want credit.

## Scope notes

- The threat model and authority matrix live in
  [docs/security-model.md](docs/security-model.md); key custody and
  rotation runbooks in [docs/key-management.md](docs/key-management.md).
- The security model assumes the code is public. Capability objects,
  on-chain checks, rate limits and budget caps are the boundaries — not
  secrecy of the source or of object IDs.
- Deployment descriptors in `deployments/` contain only public on-chain
  data (package/object IDs, addresses, digests). Possession of an ID grants
  no authority.
