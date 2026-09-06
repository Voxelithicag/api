/* _lib.js — общая часть публичного API.

   Файлы с подчёркиванием Vercel маршрутом не считает, поэтому наружу этот
   модуль не торчит.

   Кодировщики повторяют app/abi.js байт-в-байт: селекторы посчитаны cast'ом
   и сверены скриптом verify/encode_check.mjs. Дублирование намеренное —
   браузерный модуль ESM, а функции здесь CommonJS, и связывать их через
   сборщик ради шести функций дороже, чем держать копию с этой пометкой. */

const DATA = require("./_data.json");

/* Ключ ноды живёт только на сервере: у Chainstack он прямо в адресе.
   Публичная нода идёт вторым номером — все запросы здесь только на чтение,
   так что переход на неё ничего не раскрывает и ничем не рискует. Обе сразу
   отказывают заметно реже, чем каждая по отдельности. */
const UPSTREAMS = [
  process.env.VOX_RPC_UPSTREAM,
  "https://rpc.mainnet.chain.robinhood.com",
].filter(Boolean);

/* Публичная нода отвечает 403 без браузерного User-Agent. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SEL = {
  quoteMany: "0x02fc6ced",
  quoteManyV4: "0x7a7c46ba",
  swapExactIn: "0x05b094ac",
  swapExactInV4: "0xc6eea3a0",
};

const ZERO = "0x0000000000000000000000000000000000000000";

/* ───────────────────────────── кодирование ───────────────────────────── */

const word = (h) => h.padStart(64, "0");
const uint = (n) => word(BigInt(n).toString(16));
const addr = (a) => word(String(a).toLowerCase().replace(/^0x/, ""));
const bool = (b) => word(b ? "1" : "0");
const int24w = (n) => {
  const v = BigInt(n);
  return word((v < 0n ? (1n << 256n) + v : v).toString(16));
};

const hopWordsV4 = (h) =>
  addr(h.key.currency0) +
  addr(h.key.currency1) +
  uint(h.key.fee) +
  int24w(h.key.tickSpacing) +
  addr(h.key.hooks || ZERO) +
  bool(h.zeroForOne);

function encodeQuoteMany(legs, amountIn) {
  let d = SEL.quoteMany + uint(0x40) + uint(amountIn) + uint(legs.length);
  for (const l of legs) d += addr(l.pool) + bool(l.zeroForOne);
  return d;
}

function encodeQuoteManyV4(legs, amountIn) {
  let d = SEL.quoteManyV4 + uint(0x40) + uint(amountIn) + uint(legs.length);
  for (const l of legs) d += hopWordsV4(l);
  return d;
}

function encodeSwapExactIn({ tokenIn, tokenOut, amountIn, minOut, deadline, hops }) {
  let d =
    SEL.swapExactIn + addr(tokenIn) + addr(tokenOut) + uint(amountIn) +
    uint(minOut) + uint(deadline) + uint(0xc0) + uint(hops.length);
  for (const h of hops) d += uint(h.kind) + addr(h.pool) + bool(h.zeroForOne) + uint(h.feePpm || 0);
  return d;
}

function encodeSwapExactInV4({ hops, amountIn, minOut, deadline }) {
  let d =
    SEL.swapExactInV4 + uint(0x80) + uint(amountIn) + uint(minOut) +
    uint(deadline) + uint(hops.length);
  for (const h of hops) d += hopWordsV4(h);
  return d;
}

/**
 * Кодировка swapExactInSplit(address,address,uint256,uint256,LegV3[],LegV4[]).
 *
 * Обе ноги — ДИНАМИЧЕСКИЕ структуры (внутри массив хопов), поэтому массив ног
 * пишется как длина, затем смещения на каждую ногу, затем сами ноги. Смещения
 * внутри массива отсчитываются от начала ЕГО данных, а не от начала calldata —
 * на этом и ломаются ручные кодировщики.
 */
const SEL_SPLIT = "0x4297eecc"; // swapExactInSplit(...)

function encodeLegV3(leg) {
  // голова ноги: amountIn, смещение до hops (0x40 — сразу за головой)
  let body = uint(leg.amountIn) + uint(0x40) + uint(leg.hops.length);
  for (const h of leg.hops) {
    body += uint(h.kind ?? 1) + addr(h.pool) + bool(h.zeroForOne) + uint(h.feePpm || 0);
  }
  return body;
}

function encodeLegV4(leg) {
  let body = uint(leg.amountIn) + uint(0x40) + uint(leg.hops.length);
  for (const h of leg.hops) body += hopWordsV4(h);
  return body;
}

/** Массив динамических структур: длина, смещения, тела. */
function encodeLegArray(legs, encodeOne) {
  const bodies = legs.map(encodeOne);
  let offset = legs.length * 32; // сразу за таблицей смещений
  let head = uint(legs.length);
  for (const b of bodies) {
    head += uint(offset);
    offset += b.length / 2;
  }
  return head + bodies.join("");
}

function encodeSwapExactInSplit({ tokenIn, tokenOut, minOut, deadline, legsV3, legsV4 }) {
  const a3 = encodeLegArray(legsV3 || [], encodeLegV3);
  const a4 = encodeLegArray(legsV4 || [], encodeLegV4);
  const HEAD = 6 * 32; // шесть слов головы
  const off3 = HEAD;
  const off4 = HEAD + a3.length / 2;
  return (
    SEL_SPLIT +
    addr(tokenIn) + addr(tokenOut) + uint(minOut) + uint(deadline) +
    uint(off3) + uint(off4) + a3 + a4
  );
}

/** Возврат quoteMany: два динамических массива (outs, paid). */
function decodeQuoteMany(hex) {
  if (!hex || hex.length < 130) return null;
  const b = hex.slice(2);
  const at = (i) => BigInt("0x" + b.slice(i * 64, (i + 1) * 64));
  const readArr = (byteOffset) => {
    const w = byteOffset / 32;
    const len = Number(at(w));
    const out = [];
    for (let i = 0; i < len; i++) out.push(at(w + 1 + i));
    return out;
  };
  try {
    return { outs: readArr(Number(at(0))), paid: readArr(Number(at(1))) };
  } catch {
    return null;
  }
}

/* ──────────────────────────────── RPC ────────────────────────────────── */

let reqId = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Нода периодически придерживает запрос или отвечает пятисоткой. Без повтора
   одна такая осечка превращалась в 502 для вызывающего — именно это и поймал
   CI, когда три параллельных прогона пришли одновременно. Попыток немного и
   пауза короткая: функция живёт секунды, и лучше честно сказать «недоступно»,
   чем висеть до таймаута платформы. */
const ATTEMPTS = 3;

async function rpcBatch(calls) {
  if (!calls.length) return [];
  const body = calls.map((c) => ({ jsonrpc: "2.0", id: ++reqId, ...c }));
  const payload = JSON.stringify(body);

  let last;
  for (const upstream of UPSTREAMS) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt) await sleep(120 * 2 ** (attempt - 1) + Math.random() * 80);
      try {
        const res = await fetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": UA },
          body: payload,
        });
        if (!res.ok) {
          const e = new Error("rpc http " + res.status);
          e.status = res.status;
          // 4xx кроме 429 — наш запрос, повтор не поможет и вторая нода не спасёт.
          if (res.status !== 429 && res.status < 500) throw e;
          last = e;
          continue;
        }
        const j = await res.json();
        const arr = Array.isArray(j) ? j : [j];
        arr.sort((a, b) => a.id - b.id);

        /* Нода может ответить двумястами и при этом положить ошибку внутрь
           каждого элемента — так ведёт себя приватный узел на отдельных
           eth_call. Транспортно это успех, поэтому переход на резервную ноду
           здесь не включался, и вызывающий получал 503 на паре, которую
           публичный узел считает без запинки. Полный отказ внутри ответа
           приравниваем к отказу узла и пробуем следующий. */
        if (arr.length && arr.every((x) => x && x.error) && upstream !== UPSTREAMS.at(-1)) {
          last = new Error(arr[0].error?.message || "node returned errors for every call");
          break; // к следующему узлу, повторять этот бессмысленно
        }
        return arr;
      } catch (e) {
        if (e.status && e.status !== 429 && e.status < 500) throw e;
        last = e;
      }
    }
  }
  const e = new Error("no upstream answered");
  e.upstream = true;
  e.cause = last;
  throw e;
}

async function rpc(method, params = []) {
  const [r] = await rpcBatch([{ method, params }]);
  if (!r || r.error) {
    /* Помечаем как апстрим, иначе обработчик отдаёт непрозрачную 502 и
       вызывающий не понимает, что запрос был верным и повтор имеет смысл.
       На этом пути ошибка теряла классификацию: поймано в /verify. */
    const e = new Error(r?.error?.message || "no answer from the node");
    e.upstream = true;
    throw e;
  }
  return r.result;
}

const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

/* ─────────────────────────── подбор пулов ────────────────────────────── */

/** Пулы v3-семейства, в которых лежит ровно эта пара. */
function poolsFor(a, b) {
  const lo = a.toLowerCase();
  const hi = b.toLowerCase();
  const out = [];
  for (const [pool, f] of Object.entries(DATA.pools)) {
    const has = (f.token0 === lo && f.token1 === hi) || (f.token0 === hi && f.token1 === lo);
    if (has) out.push({ pool, ...f, zeroForOne: f.token0 === lo });
  }
  return out;
}

/** Ключи v4 для этой пары. Нероутируемые отсеяны ещё на сборке данных. */
function keysFor(a, b) {
  const lo = a.toLowerCase();
  const hi = b.toLowerCase();
  const out = [];
  for (const [id, k] of Object.entries(DATA.poolKeys)) {
    const c0 = k.currency0.toLowerCase();
    const c1 = k.currency1.toLowerCase();
    if ((c0 === lo && c1 === hi) || (c0 === hi && c1 === lo)) {
      out.push({ id, key: k, zeroForOne: c0 === lo });
    }
  }
  return out;
}

/* ─────────────────────── опрос набора пулов ──────────────────────────── */

/**
 * Спросить у пулов, сколько они дадут за один и тот же вход.
 *
 * Группами по три, а не все сразу: котировка — это реальная симуляция свопа
 * внутри eth_call, и её вес растёт с размером ордера. Семь пулов в одном
 * вызове нода считает до сотни тысяч USDG, а на полумиллионе отказывает — при
 * этом тот же объём по одному пулу считается без труда. Значит предел в весе
 * вызова, а не в размере сделки, и лечится он нарезкой.
 *
 * Падение одной группы не убивает ответ: остальные пулы уже ответили, и их
 * цены годны. Но если не ответил НИ ОДИН — это «мы не знаем», а не «нет
 * ликвидности»: первое означает повторить, второе вызывающий примет за факт
 * о рынке.
 */
async function askLegs(legs3, legs4, amountIn, chunkSize, blockTag = "latest") {
  if (amountIn <= 0n || (!legs3.length && !legs4.length)) {
    return { quotes: [], answered: 0, considered: 0 };
  }

  /* По умолчанию группами по три: так дешевле по числу вызовов. Но вес
     eth_call ограничен, и на крупном объёме группа из трёх пулов уже не
     считается — тогда вызывающий просит группы по одному. */
  const CHUNK = chunkSize || 3;
  const chunks = [];
  const push = (legs, family) => {
    for (let i = 0; i < legs.length; i += CHUNK) {
      chunks.push({ family, legs: legs.slice(i, i + CHUNK) });
    }
  };
  push(legs3, "v3");
  push(legs4, "v4");

  const calls = chunks.map((c) => ({
    method: "eth_call",
    params: [
      {
        to: c.family === "v3" ? DATA.contracts.quoter : DATA.contracts.quoterV4,
        data:
          c.family === "v3"
            ? encodeQuoteMany(c.legs, amountIn)
            : encodeQuoteManyV4(c.legs, amountIn),
      },
      blockTag,
    ],
  }));

  const res = await rpcBatch(calls);
  const quotes = [];
  let answered = 0;

  chunks.forEach((c, ci) => {
    const r = res[ci];
    if (!r || r.error || !r.result || r.result === "0x") return;
    const dec = decodeQuoteMany(r.result);
    if (!dec) return;
    answered += c.legs.length;

    c.legs.forEach((l, i) => {
      const out = dec.outs[i] ?? 0n;
      if (out <= 0n || dec.paid[i] !== BigInt(amountIn)) return;
      if (c.family === "v3") {
        quotes.push({
          family: "v3", leg: l, pool: l.pool, feePpm: l.feePpm, zeroForOne: l.zeroForOne,
          out, hop: { kind: 1, pool: l.pool, zeroForOne: l.zeroForOne, feePpm: 0 },
        });
      } else {
        quotes.push({
          family: "v4", leg: l, poolId: l.id, fee: l.key.fee, zeroForOne: l.zeroForOne,
          out, hop: { key: l.key, zeroForOne: l.zeroForOne },
        });
      }
    });
  });

  return { quotes, answered, considered: legs3.length + legs4.length };
}

const legsFor = (a, b) => ({ legs3: poolsFor(a, b), legs4: keysFor(a, b) });

/* ───────────────────────── маршрут через мост ────────────────────────── */

/**
 * Пары бумага-бумага почти никогда не имеют своего пула: из 105 сочетаний
 * прямой пул есть у одиннадцати. Остальные достаются двумя хопами через
 * доллар, SPY или эфир, и роутер такие маршруты исполняет с самого начала —
 * не хватало только того, кто их построит.
 *
 * Семью смешивать нельзя: v3 исполняет VoxRouter, v4 — VoxRouterV4, и один
 * маршрут не может пройти через оба. Поэтому мост подбирается внутри семьи.
 */
const BRIDGE_SYMBOLS = ["SPY", "USDG", "WETH"];

/** Второй хоп стоит второй комиссии и второго пула, который может кончиться. */
const BRIDGE_EDGE_BPS = 10n;

function bridgeTokens(tokenIn, tokenOut) {
  const skip = new Set([tokenIn.toLowerCase(), tokenOut.toLowerCase()]);
  const out = [];
  for (const s of BRIDGE_SYMBOLS) {
    const t = DATA.tokens[s];
    if (!t) continue;
    const a = t.address.toLowerCase();
    if (!skip.has(a)) out.push({ symbol: s, address: a });
  }
  return out;
}

/**
 * Лучший двуххоповый маршрут.
 *
 * Первые хопы всех мостов считаются от одного и того же объёма и друг от друга
 * не зависят — это ОДИН батч, а не батч на мост. Вторые хопы зависят каждый от
 * своего выхода, поэтому идут параллельно, но тоже одним заходом.
 *
 * Возвращает не только маршрут, но и сколько ног ответило: если не ответил
 * никто, вызывающий обязан отличить «мы не знаем» от «маршрута нет». Иначе
 * молчание узла уходит наружу как факт о рынке.
 */
async function quoteBridged({ tokenIn, tokenOut, amountIn, blockTag = "latest" }) {
  const empty = { route: null, answered: 0, considered: 0 };
  const bridges = bridgeTokens(tokenIn, tokenOut);
  if (!bridges.length) return empty;

  /* ── первый хоп: все мосты одним батчем ── */
  const legs3 = [], legs4 = [], ownerOf = new Map();
  for (const b of bridges) {
    const { legs3: a3, legs4: a4 } = legsFor(tokenIn, b.address);
    for (const l of a3) { ownerOf.set("v3:" + l.pool, b); legs3.push(l); }
    for (const l of a4) { ownerOf.set("v4:" + l.id, b); legs4.push(l); }
  }
  if (!legs3.length && !legs4.length) return empty;

  const first = await askLegs(legs3, legs4, amountIn, undefined, blockTag);
  let answered = first.answered;
  let considered = first.considered;

  if (!first.answered) {
    /* Ноги были, ответа нет: это отказ узла, а не отсутствие ликвидности. */
    const e = new Error("the quoter did not answer on the bridged path");
    e.upstream = true;
    throw e;
  }

  /* Лучший первый хоп внутри каждой пары (мост, семья): дальше цепочка обязана
     остаться в своей семье — v3 исполняет VoxRouter, v4 — VoxRouterV4. */
  const heads = new Map();
  for (const q of first.quotes) {
    const b = ownerOf.get(q.family + ":" + (q.pool || q.poolId));
    if (!b) continue;
    const key = b.symbol + "|" + q.family;
    const cur = heads.get(key);
    if (!cur || q.out > cur.hop1.out) heads.set(key, { bridge: b, family: q.family, hop1: q });
  }
  if (!heads.size) return { route: null, answered, considered };

  /* ── второй хоп: каждый от своего выхода, но все разом ── */
  const tasks = [...heads.values()].map(async (h) => {
    const { legs3: b3, legs4: b4 } = legsFor(h.bridge.address, tokenOut);
    const same3 = h.family === "v3" ? b3 : [];
    const same4 = h.family === "v4" ? b4 : [];
    if (!same3.length && !same4.length) return null;

    /* Отказ одного моста не должен отменять уже посчитанные: остальные ветки
       независимы, и ронять их из-за чужой осечки — терять готовый маршрут. */
    let r;
    try {
      r = await askLegs(same3, same4, h.hop1.out, undefined, blockTag);
    } catch {
      return { failed: true, considered: same3.length + same4.length };
    }
    const best = r.quotes.sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : 0))[0];
    return {
      answered: r.answered,
      considered: r.considered,
      route: best && {
        family: h.family,
        bridge: h.bridge.symbol,
        out: best.out,
        hops: [h.hop1.hop, best.hop],
        legs: [h.hop1.leg, best.leg],
        pool: h.hop1.pool || h.hop1.poolId,
      },
    };
  });

  const settled = await Promise.all(tasks);
  const routes = [];
  let secondAsked = 0, secondAnswered = 0;
  for (const s of settled) {
    if (!s) continue;
    considered += s.considered || 0;
    secondAsked += s.considered || 0;
    if (s.failed) continue;
    answered += s.answered || 0;
    secondAnswered += s.answered || 0;
    if (s.route) routes.push(s.route);
  }

  /* Вторые хопы спрашивали, но не ответил ни один — снова «мы не знаем». */
  if (secondAsked && !secondAnswered) {
    const e = new Error("the quoter did not answer on the second hop");
    e.upstream = true;
    throw e;
  }

  routes.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  /* Отдаём и весь список, а не только победителя: чек показывает доску
     целиком, и для пары без прямого пула мостовые ветки — это вся доска. */
  return { route: routes[0] || null, routes, answered, considered };
}

/* ─────────────────────── разделение ордера ──────────────────────────── */

/**
 * Решатель сплита.
 *
 * Один пул платит за размер ордера: чем больше берёшь, тем хуже цена на
 * хвосте. Разложив ордер по нескольким пулам, каждая часть идёт по более
 * пологому участку своей кривой. Выигрыш даёт именно РАСПРЕДЕЛЕНИЕ — сплит
 * наугад проигрывает одиночному маршруту, это проверено на форке.
 *
 * Кривые не моделируются: каждый пул опрашивается на сетке долей, и по
 * замерам динамическим программированием ищется лучшая раскладка. Пул, не
 * принявший долю целиком, на этой доле просто выбывает.
 */
/* Сетка долей. Десять шагов, а не восемь: на восьми оптимум на десяти
   миллионах перестаёт находиться — раскладке не хватает разрешения. Вызовы
   при этом лёгкие, по одному пулу на каждый. */
const SPLIT_STEPS = 10;

/** Ниже этого влияния делить нечего: на малом ордере выигрыш единицы bps.
    Порог намеренно низкий — глубина пулов растёт, и влияние на паре USDG/SPY
    упало с 2294 до 34 bps на двух миллионах за пару дней. Гейт по влиянию, а
    не по сумме, поэтому он подстраивается сам. */
const SPLIT_MIN_IMPACT_BPS = 15;

/** Лишняя нога — это лишний газ, поэтому берём сплит только за заметную разницу. */
const SPLIT_EDGE_BPS = 15n;

async function solveSplit({ legs3, legs4, amountIn, bestSingleOut }) {
  const pools = [
    ...legs3.map((l) => ({ family: "v3", leg: l })),
    ...legs4.map((l) => ({ family: "v4", leg: l })),
  ];
  if (pools.length < 2) return null;

  const step = amountIn / BigInt(SPLIT_STEPS);
  if (step <= 0n) return null;

  /* Кривая каждого пула по сетке. Один заход на долю: все пулы разом. */
  const curve = pools.map(() => new Array(SPLIT_STEPS + 1).fill(null));
  for (const p of curve) p[0] = 0n;

  for (let k = 1; k <= SPLIT_STEPS; k++) {
    const amt = step * BigInt(k);
    let r;
    try {
      /* По одному пулу на вызов: на этих объёмах группа из трёх упирается в
         предел веса eth_call, часть групп молчит, и раскладка вырождается. */
      r = await askLegs(legs3, legs4, amt, 1);
    } catch {
      /* Отказ ОДНОЙ доли не отменяет сплит: остальные доли уже замерены, а
         динамическое программирование пропуски переживает. Раньше здесь стоял
         выход из функции, и на приватной ноде одна осечка убивала весь расчёт. */
      continue;
    }
    for (const q of r.quotes) {
      const id = q.pool || q.poolId;
      const i = pools.findIndex((p) => (p.leg.pool || p.leg.id) === id);
      if (i >= 0) curve[i][k] = q.out;
    }
  }

  /* ДП: dp[k] — лучший суммарный выход, потратив k долей. */
  const NEG = -1n;
  let dp = new Array(SPLIT_STEPS + 1).fill(NEG);
  let pick = new Array(SPLIT_STEPS + 1).fill(null);
  dp[0] = 0n;
  pick[0] = [];

  for (let i = 0; i < pools.length; i++) {
    const nd = dp.slice();
    const np = pick.slice();
    for (let k = 0; k <= SPLIT_STEPS; k++) {
      if (dp[k] === NEG) continue;
      for (let take = 1; k + take <= SPLIT_STEPS; take++) {
        const add = curve[i][take];
        if (add === null) continue;
        const val = dp[k] + add;
        if (nd[k + take] === NEG || val > nd[k + take]) {
          nd[k + take] = val;
          np[k + take] = [...(pick[k] || []), { i, take }];
        }
      }
    }
    dp = nd;
    pick = np;
  }

  const total = dp[SPLIT_STEPS];
  const alloc = (pick[SPLIT_STEPS] || []).filter((a) => a.take > 0);
  if (total <= 0n || alloc.length < 2) return null;
  if (alloc.length > 6) return null; // потолок ног в контракте

  /* Берём только за заметную разницу: лишние ноги стоят газа. */
  const gainBps = ((total - bestSingleOut) * 10_000n) / bestSingleOut;
  if (gainBps <= SPLIT_EDGE_BPS) return null;

  /* Последняя доля добирает остаток от деления, чтобы сумма ног сошлась. */
  const used = alloc.reduce((s, a) => s + a.take, 0);
  const legsOut3 = [];
  const legsOut4 = [];
  alloc.forEach((a, idx) => {
    const p = pools[a.i];
    let amt = step * BigInt(a.take);
    if (idx === alloc.length - 1 && used === SPLIT_STEPS) {
      amt = amountIn - alloc.slice(0, idx).reduce((s, x) => s + step * BigInt(x.take), 0n);
    }
    const hop = p.family === "v3"
      ? { kind: 1, pool: p.leg.pool, zeroForOne: p.leg.zeroForOne, feePpm: 0 }
      : { key: p.leg.key, zeroForOne: p.leg.zeroForOne };
    (p.family === "v3" ? legsOut3 : legsOut4).push({ amountIn: amt, hops: [hop] });
  });

  return { out: total, gainBps: Number(gainBps), legsV3: legsOut3, legsV4: legsOut4 };
}

/** Прогнать маршрут целиком на заданном входе. null = не смогли посчитать. */
async function quoteRoute(legs, family, amountIn) {
  let amt = amountIn;
  for (const leg of legs) {
    if (amt <= 0n) return null;
    const isV4 = family === "v4";
    const raw = await ethCall(
      isV4 ? DATA.contracts.quoterV4 : DATA.contracts.quoter,
      isV4 ? encodeQuoteManyV4([leg], amt) : encodeQuoteMany([leg], amt)
    );
    const dec = decodeQuoteMany(raw);
    if (!dec || dec.paid?.[0] !== amt || !(dec.outs?.[0] > 0n)) return null;
    amt = dec.outs[0];
  }
  return amt;
}

/* ─────────────────────── комиссия самих роутеров ─────────────────────── */

/**
 * Роутер режет свою ставку с ВЫХОДНОГО токена и делает это ДО проверки minOut.
 * Значит котировка, посчитанная по пулам, — это ещё не то, что получит
 * человек. Разница в размере ставки, и на ней же ломается minOut: клиент
 * берёт его от нашего числа, а роутер сверяет со своим.
 *
 * Поэтому ставка читается с самих роутеров и вычитается здесь, а не
 * зашивается константой: включать её будут отдельной транзакцией, и котировка
 * обязана поехать в тот же момент, а не в следующем деплое.
 *
 * Кэш короткий: ставка меняется вручную и редко, но узнать об изменении нужно
 * в пределах минуты, а не суток.
 */
/** Потолок ставки, зашитый в самих роутерах. Используется как безопасный ответ. */
const MAX_FEE_BPS = 30;

const FEE_TTL_MS = 45_000;
const SEL_FEE_BPS = "0x24a9d853"; // feeBps()
let feeCache = { at: 0, bps: null };

async function routerFeeBps(blockTag = "latest") {
  /* Кэш держит только текущую ставку. Историческое чтение обязано ходить в
     ноду: ставка могла быть другой в тот блок, а вернуть сегодняшнюю значит
     посчитать чужую сделку по чужой комиссии. */
  const live = blockTag === "latest";
  if (live && feeCache.bps && Date.now() - feeCache.at < FEE_TTL_MS) return feeCache.bps;

  const routers = {
    v3: DATA.contracts.router,
    v4: DATA.contracts.routerV4,
    split: DATA.contracts.routerSplit,
  };
  const names = Object.keys(routers);
  let res;
  try {
    res = await rpcBatch(
      names.map((n) => ({
        method: "eth_call",
        params: [{ to: routers[n], data: SEL_FEE_BPS }, blockTag],
      })),
    );
  } catch {
    /* Ставка — поправка к ответу, а не сам ответ: ронять из-за неё котировку
       не стоит. Берём потолок и не кэшируем, чтобы следующий запрос попробовал
       снова. */
    return { v3: MAX_FEE_BPS, v4: MAX_FEE_BPS, split: MAX_FEE_BPS };
  }

  const bps = {};
  names.forEach((n, i) => {
    const r = res[i];
    /* Прочитать не смогли — считаем ставку максимальной, а не нулевой.
       Ошибка в эту сторону занижает котировку и человек получает больше
       обещанного; ошибка в другую сторону даёт реверт на каждом свапе. */
    bps[n] = r && !r.error && r.result ? Number(BigInt(r.result)) : MAX_FEE_BPS;
  });

  if (live) feeCache = { at: Date.now(), bps };
  return bps;
}

const afterFee = (out, bps) => (bps ? (out * BigInt(10_000 - bps)) / 10_000n : out);

/* ────────────────────────────── котировка ────────────────────────────── */

/**
 * Лучшая исполнимая котировка: сначала прямые пулы обеих семей, затем — если
 * прямого пути нет или он заметно хуже — маршрут через мост.
 *
 * Пулы не фильтруются по данным индексатора: спрашиваем сами пулы, и тот, кто
 * не смог принять весь объём, возвращает paid != amountIn и выбывает. Это же
 * отсекает и мёртвую ликвидность, ради которой иначе нужен был бы внешний
 * источник цифр.
 */
async function quoteBest({ tokenIn, tokenOut, amountIn, slippageBps }) {
  const { legs3, legs4 } = legsFor(tokenIn, tokenOut);

  /* Прямой и мостовой пути независимы, поэтому считаются разом: иначе задержка
     складывалась бы, а не бралась по максимуму. */
  const [direct, bridgedRes, feeBps] = await Promise.all([
    askLegs(legs3, legs4, amountIn),
    quoteBridged({ tokenIn, tokenOut, amountIn }).catch((e) => ({ error: e })),
    routerFeeBps(),
  ]);
  const hasDirectPools = legs3.length + legs4.length > 0;

  if (hasDirectPools && !direct.answered) {
    const e = new Error("the quoter did not answer for any pool");
    e.upstream = true;
    throw e;
  }

  const quotes = direct.quotes.slice();
  quotes.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  let best = quotes[0] || null;

  /* Мост берём, когда прямого маршрута нет вовсе или когда он выигрывает
     заметно: лишний хоп — это вторая комиссия и второй пул, который может
     кончиться, поэтому ради долей базисного пункта его брать не стоит. */
  /* Сбой моста сам по себе ответ не рушит: если прямой маршрут найден, его и
     отдаём. Но когда не нашлось НИЧЕГО, а мост при этом не удалось опросить,
     промолчать нельзя — иначе «мы не знаем» уедет наружу как «маршрута нет». */
  const bridgeFailed = !!bridgedRes?.error;
  const bridged = bridgeFailed ? null : bridgedRes.route;

  if (bridged) {
    const beatsBy = best
      ? ((bridged.out - best.out) * 10_000n) / (best.out || 1n)
      : BRIDGE_EDGE_BPS + 1n;
    if (!best || beatsBy > BRIDGE_EDGE_BPS) {
      best = {
        family: bridged.family,
        out: bridged.out,
        hops: bridged.hops,
        legs: bridged.legs,
        pool: bridged.pool,
        bridge: bridged.bridge,
      };
    }
  }

  /* Считаем ВСЕ опрошенные ноги, включая мостовые: вызывающий читает эти числа
     как признак полноты обхода, и занижать их — врать о качестве котировки. */
  const considered = direct.considered + (bridgedRes?.considered || 0);
  const answered = direct.answered + (bridgedRes?.answered || 0);

  if (!best) {
    if (bridgeFailed) throw bridgedRes.error; // 503 «повтори», а не «нет пути»
    return { best: null, considered, answered, bridgeSearched: true };
  }

  if (!best.hops) {
    best.hops = [best.hop];
    best.legs = [best.leg];
  }

  /* Влияние на цену: сколько стоит сам размер ордера.
   *
   * Без этой цифры API отдавал «вот ваша котировка» и на запросе, который
   * выпивает пул целиком. Человек заметил бы абсурдную сумму, агент — нет: у
   * него нет справочной цены, и он посчитал бы minOut от того, что дали.
   *
   * Мерим по ТОМУ ЖЕ маршруту на малом опорном объёме, отдельным запросом, а
   * не в общем батче: котировка большого объёма — тяжёлая симуляция, и
   * удвоение её в одном батче нода уже не выдерживает. Тот же маршрут важен —
   * иначе мерили бы разброс между площадками, а не стоимость размера.
   */
  let priceImpactBps = 0;
  const refIn = amountIn > 10_000n ? amountIn / 10_000n : 0n;

  if (refIn > 0n) {
    try {
      const refOut = await quoteRoute(best.legs, best.family, refIn);
      if (refOut && refOut > 0n) {
        const spot = (refOut * amountIn) / refIn; // выход по цене малого размера
        const drop = spot > best.out ? spot - best.out : 0n;
        priceImpactBps = Number((drop * 10_000n) / spot);
      } else {
        priceImpactBps = null; // не смогли измерить — врать нулём нельзя
      }
    } catch {
      /* Влияние — дополнение, а не суть ответа. Если опорный запрос не прошёл,
         честнее вернуть котировку с null, чем уронить весь запрос. */
      priceImpactBps = null;
    }
  }

  /* Сплит считается только на крупном ордере. На малом выигрыш — единицы
     базисных пунктов, а опрос сетки долей стоит десятка обходов к ноде. */
  let split = null;
  if (best.hops.length === 1 && priceImpactBps != null && priceImpactBps >= SPLIT_MIN_IMPACT_BPS) {
    try {
      split = await solveSplit({ legs3, legs4, amountIn, bestSingleOut: best.out });
    } catch {
      split = null; // сплит — дополнение; его сбой не рушит прямой ответ
    }
  }
  /* Комиссия роутера вычитается ПОСЛЕ замера влияния на цену: влияние — это
     отношение выхода к цене малого размера, и обе стороны там доfee-шные.
     Вычти раньше — и ставка отразилась бы в процентах влияния как проседание
     пула, которого нет.

     Одиночный маршрут исполняется своим роутером, сплит — сплит-роутером, и
     ставки у них независимы, поэтому берётся своя каждому. */
  const singleFee = feeBps[best.family === "v3" ? "v3" : "v4"] || 0;
  best.grossOut = best.out;
  best.out = afterFee(best.out, singleFee);
  best.feeBps = singleFee;
  best.minOut = (best.out * BigInt(10_000 - slippageBps)) / 10_000n;

  if (split && split.out) {
    const splitFee = feeBps.split || 0;
    split.grossOut = split.out;
    split.out = afterFee(split.out, splitFee);
    split.feeBps = splitFee;
    split.minOut = (split.out * BigInt(10_000 - slippageBps)) / 10_000n;

    /* Сплит сравнивается с одиночным маршрутом уже после комиссий обоих:
       иначе выигрыш считался бы между числами, которых никто не получит. */
    if (split.out <= best.out) split = null;
  }

  return { best, all: quotes, considered, answered, priceImpactBps, split };
}

/**
 * Вся доска на конкретном блоке: что дал бы каждый пул на этот размер.
 *
 * Отличается от quoteBest двумя вещами. Победитель не выбирается — возвращается
 * весь список, включая проигравших, потому что смысл именно в проигравших.
 * И читается это на историческом блоке, а не на текущем: сравнивать чужую
 * сделку с сегодняшним рынком бессмысленно, пулы с тех пор сдвинулись.
 *
 * Отсюда же берётся и проверяемость. Числа не хранятся у нас, а каждый раз
 * пересчитываются из состояния чейна, поэтому их воспроизведёт любой, у кого
 * есть архивный узел, — включая того, кто нам не верит.
 */
async function quoteAllAt({ tokenIn, tokenOut, amountIn, blockTag = "latest" }) {
  const { legs3, legs4 } = legsFor(tokenIn, tokenOut);
  const hasDirect = legs3.length + legs4.length > 0;

  /* Прямые пулы и мост считаются разом: они независимы, и складывать их
     задержки незачем. Падение моста доску не рушит — он дополнение. */
  const [feeBps, first, bridgedRes] = await Promise.all([
    routerFeeBps(blockTag),
    hasDirect
      ? askLegs(legs3, legs4, amountIn, undefined, blockTag)
      : Promise.resolve({ quotes: [], answered: 0, considered: 0 }),
    quoteBridged({ tokenIn, tokenOut, amountIn, blockTag }).catch(() => null),
  ]);

  /* Вес eth_call ограничен числом пулов в одном вызове, и на крупном размере
     группа из трёх уже не считается. Молча отдать неполную доску нельзя: в
     чеке это выглядело бы как «других вариантов не было». Поэтому недобор
     переспрашивается по одному пулу за вызов. */
  let direct = first;
  if (hasDirect && first.answered < first.considered) {
    try {
      const retry = await askLegs(legs3, legs4, amountIn, 1, blockTag);
      if (retry.answered > first.answered) direct = retry;
    } catch {
      /* Оставляем то, что уже получили: неполная доска честнее пустой, а
         число ответивших уезжает в ответ рядом с числом опрошенных. */
    }
  }

  const net = (out, fam) => afterFee(out, feeBps[fam === "v3" ? "v3" : "v4"] || 0);

  const rows = direct.quotes.map((q) => ({
    family: q.family,
    hops: 1,
    pool: q.pool || q.poolId,
    feePpm: q.family === "v3" ? q.feePpm : q.fee,
    /* Два числа, а не одно. grossOut — что отдаёт сам пул; out — что дошло бы
       до кошелька, если бы мы отправили сделку туда. Сравнение ведётся по
       второму, иначе наша комиссия сравнивалась бы с чужим брутто. */
    grossOut: q.out,
    out: net(q.out, q.family),
  }));

  /* Мостовые ветки — такие же строки доски. Для пары акция-акция, у которой
     своего пула почти никогда нет, это вся доска целиком. */
  for (const r of bridgedRes?.routes || []) {
    rows.push({
      family: r.family,
      hops: 2,
      bridge: r.bridge,
      pool: r.pool,
      pools: r.hops.map((h) => h.pool || h.key),
      grossOut: r.out,
      out: net(r.out, r.family),
    });
  }

  rows.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));

  return {
    rows,
    considered: direct.considered + (bridgedRes?.considered || 0),
    answered: direct.answered + (bridgedRes?.answered || 0),
    feeBps,
  };
}

/* ──────────────────────── разрешение тикеров ─────────────────────────── */

/** Принимает и тикер, и адрес. Тикер на этом чейне носят и чужие контракты. */
function resolveToken(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
    const sym = DATA.byAddress[v.toLowerCase()];
    return sym
      ? DATA.tokens[sym]
      : { symbol: null, name: null, decimals: null, address: v.toLowerCase(), known: false };
  }
  const sym = DATA.bySymbolLower[v.toLowerCase()];
  return sym ? DATA.tokens[sym] : null;
}

/* ─────────────────────────── ответ и лимиты ──────────────────────────── */

/* Ведро на адрес в памяти процесса. На serverless инстансов несколько, так что
   это не строгая гарантия — оно отсекает автоматический перебор, а не живого
   пользователя. Строгий лимит потребовал бы внешнего хранилища. */
const RATE = { windowMs: 60_000, max: 120 };
const buckets = new Map();

function overRate(ip) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.start > RATE.windowMs) {
    buckets.set(ip, { start: now, n: 1 });
    if (buckets.size > 5000) buckets.clear();
    return false;
  }
  b.n += 1;
  return b.n > RATE.max;
}

const clientIp = (req) =>
  (req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.socket?.remoteAddress ||
  "unknown";

/** BigInt в JSON не сериализуется — переводим в строки рекурсивно. */
function jsonSafe(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = jsonSafe(x);
    return o;
  }
  return v;
}

/**
 * Обёртка обработчика: CORS, метод, лимит, кеш и единый формат ошибки.
 *
 * CORS открыт намеренно: API рассчитан на агентов и чужие бэкенды, а не только
 * на наш сайт. Ключ ноды при этом остаётся здесь, наружу уходят только числа.
 */
function handler(fn, { methods = ["GET"], cacheSeconds = 0 } = {}) {
  return async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", methods.join(", ") + ", OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("content-type", "application/json; charset=utf-8");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (!methods.includes(req.method)) {
      return res.status(405).json({ error: "method not allowed", allowed: methods });
    }
    if (overRate(clientIp(req))) {
      res.setHeader("retry-after", "60");
      return res.status(429).json({ error: "rate limit", limit: RATE.max, windowSeconds: 60 });
    }

    try {
      const out = await fn(req, res);
      if (res.writableEnded) return undefined;
      res.setHeader(
        "cache-control",
        cacheSeconds
          ? `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`
          : "no-store"
      );
      return res.status(200).json(jsonSafe(out));
    } catch (e) {
      if (e.expose) return res.status(400).json({ error: e.message });
      if (e.status === 429) {
        res.setHeader("retry-after", "5");
        return res.status(429).json({ error: "upstream is throttling; retry shortly" });
      }
      /* 503 вместо 502 намеренно: вызывающему важно понять, что запрос был
         верным и повтор имеет смысл. Внутренности апстрима наружу не отдаём. */
      if (e.upstream) {
        res.setHeader("retry-after", "2");
        return res.status(503).json({ error: "upstream unavailable; the request was valid, retry" });
      }
      return res.status(502).json({ error: "unexpected failure" });
    }
  };
}

/** Ошибка, текст которой можно показать вызывающему. */
function bad(message) {
  const e = new Error(message);
  e.expose = true;
  return e;
}

module.exports = {
  DATA, ZERO,
  rpc, rpcBatch, ethCall,
  encodeSwapExactIn, encodeSwapExactInV4, encodeSwapExactInSplit,
  poolsFor, keysFor, quoteBest, quoteAllAt, resolveToken,
  handler, bad, jsonSafe,
};
