/* POST /api/v1/swap — неподписанная транзакция для маршрута из /quote.
 *
 * Мы не принимаем приватные ключи и не отправляем транзакции. Ответ — байты,
 * которые вызывающий подписывает сам и сам вещает в сеть. Украсть у него через
 * нас нечего: у API нет ни ключей, ни возможности что-либо подписать.
 *
 * Тело запроса:
 *   { tokenIn, tokenOut, amountIn, minOut, route, recipient?, deadlineSeconds? }
 * где route — массив из ответа /api/v1/quote, без изменений.
 */
const {
  DATA, encodeSwapExactIn, encodeSwapExactInV4, encodeSwapExactInSplit,
  resolveToken, handler, bad,
} = require("./_lib");

/* Человеческая сумма в сырые единицы. Раньше здесь стояла догадка «если строка
   из одних цифр и длиннее, чем decimals — значит уже сырые». Она молча ломала
   главный путь: у USDG шесть знаков, поэтому "1000000" читалось как 1 USDG
   вместо миллиона, а "999999" — правильно. Агент котировал два миллиона,
   передавал ту же строку сюда, как велит описание инструмента, и получал
   calldata на два доллара с minOut, посчитанным на два миллиона. Ответ при
   этом 200, и расхождения в нём не видно.

   Теперь никаких догадок: это поле всегда человеческое. Сырые единицы
   передаются отдельными полями amountInRaw и minOutRaw. */
/* Ноль здесь означает «отдам сколько угодно». Раньше он принимался, и ответ
   при этом всё равно печатал обещание про revert — то есть гарантию без
   защиты. Отказываем прямо. */
const ZERO_MINOUT =
  "minOut of zero accepts any fill at any price. Take minOut from the quote, " +
  "or compute a floor you are willing to sign for.";

function toRaw(amount, decimals, field) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw bad(`${field} must be a positive decimal number`);
  const [int, frac = ""] = s.split(".");
  if (frac.length > decimals) throw bad(`${field} has more than ${decimals} decimals`);
  return BigInt(int + frac.padEnd(decimals, "0"));
}

/* Сумма в базовых единицах, как её отдаёт /quote в полях amountInRaw и
   minOutRaw. Принимается только целое число — ни точки, ни экспоненты. */
function fromRawField(v, field) {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) throw bad(`${field} must be an integer in base units`);
  return BigInt(s);
}

/* Одно число из пары «человеческое / сырое». Даёт понятную ошибку, если
   пришли оба и они спорят между собой, вместо тихого выбора одного. */
function amountFrom(body, humanKey, rawKey, decimals) {
  const hasRaw = body[rawKey] != null;
  const hasHuman = body[humanKey] != null;
  if (!hasRaw && !hasHuman) return null;
  if (hasRaw && !hasHuman) return fromRawField(body[rawKey], rawKey);
  const human = toRaw(body[humanKey], decimals, humanKey);
  if (!hasRaw) return human;
  const raw = fromRawField(body[rawKey], rawKey);
  if (raw !== human) {
    throw bad(`${humanKey} and ${rawKey} disagree; send one of them, not both`);
  }
  return raw;
}

module.exports = handler(
  async (req) => {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { throw bad("body must be JSON"); }
    }
    if (!body || typeof body !== "object") throw bad("body must be a JSON object");

    const tin = resolveToken(body.tokenIn);
    const tout = resolveToken(body.tokenOut);
    if (!tin || tin.decimals == null) throw bad("unknown or non-canonical tokenIn");
    if (!tout || tout.decimals == null) throw bad("unknown or non-canonical tokenOut");

    /* Сплит: ноги обеих семей в одном вызове. Приходит из поля split ответа
       /quote без изменений и исполняется отдельным контрактом — обычный роутер
       такой формы не принимает. */
    if (body.legsV3 || body.legsV4) {
      const l3 = body.legsV3 || [];
      const l4 = body.legsV4 || [];
      if (!Array.isArray(l3) || !Array.isArray(l4)) throw bad("legsV3 and legsV4 must be arrays");
      if (l3.length + l4.length < 1) throw bad("a split needs at least one leg");
      if (l3.length + l4.length > 6) throw bad("the split router accepts at most six legs");

      /* Суммы и срок считаются здесь же: общий блок ниже привязан к route,
         а сплит до него не доходит. */
      const minOut = amountFrom(body, "minOut", "minOutRaw", tout.decimals);
      if (minOut == null) {
        throw bad("minOut is required; take minOut or minOutRaw from the quote, or compute your own");
      }
      if (minOut === 0n) throw bad(ZERO_MINOUT);
      const secs = body.deadlineSeconds == null ? 300 : Number(body.deadlineSeconds);
      if (!Number.isInteger(secs) || secs < 15 || secs > 3600) {
        throw bad("deadlineSeconds must be an integer between 15 and 3600");
      }
      const deadline = Math.floor(Date.now() / 1000) + secs;

      /* Входом считается СУММА ног, а не отдельно переданное число. Так
         невозможно рассогласование: роутер снимет ровно то, что исполнит.
         Заодно снимается ловушка toRaw, где длинная строка молча считается
         уже сырой. */
      const amountIn = [...l3, ...l4].reduce((a, l) => a + BigInt(l.amountIn), 0n);
      if (amountIn <= 0n) throw bad("the legs add up to zero");

      let hopCount = 0;
      for (const l of [...l3, ...l4]) {
        if (!l || !Array.isArray(l.hops) || !l.hops.length) throw bad("every leg needs hops");
        if (l.hops.length > 3) throw bad("a leg accepts at most three hops");
        hopCount += l.hops.length;
      }
      if (hopCount > 10) throw bad("the split router accepts at most ten hops in total");

      const splitData = encodeSwapExactInSplit({
        tokenIn: tin.address, tokenOut: tout.address,
        minOut, deadline, legsV3: l3, legsV4: l4,
      });

      return {
        chainId: DATA.chainId,
        transaction: { to: DATA.contracts.routerSplit, data: splitData, value: "0x0" },
        approval: { token: tin.address, spender: DATA.contracts.routerSplit, amount: amountIn },
        note:
          "Split execution. The order is divided across pools of both families and " +
          "filled in one transaction. minOut is checked once against the total, not " +
          "per leg, so size it against the least liquid pool in the route rather than " +
          "the average.",
      };
    }

    const route = body.route;
    if (!Array.isArray(route) || route.length === 0) {
      throw bad("route is required; pass the route array from /api/v1/quote unchanged");
    }
    if (route.length > 3) throw bad("the router accepts at most three hops");

    const amountIn = amountFrom(body, "amountIn", "amountInRaw", tin.decimals);
    if (amountIn == null) throw bad("amountIn is required; pass amountIn or amountInRaw");
    if (amountIn <= 0n) throw bad("amountIn must be greater than zero");

    /* minOut обязателен и не подставляется по умолчанию. Значение по умолчанию
       здесь означало бы, что мы решаем за пользователя, какой убыток ему
       приемлем, — а именно это число и есть его защита. */
    const minOut = amountFrom(body, "minOut", "minOutRaw", tout.decimals);
    if (minOut == null) {
      throw bad("minOut is required; take minOut or minOutRaw from the quote, or compute your own");
    }
    if (minOut === 0n) throw bad(ZERO_MINOUT);

    const seconds = body.deadlineSeconds == null ? 300 : Number(body.deadlineSeconds);
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600) {
      throw bad("deadlineSeconds must be an integer between 15 and 3600");
    }
    const deadline = Math.floor(Date.now() / 1000) + seconds;

    const isV4 = route.every((h) => h && h.key);
    const isV3 = route.every((h) => h && h.pool);
    if (!isV4 && !isV3) throw bad("route mixes v3 and v4 hops; pass one family at a time");

    const to = isV4 ? DATA.contracts.routerV4 : DATA.contracts.router;
    const data = isV4
      ? encodeSwapExactInV4({ hops: route, amountIn, minOut, deadline })
      : encodeSwapExactIn({
          tokenIn: tin.address, tokenOut: tout.address, amountIn, minOut, deadline, hops: route,
        });

    return {
      chainId: DATA.chainId,
      transaction: { to, data, value: "0x0" },
      approval: {
        // Роутер тянет вход через transferFrom, поэтому разрешение обязательно.
        token: tin.address,
        spender: to,
        amount: amountIn,
        note: "Approve this before sending the swap, unless the allowance already covers it.",
      },
      amountIn,
      minOut,
      deadline,
      signing:
        "This transaction is unsigned. Sign and broadcast it yourself: " +
        "the API holds no keys and cannot submit anything on your behalf.",
      guarantee:
        "If what lands is below minOut, the router reverts with VoxSlippage and " +
        "your input stays where it is.",
    };
  },
  { methods: ["POST"] }
);
