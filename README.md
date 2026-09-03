# Voxelithic API

Public HTTP API for Voxelithic on Robinhood Chain (4663). Quotes, routes,
unsigned transactions and fill verification.

Live at **[voxelithic.xyz/api/v1](https://voxelithic.xyz/api/v1)**. No key, no
signup.

```bash
curl 'https://voxelithic.xyz/api/v1/quote?tokenIn=USDG&tokenOut=SPY&amountIn=10'
```

## Endpoints

| | | |
|---|---|---|
| `GET` | `/health` | Chain head, market phase, contract addresses |
| `GET` | `/tokens` | Canonical token set |
| `GET` | `/venues` | Venues the router can execute against |
| `GET` | `/quote` | Best executable quote across direct pools |
| `POST` | `/swap` | Unsigned transaction for a route |
| `GET` | `/verify` | What a transaction actually did |
| `GET` | `/openapi.json` | Machine readable spec and the service level |

## Three decisions worth knowing

**No indexer.** The pool universe comes from the router's own configuration, and
the filtering is done by the quoter itself: a pool that cannot take the whole
size returns `paid != amountIn` and drops out. That removes dead liquidity
without asking anyone else for numbers, and removes a dependency that can fail
at the worst moment.

**No keys.** `/swap` returns calldata. Signing and broadcasting are the
caller's, and this service cannot do either. `minOut` is required and never
defaulted, because that number is the caller's protection and not ours to pick.

**Prices come from the pools.** Every candidate is asked through the on-chain
quoter rather than modelled, so any answer here can be reproduced with an RPC
and nothing else.

**Every quote carries `priceImpactBps`.** A human notices an absurd number; an
agent does not, because it has no independent price and will compute `minOut`
from whatever it was handed. So the response states what the size itself costs
in the pool it would execute against, measured against that same pool at a small
reference size, and adds a `warning` above one percent. The quote is honest
either way — the number just stops being the market rate once the order is large
enough to eat the depth.

Pools are queried in groups of three rather than all at once: a quote is a real
swap simulation inside `eth_call`, and seven pools at half a million dollars
exceeds what the node will compute in one call, while the same size through one
pool is trivial. The limit is the weight of the call, not the size of the trade.

## Layout

```
api/v1/
  index.js      directory of endpoints
  health.js     tokens.js    venues.js
  quote.js      swap.js      verify.js
  openapi.js    spec, generated from the same table the handlers use
  _lib.js       encoders, RPC, rate limiting, response shape
  _data.json    generated; never edited by hand
scripts/
  build_api_data.py
```

Files prefixed with `_` are not routes: the platform excludes them.

## Regenerating the data

`_data.json` is derived from the router's configuration, so the API cannot
drift from what the router actually trades:

```bash
python3 scripts/build_api_data.py
```

## A note on the encoders

`_lib.js` duplicates the calldata encoders from the browser application. The
duplication is deliberate — one side is an ES module, the other is CommonJS,
and wiring a bundler for six functions costs more than a copy carrying this
note. Both are checked byte for byte against each other, and the originals are
verified against `cast`. **If you change one, change both.**

## For agents

The same endpoints arrive as MCP tools through
[voxelithic-mcp](https://www.npmjs.com/package/voxelithic-mcp), which is a thin
client over this API and holds no keys either:

```json
{ "mcpServers": { "voxelithic": { "command": "npx", "args": ["-y", "voxelithic-mcp"] } } }
```

## Service level

In the [spec](https://voxelithic.xyz/api/v1/openapi.json), stated plainly:
availability is best effort with no uptime guarantee, 120 requests per minute
per address, quotes cached five seconds, breaking changes go to `/api/v2`.

## License

MIT
