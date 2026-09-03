/* GET /api/v1/tokens — канонический набор токенов.

   Тикер на этом чейне не идентификатор: его носят и чужие контракты. Список
   собран из конфигурации роутера, то есть из того же источника, которым он
   торгует, и разойтись с ней не может. */
const { DATA, handler } = require("./_lib");

module.exports = handler(
  async (req) => {
    const sym = req.query?.symbol;
    const list = Object.values(DATA.tokens);
    if (sym) {
      const one = DATA.tokens[DATA.bySymbolLower[String(sym).toLowerCase()]];
      return { chainId: DATA.chainId, count: one ? 1 : 0, tokens: one ? [one] : [] };
    }
    return { chainId: DATA.chainId, count: list.length, tokens: list };
  },
  { cacheSeconds: 3600 }
);
