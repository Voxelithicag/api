/* GET /api/v1/openapi.json — машинная спецификация.
 *
 * Отдаётся функцией, а не файлом: адреса контрактов и набор токенов берутся из
 * той же таблицы, что и остальные ручки, и не могут разойтись со спекой.
 */
const { DATA, handler } = require("./_lib");

const SLA = `
Availability is best effort. There is no uptime guarantee, and there will not be
one until the endpoint has run long enough for a number to mean something.

Rate limit: 120 requests per minute per address, returned as HTTP 429 with a
retry-after header. The limit is enforced per serverless instance, so in
practice it is a floor rather than a ceiling.

Caching: quotes and health are cached for 5 seconds at the edge, verify for 30,
tokens and venues for an hour. A quote older than a few seconds should be
re-fetched rather than trusted.

Breaking changes get a new path. /api/v1 keeps its shapes; anything
incompatible becomes /api/v2.

Incidents are posted at x.com/Voxelithicag. There is no status page and no
support queue: issues at github.com/Voxelithicag are the way through.
`.trim();

const spec = () => ({
  openapi: "3.1.0",
  info: {
    title: "Voxelithic API",
    version: "1.0.0",
    summary: "Quotes, routes and fill verification for tokenized equities on Robinhood Chain.",
    description:
      "Prices are produced by the pools themselves through the on-chain quoter, not by " +
      "an off-chain pricing engine, so any answer here can be reproduced with an RPC " +
      "and nothing else.\n\n" +
      "The API holds no keys and cannot sign or broadcast. /swap returns an unsigned " +
      "transaction; the caller signs it.\n\n## Service level\n\n" + SLA,
    license: { name: "MIT", url: "https://github.com/Voxelithicag/contracts" },
  },
  servers: [{ url: "https://voxelithic.xyz/api/v1", description: "production" }],
  tags: [
    { name: "reference", description: "Static facts about the chain and the router" },
    { name: "trading", description: "Quoting and transaction building" },
    { name: "treasury", description: "Buyback and burn: where the 0.30% swap fee goes" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["reference"], operationId: "getHealth",
        summary: "Chain head, market phase and contract addresses",
        responses: { 200: { description: "ok" }, 429: { description: "rate limited" } },
      },
    },
    "/tokens": {
      get: {
        tags: ["reference"], operationId: "listTokens",
        summary: "Canonical token set",
        description:
          "A ticker is not an identifier on this chain: other contracts answer to the " +
          "same symbol. These addresses come from the router's own configuration.",
        parameters: [
          { name: "symbol", in: "query", required: false, schema: { type: "string" },
            description: "Return a single token instead of the whole set" },
        ],
        responses: { 200: { description: "ok" } },
      },
    },
    "/venues": {
      get: {
        tags: ["reference"], operationId: "listVenues",
        summary: "Venues the router can execute against",
        responses: { 200: { description: "ok" } },
      },
    },
    "/quote": {
      get: {
        tags: ["trading"], operationId: "getQuote",
        summary: "Best executable quote, direct or through a bridge",
        description:
          "Every candidate pool is asked through the on-chain quoter. A pool that " +
          "cannot take the whole size is excluded rather than estimated.\n\n" +
          "Most equity pairs have no pool of their own: of 105 combinations only " +
          "eleven do. The rest are reached in two hops through USDG, SPY or WETH, " +
          "and the route array then carries both. A bridged route is only preferred " +
          "when it beats the direct one by more than ten basis points, because the " +
          "second hop is a second fee and a second pool that can run out. Both hops " +
          "belong to one family: v3 and v4 are executed by different contracts and " +
          "cannot be mixed inside a route.",
        parameters: [
          { name: "tokenIn", in: "query", required: true, schema: { type: "string" },
            description: "Symbol from /tokens, or a 20 byte address" },
          { name: "tokenOut", in: "query", required: true, schema: { type: "string" } },
          { name: "amountIn", in: "query", required: true, schema: { type: "string" },
            description: "Human units, for example 10 or 10.5" },
          { name: "slippageBps", in: "query", required: false,
            schema: { type: "integer", minimum: 0, maximum: 5000, default: 100 } },
        ],
        responses: {
          200: {
            description:
              "When the size presses on the price, the quote also carries a split: the " +
              "order divided across pools of both families, with the legs and the gain " +
              "in basis points over the single best route. Pass legsV3 and legsV4 to " +
              "/swap unchanged to execute it; it runs on a separate contract, because " +
              "the ordinary router takes one route at a time.\n\n" +
              "A quote, or quote:null when no pool could fill the size. The quote carries " +
              "priceImpactBps, which is what the size itself costs along the route it would " +
              "execute against, measured against that same route at a small reference size. " +
              "Above 100 bps the response also carries a warning field. A caller without " +
              "an independent price should check that number before signing: the quote is " +
              "honest, but on a large order it reflects the depth it consumed rather than " +
              "the market rate.",
          },
          400: { description: "bad parameters" },
          429: { description: "rate limited" },
          503: {
            description:
              "the quoter could not be read; the request was valid, retry. Returned " +
              "rather than an empty quote whenever no pool answered on either the " +
              "direct or the bridged path: silence from the node is not a fact about " +
              "the market.",
          },
        },
      },
    },
    "/swap": {
      post: {
        tags: ["trading"], operationId: "buildSwap",
        summary: "Unsigned transaction for a route",
        description:
          "Returns calldata. The API has no keys: signing and broadcasting are yours. " +
          "minOut is required and is never defaulted, because that number is the " +
          "caller's protection and not ours to choose.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tokenIn", "tokenOut", "amountIn", "minOut"],
                properties: {
                  tokenIn: { type: "string" },
                  tokenOut: { type: "string" },
                  amountIn: { type: "string" },
                  minOut: { type: "string" },
                  route: { type: "array", description: "The route array from /quote, unchanged" },
                  legsV3: {
                    type: "array",
                    description:
                      "Split execution: the legsV3 array from the quote's split field, " +
                      "unchanged. Send it together with legsV4 instead of route.",
                  },
                  legsV4: { type: "array", description: "Split execution: the legsV4 array, unchanged" },
                  deadlineSeconds: { type: "integer", minimum: 15, maximum: 3600, default: 300 },
                },
              },
            },
          },
        },
        responses: { 200: { description: "unsigned transaction" }, 400: { description: "bad body" } },
      },
    },
    "/verify": {
      get: {
        tags: ["trading"], operationId: "verifyFill",
        summary: "What a transaction actually did",
        description:
          "Reads the receipt and the RouteExecuted log from the chain. Note that chain " +
          "state is pruned after roughly ten minutes, so the reason a revert happened " +
          "can only be recovered while it is fresh. Successful fills stay readable.",
        parameters: [
          { name: "tx", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { 200: { description: "ok" }, 400: { description: "bad hash" } },
      },
    },
    "/receipt": {
      get: {
        tags: ["trading"], operationId: "fillReceipt",
        summary: "What a fill paid, against what every venue would have paid",
        description:
          "Takes a settled swap and re-quotes every pool for the same pair and size at the " +
          "block BEFORE the fill, so the order's own footprint is not in the comparison. " +
          "Returns the whole board, losers included, and says plainly when the route taken " +
          "was not the best one available. Nothing is stored: the numbers are recomputed " +
          "from chain state on every request, so any archive node reproduces them.",
        parameters: [
          { name: "tx", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { 200: { description: "ok" }, 400: { description: "bad hash" } },
      },
    },
    "/burn": {
      get: {
        tags: ["treasury"], operationId: "burnStats",
        summary: "How much $VOXEL the treasury has bought and burned",
        description:
          "The router takes 0.30% of every swap inside the trade and sends it to the treasury. " +
          "The treasury can only buy $VOXEL with what it holds and send that to the burn address; " +
          "it has no withdraw function, for anyone. totalBurned is the treasury's own counter and " +
          "only goes up. sinkBalance is larger because the burn address also holds VOXEL burned by " +
          "other contracts. The dollar figure is priced at spot on a small size, not at what the " +
          "whole burned amount would fetch at once, which is why the field is named usdAtSpot. " +
          "pending is what has already accrued and is waiting for the next burn.",
        responses: { "200": { description: "Burn totals and the queue" } },
      },
    },
  },
  "x-contracts": DATA.contracts,
  "x-chainId": DATA.chainId,
});

module.exports = handler(async () => spec(), { cacheSeconds: 3600 });
