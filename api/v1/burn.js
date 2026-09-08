/* GET /api/v1/burn — сколько $VOXEL уже сожжено казной и что стоит в очереди.
 *
 * Комиссия 0.30% падает в казну внутри самой сделки — это делает роутер, без
 * посредников. Казна умеет с ней ровно одно: купить VOXEL и отправить его на
 * 0xdEaD. Функции вывода у неё нет ни для кого, включая владельца.
 *
 * `totalBurned` — счётчик самой казны, он только растёт. `sinkBalance` шире:
 * это весь VOXEL на адресе сожжения, включая тот, что сожгли волты лаунчпада,
 * поэтому он больше и это не расхождение.
 *
 * Долларовая оценка считается по СПОТУ (цена малого объёма), а не по тому,
 * что дали бы за весь сожжённый объём разом — такую продажу рынок бы не съел.
 * Поэтому поле называется usdAtSpot, а не usd.
 */
const { DATA, rpcBatch, quoteBest, handler } = require("./_lib");
const { keccak256 } = require("./_keccak");

const selector = (sig) => keccak256("0x" + Buffer.from(sig, "utf8").toString("hex")).slice(0, 10);
const SEL_TOTAL_BURNED = selector("totalBurned()");
const SEL_BALANCE_OF = "0x70a08231";
const SINK = "0x000000000000000000000000000000000000dEaD";

const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const big = (h) => (h && h !== "0x" ? BigInt(h) : 0n);
const units = (raw, dec) => Number(raw) / 10 ** dec;

module.exports = handler(
  async () => {
    const treasury = DATA.contracts.treasury;
    const voxel = DATA.tokens.VOXEL.address;

    /* Всё, что копится в казне, — это комиссия в том токене, который получал
       пользователь. Поэтому смотрим баланс казны по всему каноническому набору,
       а не по одному USDG. */
    const tokens = Object.entries(DATA.tokens).map(([sym, t]) => ({ sym, ...t }));

    const calls = [
      { method: "eth_call", params: [{ to: treasury, data: SEL_TOTAL_BURNED }, "latest"] },
      { method: "eth_call", params: [{ to: voxel, data: SEL_BALANCE_OF + pad(SINK) }, "latest"] },
      ...tokens.map((t) => ({
        method: "eth_call",
        params: [{ to: t.address, data: SEL_BALANCE_OF + pad(treasury) }, "latest"],
      })),
    ];
    const res = await rpcBatch(calls);

    const totalBurned = big(res[0]?.result);
    const sinkBalance = big(res[1]?.result);

    const pending = [];
    tokens.forEach((t, i) => {
      const bal = big(res[i + 2]?.result);
      if (bal > 0n) pending.push({ symbol: t.sym, address: t.address, decimals: t.decimals, amount: bal.toString() });
    });

    /* Спот-цена VOXEL: котируем небольшой объём, чтобы не мерить собственным
       проскальзыванием. Не смогли — честно отдаём null, а не выдумываем число. */
    let voxelUsdSpot = null;
    try {
      const probe = 1000n * 10n ** 18n;
      const q = await quoteBest({
        tokenIn: voxel,
        tokenOut: DATA.tokens.USDG.address,
        amountIn: probe,
        slippageBps: 100,
      });
      const out = q?.best?.out ?? q?.out;
      if (out && BigInt(out) > 0n) voxelUsdSpot = Number(BigInt(out)) / 1e6 / 1000;
    } catch { /* цены нет — поле останется null */ }

    const burnedVoxel = units(totalBurned, 18);

    return {
      chainId: DATA.chainId,
      treasury,
      sink: SINK,
      feeBps: 30,
      totalBurned: {
        voxel: burnedVoxel,
        raw: totalBurned.toString(),
        usdAtSpot: voxelUsdSpot === null ? null : burnedVoxel * voxelUsdSpot,
      },
      sinkBalance: { voxel: units(sinkBalance, 18), raw: sinkBalance.toString() },
      voxelUsdSpot,
      pending,
      note:
        "0.30% of every swap is taken by the router inside the trade and sent to the treasury. " +
        "The treasury can only buy $VOXEL with it and send that to the burn address — it has no " +
        "withdraw function, for anyone. totalBurned is the treasury's own counter and only goes up. " +
        "sinkBalance is larger because it also holds VOXEL burned by launchpad vaults.",
    };
  },
  { cacheSeconds: 30 }
);
