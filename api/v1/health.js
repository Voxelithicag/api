/* GET /api/v1/health — жив ли чейн и в какой фазе рынок. */
const { DATA, rpc, handler } = require("./_lib");

/* Эквити на этом чейне торгуются круглосуточно, но оракулы стоят вне сессии.
   Фаза нужна вызывающему, чтобы понимать, насколько свежа цена под котировкой. */
function marketPhase(d = new Date()) {
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return "weekend";
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960 ? "open" : "after-hours";
}

module.exports = handler(
  async () => {
    const started = Date.now();
    const block = await rpc("eth_blockNumber");
    return {
      ok: true,
      chainId: DATA.chainId,
      blockNumber: parseInt(block, 16),
      marketPhase: marketPhase(),
      rpcLatencyMs: Date.now() - started,
      contracts: DATA.contracts,
    };
  },
  { cacheSeconds: 5 }
);
