/* keccak256 для серверной части, CommonJS.
 *
 * Тот же алгоритм, что в app/keccak.js, слово в слово: там он нужен браузеру
 * как ES-модуль, здесь — функциям API как CommonJS. Тянуть библиотеку ради
 * двадцати четырёх раундов незачем, а импортировать ES-модуль из CJS нельзя.
 * Расхождение двух копий ловится сверкой: verify/keccak_check.mjs гоняет ОБЕ
 * против `cast keccak` на одном наборе векторов.
 *
 * Нужен, чтобы посчитать слот мэппинга для state-override: котировка кривой с
 * ERC20-парой невозможна без аллованса, а подменить его в eth_call можно только
 * зная слот keccak(ключ ‖ индекс).
 */

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// смещения rho по плоскому индексу x + 5y
const ROT = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n,
];

const rotl = (x, n) => n === 0n ? x : ((x << n) | (x >> (64n - n))) & MASK;

function keccakF(A) {
  const C = new Array(5), D = new Array(5), B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) A[x + 5 * y] ^= D[x];

    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++)
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);

    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++)
        A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y] & MASK);

    A[0] ^= RC[round];
  }
  return A;
}

/** keccak256 над Uint8Array -> Uint8Array(32). Ставка 136 байт, добивка 0x01…0x80. */
function keccak256Bytes(input) {
  const RATE = 136;
  const padLen = RATE - (input.length % RATE);
  const msg = new Uint8Array(input.length + padLen);
  msg.set(input);
  msg[input.length] |= 0x01;
  msg[msg.length - 1] |= 0x80;

  let A = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(msg[off + i * 8 + b]);
      A[i] ^= lane;
    }
    A = keccakF(A);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

const hexToBytes = (hex) => {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToHex = (b) =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** keccak256 над hex-строкой -> hex-строка. */
const keccak256 = (hex) => bytesToHex(keccak256Bytes(hexToBytes(hex)));

module.exports = { keccak256, keccak256Bytes, hexToBytes, bytesToHex };
