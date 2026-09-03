/* GET /api/v1/verify?tx=0x... — что на самом деле сделала транзакция.
 *
 * Читается квитанция из чейна, а не наши записи: событие RouteExecuted несёт
 * вход, выход и число хопов, и сверяется с тем, что транзакция вообще ушла в
 * наш роутер. Ответ «прошло» здесь означает состояние чейна, а не наше слово.
 *
 * Оговорка про откаты: состояние на этом чейне подрезается примерно за десять
 * минут, поэтому причину падения свежей транзакции узнать можно, а старой —
 * уже нет. Для успешных филлов ограничения нет: событие остаётся в логе.
 */
const { DATA, rpc, handler, bad } = require("./_lib");

/* RouteExecuted(address,address,address,uint256,uint256,uint8) */
const TOPIC = "0x6734dd1734fa4940753523aef07f22cb97def958affac167b5005432415b8196";

const word = (b, i) => "0x" + b.slice(i * 64, (i + 1) * 64);
const num = (b, i) => BigInt(word(b, i));
const addrAt = (t) => "0x" + t.slice(26);

module.exports = handler(
  async (req) => {
    const tx = String(req.query?.tx || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw bad("tx must be a 32 byte hash");

    const receipt = await rpc("eth_getTransactionReceipt", [tx]);
    if (!receipt) {
      return { tx, found: false, note: "no receipt yet; the transaction may still be pending" };
    }

    const routers = [DATA.contracts.router, DATA.contracts.routerV4].map((a) => a.toLowerCase());
    const to = (receipt.to || "").toLowerCase();
    const succeeded = receipt.status === "0x1";

    if (!routers.includes(to)) {
      return {
        tx, found: true, ours: false, status: succeeded ? "success" : "reverted",
        to: receipt.to,
        note: "this transaction did not go to a Voxelithic router",
      };
    }

    const log = (receipt.logs || []).find(
      (l) => (l.topics || [])[0] === TOPIC && routers.includes((l.address || "").toLowerCase())
    );

    if (!log) {
      return {
        tx, found: true, ours: true,
        status: succeeded ? "success" : "reverted",
        filled: false,
        blockNumber: parseInt(receipt.blockNumber, 16),
        gasUsed: parseInt(receipt.gasUsed, 16),
        note: succeeded
          ? "went to the router but emitted no RouteExecuted, so nothing settled"
          : "the router reverted, so nothing settled and the input stayed with the sender",
      };
    }

    const b = log.data.slice(2);
    return {
      tx,
      found: true,
      ours: true,
      status: "success",
      filled: true,
      router: log.address,
      blockNumber: parseInt(receipt.blockNumber, 16),
      gasUsed: parseInt(receipt.gasUsed, 16),
      fill: {
        sender: addrAt(log.topics[1]),
        tokenIn: addrAt(log.topics[2]),
        tokenOut: addrAt(log.topics[3]),
        amountIn: num(b, 0),
        amountOut: num(b, 1),
        hops: Number(num(b, 2)),
      },
      note:
        "Read from the RouteExecuted log in the receipt. The router emits it only " +
        "after the fill has been compared against the signed minimum.",
    };
  },
  { cacheSeconds: 30 }
);
