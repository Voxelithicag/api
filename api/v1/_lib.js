/* _lib.js — общая часть публичного API.

   Файлы с подчёркиванием Vercel маршрутом не считает, поэтому наружу этот
   модуль не торчит.

   Кодировщики повторяют app/abi.js байт-в-байт: селекторы посчитаны cast'ом
   и сверены скриптом verify/encode_check.mjs. Дублирование намеренное —
   браузерный модуль ESM, а функции здесь CommonJS, и связывать их через
   сборщик ради шести функций дороже, чем держать копию с этой пометкой. */

const DATA = require("./_data.json");

/* Ключ ноды живёт только на сервере: у Chainstack он прямо в адресе. */
const UPSTREAM =
  process.env.VOX_RPC_UPSTREAM || "https://rpc.mainnet.chain.robinhood.com";

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

  let last;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await sleep(120 * 2 ** (attempt - 1) + Math.random() * 80);
    try {
      const res = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = new Error("rpc http " + res.status);
        e.status = res.status;
        // 4xx кроме 429 — наш запрос, повтор не поможет.
        if (res.status !== 429 && res.status < 500) throw e;
        last = e;
        continue;
      }
      const j = await res.json();
      const arr = Array.isArray(j) ? j : [j];
      arr.sort((a, b) => a.id - b.id);
      return arr;
    } catch (e) {
      if (e.status && e.status !== 429 && e.status < 500) throw e;
      last = e;
    }
  }
  const e = new Error("upstream unavailable after " + ATTEMPTS + " attempts");
  e.upstream = true;
  e.cause = last;
  throw e;
}

async function rpc(method, params = []) {
  const [r] = await rpcBatch([{ method, params }]);
  if (!r || r.error) throw new Error(r?.error?.message || "rpc error");
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

/* ────────────────────────────── котировка ────────────────────────────── */

/**
 * Лучшая исполнимая котировка по прямым пулам обеих семей.
 *
 * Пулы не фильтруются по данным индексатора: спрашиваем сами пулы, и тот, кто
 * не смог принять весь объём, возвращает paid != amountIn и выбывает. Это же
 * отсекает и мёртвую ликвидность, ради которой иначе нужен был бы внешний
 * источник цифр.
 */
async function quoteBest({ tokenIn, tokenOut, amountIn, slippageBps }) {
  const legs3 = poolsFor(tokenIn, tokenOut);
  const legs4 = keysFor(tokenIn, tokenOut);
  if (!legs3.length && !legs4.length) return { best: null, considered: 0 };

  /* Пулы спрашиваем группами по три, а не все сразу.
   *
   * Котировка — это реальная симуляция свопа внутри eth_call, и её вес растёт
   * с размером ордера. Семь пулов в одном вызове нода считает до сотни тысяч
   * USDG, а на полумиллионе отказывает — при этом тот же объём по одному пулу
   * считается без труда. Значит предел в весе вызова, а не в размере сделки,
   * и лечится он нарезкой. Группы уходят одним батчем, лишнего круга нет. */
  const CHUNK = 3;
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
      "latest",
    ],
  }));

  const res = await rpcBatch(calls);
  const quotes = [];

  /* Нечитаемый ответ — это не «нет ликвидности», а «мы не знаем». Разница
     принципиальная: первое вызывающий воспримет как факт о рынке и уйдёт, а
     второе означает повторить запрос. Молча возвращать пустую книгу нельзя. */
  chunks.forEach((c, ci) => {
    const r = res[ci];
    if (!r || r.error || !r.result || r.result === "0x") {
      const e = new Error(`quoter did not answer for ${c.family}`);
      e.upstream = true;
      throw e;
    }
    const dec = decodeQuoteMany(r.result);
    if (!dec) {
      const e = new Error(`quoter answer for ${c.family} could not be decoded`);
      e.upstream = true;
      throw e;
    }
    c.legs.forEach((l, i) => {
      const out = dec.outs[i] ?? 0n;
      if (out <= 0n || dec.paid[i] !== BigInt(amountIn)) return;
      if (c.family === "v3") {
        quotes.push({
          family: "v3", pool: l.pool, feePpm: l.feePpm, zeroForOne: l.zeroForOne,
          out, hop: { kind: 1, pool: l.pool, zeroForOne: l.zeroForOne, feePpm: 0 },
        });
      } else {
        quotes.push({
          family: "v4", poolId: l.id, fee: l.key.fee, zeroForOne: l.zeroForOne,
          out, hop: { key: l.key, zeroForOne: l.zeroForOne },
        });
      }
    });
  });

  if (!quotes.length) return { best: null, considered: legs3.length + legs4.length };

  quotes.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  const best = quotes[0];
  best.minOut = (best.out * BigInt(10_000 - slippageBps)) / 10_000n;

  /* Влияние на цену: сколько стоит сам размер ордера.
   *
   * Без этой цифры API отдавал «вот ваша котировка» и на запросе, который
   * выпивает пул целиком. Человек заметил бы абсурдную сумму, агент — нет: у
   * него нет справочной цены, и он посчитал бы minOut от того, что дали.
   *
   * Спрашиваем только победивший пул и отдельным запросом, а не в общем батче:
   * котировка большого объёма — тяжёлая симуляция, и удвоение её в одном
   * батче нода уже не выдерживает. Сравнение идёт по тому же пулу, иначе
   * мерили бы разброс между площадками, а не стоимость размера.
   */
  let priceImpactBps = 0;
  const refIn = amountIn > 10_000n ? amountIn / 10_000n : 0n;

  if (refIn > 0n) {
    try {
      const isV4 = best.family === "v4";
      const leg = isV4
        ? legs4.find((l) => l.id === best.poolId)
        : legs3.find((l) => l.pool === best.pool);
      if (leg) {
        const raw = await ethCall(
          isV4 ? DATA.contracts.quoterV4 : DATA.contracts.quoter,
          isV4 ? encodeQuoteManyV4([leg], refIn) : encodeQuoteMany([leg], refIn)
        );
        const dec = decodeQuoteMany(raw);
        const refOut = dec?.paid?.[0] === refIn ? dec.outs[0] : null;
        if (refOut && refOut > 0n) {
          const spot = (refOut * amountIn) / refIn; // выход по цене малого размера
          const drop = spot > best.out ? spot - best.out : 0n;
          priceImpactBps = Number((drop * 10_000n) / spot);
        } else {
          priceImpactBps = null; // не смогли измерить — врать нулём нельзя
        }
      }
    } catch {
      /* Влияние — дополнение, а не суть ответа. Если опорный запрос не прошёл,
         честнее вернуть котировку с null, чем уронить весь запрос. */
      priceImpactBps = null;
    }
  }

  return { best, all: quotes, considered: legs3.length + legs4.length, priceImpactBps };
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
  encodeSwapExactIn, encodeSwapExactInV4,
  poolsFor, keysFor, quoteBest, resolveToken,
  handler, bad, jsonSafe,
};
