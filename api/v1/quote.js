/* GET /api/v1/quote — сколько дадут за указанный вход.
 *
 *   /api/v1/quote?tokenIn=USDG&tokenOut=SPY&amountIn=10
 *
 * Цену считают сами пулы: запрос уходит в VoxQuoter и VoxQuoterV4 одним
 * батчем, а не в формулу и не в индексатор. Пул, который не смог принять весь
 * объём, возвращает paid != amountIn и в сравнение не попадает — этим же
 * отсекается мёртвая ликвидность, без обращения к внешним источникам.
 */
const { DATA, quoteBest, resolveToken, handler, bad } = require("./_lib");

/** Человеческую сумму в сырые единицы, без потери точности на float. */
function toRaw(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw bad("amountIn must be a positive decimal number");
  const [int, frac = ""] = s.split(".");
  if (frac.length > decimals) throw bad(`amountIn has more than ${decimals} decimals`);
  return BigInt(int + frac.padEnd(decimals, "0"));
}

const fromRaw = (raw, decimals) => {
  const s = raw.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals) || "0";
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
};

module.exports = handler(
  async (req) => {
    const q = req.query || {};
    const tin = resolveToken(q.tokenIn);
    const tout = resolveToken(q.tokenOut);

    if (!tin) throw bad("unknown tokenIn; pass a symbol from /api/v1/tokens or an address");
    if (!tout) throw bad("unknown tokenOut; pass a symbol from /api/v1/tokens or an address");
    if (tin.decimals == null || tout.decimals == null) {
      throw bad("that address is not in the canonical set, so its decimals are unknown");
    }
    if (tin.address.toLowerCase() === tout.address.toLowerCase()) {
      throw bad("tokenIn and tokenOut are the same token");
    }
    if (q.amountIn == null) throw bad("amountIn is required");

    const slippageBps = q.slippageBps == null ? 100 : Number(q.slippageBps);
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) {
      throw bad("slippageBps must be an integer between 0 and 5000");
    }

    const amountIn = toRaw(q.amountIn, tin.decimals);
    if (amountIn <= 0n) throw bad("amountIn must be greater than zero");

    const { best, all, considered, answered, priceImpactBps, split } = await quoteBest({
      tokenIn: tin.address,
      tokenOut: tout.address,
      amountIn,
      slippageBps,
    });

    if (!best) {
      return {
        chainId: DATA.chainId,
        tokenIn: tin,
        tokenOut: tout,
        amountIn: q.amountIn,
        poolsConsidered: considered,
        poolsThatAnswered: answered,
        quote: null,
        /* Мост тоже искали, поэтому «нет прямого пула» больше не причина.
           Разводим два разных факта: спросили и получили отказ рынка — или
           спрашивать было некого. */
        reason: considered
          ? "no route could fill the whole amount at this size, direct or bridged"
          : "no pool holds this pair, and no bridge connects it",
      };
    }

    return {
      chainId: DATA.chainId,
      tokenIn: tin,
      tokenOut: tout,
      amountIn: q.amountIn,
      amountInRaw: amountIn,
      poolsConsidered: considered,
      /* Сколько пулов реально ответило. Меньше рассмотренных — значит часть
         групп не дошла, и лучшая цена могла остаться неопрошенной. */
      poolsThatAnswered: answered,
      poolsThatCouldFill: all.length,
      quote: {
        amountOut: fromRaw(best.out, tout.decimals),
        amountOutRaw: best.out,
        minOut: fromRaw(best.minOut, tout.decimals),
        minOutRaw: best.minOut,
        slippageBps,
        /* Стоимость самого размера, а не разброс между площадками. Считается по
           тому же пулу: цена за единицу на маленьком опорном объёме против
           цены на запрошенном. Отдаём всегда, потому что вызывающий, у которого
           нет справочной цены, иначе не отличит нормальную сделку от той, что
           съедает пул. */
        priceImpactBps,
        /* Комиссия роутера уже вычтена из amountOut: она снимается с выходного
           токена ДО проверки minOut, поэтому котировка без неё дала бы реверт
           у всех, кто взял minOut отсюда. Отдаём и саму ставку, чтобы её было
           видно, а не приходилось выводить из разницы. */
        routerFeeBps: best.feeBps,
        family: best.family,
        /* У маршрута через мост площадок две; отдаём обе, а одиночное поле
           оставляем только когда хоп действительно один — иначе клиент
           показал бы половину маршрута как весь. */
        ...(best.hops.length === 1
          ? { pool: best.pool || best.poolId }
          : { pools: best.hops.map((h) => h.pool || h.key) }),
        /* Прямой маршрут — один хоп, через мост — два. Пары бумага-бумага
           почти никогда не имеют своего пула и достаются через доллар, SPY
           или эфир; семья при этом одна на весь маршрут, потому что v3 и v4
           исполняются разными контрактами. */
        hops: best.hops.length,
        ...(best.bridge ? { bridge: best.bridge } : {}),
        // Тот же массив уходит в /api/v1/swap: маршрут не нужно собирать заново.
        route: best.hops,
      },
      /* Разделение ордера по нескольким пулам. Появляется только когда размер
         действительно давит на цену и когда раскладка ощутимо лучше одиночного
         маршрута — лишняя нога стоит газа. Исполняется отдельным контрактом:
         обычный роутер многоногий вызов не примет. */
      ...(split
        ? {
            split: {
              router: DATA.contracts.routerSplit,
              amountOut: fromRaw(split.out, tout.decimals),
              amountOutRaw: split.out,
              minOut: fromRaw(split.minOut, tout.decimals),
              minOutRaw: split.minOut,
              routerFeeBps: split.feeBps,
              betterByBps: split.gainBps,
              legs: split.legsV3.length + split.legsV4.length,
              legsV3: split.legsV3,
              legsV4: split.legsV4,
            },
          }
        : {}),
      ...(priceImpactBps != null && priceImpactBps >= 100
        ? {
            warning:
              `This size moves the price by ${(priceImpactBps / 100).toFixed(2)} percent ` +
              `along the route it would execute against. The quote is real and the router will ` +
              `honour it, but the number is a consequence of the size and not the market rate. ` +
              `Split the order or reduce it if that was not intended.`,
          }
        : {}),
      note:
        "Prices come from the pools themselves via the on-chain quoter. " +
        "Pools that could not take the full size are excluded, not estimated.",
    };
  },
  { cacheSeconds: 5 }
);
