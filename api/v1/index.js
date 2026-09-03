/* GET /api/v1 — оглавление.
 *
 * Без него корень отдавал 404 от Vercel, а именно этот адрес идёт в постах и в
 * документации. Человек, пришедший по ссылке, должен видеть список ручек, а не
 * страницу ошибки.
 */
const { DATA, handler } = require("./_lib");

const BASE = "https://voxelithic.xyz/api/v1";

module.exports = handler(
  async () => ({
    name: "Voxelithic API",
    version: "1.0.0",
    chainId: DATA.chainId,
    description:
      "Quotes, routes and fill verification for tokenized equities on Robinhood Chain. " +
      "Prices come from the pools through the on-chain quoter, so every answer here can " +
      "be reproduced with an RPC and nothing else.",
    endpoints: [
      { method: "GET", path: "/health", summary: "Chain head, market phase, contract addresses",
        example: `${BASE}/health` },
      { method: "GET", path: "/tokens", summary: "Canonical token set. A ticker is not an identifier on this chain",
        example: `${BASE}/tokens` },
      { method: "GET", path: "/venues", summary: "Venues the router can execute against",
        example: `${BASE}/venues` },
      { method: "GET", path: "/quote", summary: "Best executable quote across direct pools",
        example: `${BASE}/quote?tokenIn=USDG&tokenOut=SPY&amountIn=10` },
      { method: "POST", path: "/swap", summary: "Unsigned transaction for a route from /quote",
        body: { tokenIn: "USDG", tokenOut: "SPY", amountIn: "10", minOut: "from the quote",
                route: "the route array from /quote, unchanged" } },
      { method: "GET", path: "/verify", summary: "What a transaction actually did, read from its receipt",
        example: `${BASE}/verify?tx=0x46fb26583f88e16ea546457d24880637f490c54a61a9438068dec3b947970fe4` },
      { method: "GET", path: "/openapi.json", summary: "Machine readable spec and the service level",
        example: `${BASE}/openapi.json` },
    ],
    keys:
      "None required, and none accepted. /swap returns unsigned calldata: signing and " +
      "broadcasting are yours, and this API cannot do either.",
    limits: { requestsPerMinute: 120, per: "address" },
    contracts: DATA.contracts,
    links: {
      spec: `${BASE}/openapi.json`,
      docs: "https://voxelithic.xyz/docs#sdk",
      package: "https://www.npmjs.com/package/voxelithic-interfaces",
      source: "https://github.com/Voxelithicag",
    },
  }),
  { cacheSeconds: 3600 }
);
