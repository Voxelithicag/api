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
        summary: "Best executable quote across direct pools",
        description:
          "Every candidate pool is asked through the on-chain quoter. A pool that " +
          "cannot take the whole size is excluded rather than estimated.",
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
              "A quote, or quote:null when no pool could fill the size. The quote carries " +
              "priceImpactBps, which is what the size itself costs in the pool it would " +
              "execute against, measured against the same pool at a small reference size. " +
              "Above 100 bps the response also carries a warning field. A caller without " +
              "an independent price should check that number before signing: the quote is " +
              "honest, but on a large order it reflects the depth it consumed rather than " +
              "the market rate.",
          },
          400: { description: "bad parameters" },
          429: { description: "rate limited" },
          503: { description: "the quoter could not be read; the request was valid, retry" },
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
                required: ["tokenIn", "tokenOut", "amountIn", "minOut", "route"],
                properties: {
                  tokenIn: { type: "string" },
                  tokenOut: { type: "string" },
                  amountIn: { type: "string" },
                  minOut: { type: "string" },
                  route: { type: "array", description: "The route array from /quote, unchanged" },
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
  },
  "x-contracts": DATA.contracts,
  "x-chainId": DATA.chainId,
});

module.exports = handler(async () => spec(), { cacheSeconds: 3600 });
