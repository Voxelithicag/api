/* GET /api/v1/receipt?tx=0x... — чек об исполнении.
 *
 * Отличие от /verify: тот отвечает «что случилось», этот — «что могло случиться
 * вместо этого». Берётся филл из квитанции чейна, а затем состояние КАЖДОГО
 * пула пересчитывается на блоке ПЕРЕД сделкой, и полученное сравнивается с тем,
 * что дала бы каждая площадка на тот же размер в тот же момент.
 *
 * Ничего не хранится. Все числа выводятся из состояния чейна заново на каждый
 * запрос, поэтому их повторит любой с архивным узлом — включая того, кто нам не
 * верит. Если маршрут оказался не лучшим, это видно здесь же: доска отдаётся
 * целиком, вместе с проигравшими и вместе с победителем, кем бы он ни был.
 *
 * Оговорка про блок: сравнение идёт с состоянием ДО сделки. Собственный след
 * ордера в пулах в доску не попадает — иначе исполненный маршрут сравнивался бы
 * сам с собой уже сдвинутым.
 */
const { DATA, rpc, quoteAllAt, resolveToken, handler, bad } = require("./_lib");

/* RouteExecuted(address,address,address,uint256,uint256,uint8) */
const TOPIC = "0x6734dd1734fa4940753523aef07f22cb97def958affac167b5005432415b8196";

const word = (b, i) => "0x" + b.slice(i * 64, (i + 1) * 64);
const num = (b, i) => BigInt(word(b, i));
const addrAt = (t) => "0x" + t.slice(26);

/** Сырые единицы в человеческие, без float. */
function fromRaw(raw, decimals) {
  if (decimals == null) return null;
  const s = raw.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals) || "0";
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}

/** Разница в базисных пунктах: насколько a лучше b. */
const bpsOver = (a, b) => (b > 0n ? Number(((a - b) * 10_000n) / b) : null);

module.exports = handler(
  async (req) => {
    const tx = String(req.query?.tx || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw bad("tx must be a 32 byte hash");

    const receipt = await rpc("eth_getTransactionReceipt", [tx]);
    if (!receipt) {
      return { tx, found: false, note: "no receipt yet; the transaction may still be pending" };
    }

    const routers = {
      [DATA.contracts.router.toLowerCase()]: "v3",
      [DATA.contracts.routerV4.toLowerCase()]: "v4",
      [DATA.contracts.routerSplit.toLowerCase()]: "split",
    };
    const to = (receipt.to || "").toLowerCase();
    const succeeded = receipt.status === "0x1";

    /* Признак «наша сделка» — эмитент события, а не адрес получателя
       транзакции. Роутер часто вызывают не напрямую, а из чужого контракта:
       тогда receipt.to — этот контракт, и проверка по нему объявляла бы
       собственный исполненный маршрут чужим. Подделать лог нельзя: адрес в
       нём проставляет сама EVM, и никто, кроме роутера, его не поставит. */
    const log = (receipt.logs || []).find(
      (l) => (l.topics || [])[0] === TOPIC && routers[(l.address || "").toLowerCase()]
    );

    if (!log) {
      if (!routers[to]) {
        return {
          tx, found: true, ours: false, status: succeeded ? "success" : "reverted", to: receipt.to,
          note: "no Voxelithic router settled anything in this transaction, so there is nothing to compare it against",
        };
      }
      return {
        tx, found: true, ours: true, filled: false,
        status: succeeded ? "success" : "reverted",
        blockNumber: parseInt(receipt.blockNumber, 16),
        note: succeeded
          ? "went to the router but emitted no RouteExecuted, so nothing settled"
          : "the router reverted, so nothing settled and the input stayed with the sender",
      };
    }

    /* Вызов пришёл через посредника: наружу это стоит показать, потому что
       отправитель в событии — тот контракт, а не человек за ним. */
    const via = routers[to] ? null : receipt.to;

    const b = log.data.slice(2);
    const tokenIn = addrAt(log.topics[2]);
    const tokenOut = addrAt(log.topics[3]);
    const amountIn = num(b, 0);
    const amountOut = num(b, 1);
    const hops = Number(num(b, 2));
    const blockNumber = parseInt(receipt.blockNumber, 16);

    const tin = resolveToken(tokenIn);
    const tout = resolveToken(tokenOut);
    if (!tin || !tout || tin.decimals == null || tout.decimals == null) {
      return {
        tx, found: true, ours: true, filled: true, blockNumber,
        note: "this fill used a token outside the canonical set, so its decimals are unknown and the board cannot be priced",
      };
    }

    /* Блок ПЕРЕД сделкой: состояние, которое видел маршрутизатор, когда
       выбирал. На блоке самой сделки пулы уже сдвинуты этим же ордером. */
    const quotedAtBlock = blockNumber - 1;
    const board = await quoteAllAt({
      tokenIn, tokenOut, amountIn,
      blockTag: "0x" + quotedAtBlock.toString(16),
    });

    const rows = board.rows.map((r, i) => ({
      rank: i + 1,
      family: r.family,
      hops: r.hops,
      ...(r.bridge ? { bridge: r.bridge } : {}),
      ...(r.hops === 1 ? { pool: r.pool } : { pools: r.pools }),
      ...(r.feePpm != null ? { poolFeePpm: r.feePpm } : {}),
      amountOut: fromRaw(r.out, tout.decimals),
      amountOutRaw: r.out,
      grossAmountOutRaw: r.grossOut,
      /* Насколько эта площадка отстала от того, что человек получил на самом
         деле. Отрицательное значение означает, что она дала бы больше. */
      youGainedBps: bpsOver(amountOut, r.out),
    }));

    const top = board.rows[0] || null;
    const second = board.rows[1] || null;

    let verdict;
    if (!top) {
      verdict = {
        best: null,
        text:
          "No pool could be re-quoted for this pair and size at that block, so there is " +
          "nothing to compare this fill against. That is a gap in the board, not a claim about the fill.",
      };
    } else if (amountOut >= top.out) {
      verdict = {
        best: true,
        aheadOfNextBps: second ? bpsOver(amountOut, second.out) : null,
        text: second
          ? "This fill paid at least as much as every venue that could take the size, and beat the next best one."
          : "This fill paid at least as much as the only venue that could take the size.",
      };
    } else {
      verdict = {
        best: false,
        shortByBps: bpsOver(top.out, amountOut),
        betterRoute: rows[0],
        text:
          "This fill was not the best available at that block. The route above would have paid more. " +
          "We publish it rather than wait for you to find it.",
      };
    }

    return {
      tx,
      chainId: DATA.chainId,
      found: true,
      ours: true,
      filled: true,
      status: "success",
      router: log.address,
      ...(via ? { via } : {}),
      routerKind: routers[(log.address || "").toLowerCase()],
      blockNumber,
      quotedAtBlock,
      gasUsed: parseInt(receipt.gasUsed, 16),
      fill: {
        sender: addrAt(log.topics[1]),
        tokenIn: { symbol: tin.symbol, address: tin.address, decimals: tin.decimals },
        tokenOut: { symbol: tout.symbol, address: tout.address, decimals: tout.decimals },
        amountIn: fromRaw(amountIn, tin.decimals),
        amountInRaw: amountIn,
        amountOut: fromRaw(amountOut, tout.decimals),
        amountOutRaw: amountOut,
        hops,
      },
      routerFeeBps: board.feeBps ? board.feeBps[routers[(log.address || "").toLowerCase()]] : null,
      poolsConsidered: board.considered,
      poolsThatAnswered: board.answered,
      poolsThatCouldFill: rows.length,
      alternatives: rows,
      verdict,
      note:
        "Every number here is recomputed from chain state at block " + quotedAtBlock +
        ", the block before the fill. Nothing is stored on our side, so an archive node " +
        "reproduces this page exactly. Amounts are net of the router fee on both sides, " +
        "so the comparison is like for like.",
    };
  },
  { cacheSeconds: 300 }
);
