#!/usr/bin/env python3
"""Готовит api/v1/_data.json из конфигурации приложения.

API не ходит в индексатор: универсум пулов берётся из той же конфигурации,
которой торгует сайт, а отсев делает сам квотер — пул, который не может налить
запрошенный объём, возвращает paid != amountIn и выбывает. Так у эндпоинта нет
внешней зависимости, которая может лечь или залимитить нас в самый неудобный
момент.

    python3 inject/build_api_data.py
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = ROOT / "app" / "config.js"
OUT = ROOT / "api" / "v1" / "_data.json"


def block(name):
    """Достаёт значение `export const NAME = ...;` как JSON."""
    t = CFG.read_text(encoding="utf-8")
    m = re.search(r"export const " + name + r" = (\{.*?\n?\});", t, re.S)
    if not m:
        raise SystemExit(f"не нашёл {name} в {CFG}")
    return json.loads(m.group(1))


def scalar(name):
    t = CFG.read_text(encoding="utf-8")
    m = re.search(r"export const " + name + r" = (\{[^}]*\});", t, re.S)
    return json.loads(m.group(1)) if m else None


def main():
    tokens = block("TOKENS")
    facts = block("POOL_FACTS")
    keys = block("POOL_KEYS")
    venues = block("VENUES")
    chain = block("CHAIN")

    t = CFG.read_text(encoding="utf-8")
    addrs = {}
    for name in ("ROUTER", "QUOTER", "ROUTER_V4", "QUOTER_V4"):
        m = re.search(r"export const " + name + r' = \{ address: "(0x[0-9a-fA-F]{40})"', t)
        if m:
            addrs[name] = m.group(1)

    # Обратный указатель: адрес токена -> тикер. Нужен, чтобы по паре адресов
    # находить пулы, не перебирая словарь на каждый запрос.
    by_addr = {v["addr"].lower(): k for k, v in tokens.items()}

    data = {
        "chainId": chain["id"],
        "contracts": {
            "router": addrs.get("ROUTER"),
            "quoter": addrs.get("QUOTER"),
            "routerV4": addrs.get("ROUTER_V4"),
            "quoterV4": addrs.get("QUOTER_V4"),
            "treasury": "0xDfC6004E2a56de0e59007BFC4F3E3890a889af67",
            "v4PoolManager": chain.get("v4PoolManager"),
        },
        "tokens": {
            k: {"symbol": k, "name": v.get("name"), "decimals": v["decimals"],
                "address": v["addr"]}
            for k, v in tokens.items()
        },
        "bySymbolLower": {k.lower(): k for k in tokens},
        "byAddress": by_addr,
        "venues": {
            k: {"name": k, "kind": v.get("kind"), "executable": bool(v.get("executable"))}
            for k, v in venues.items()
        },
        # v3-семейство: пул -> два токена и комиссия
        "pools": {
            addr.lower(): {"token0": f["token0"].lower(), "token1": f["token1"].lower(),
                           "feePpm": f["feePpm"]}
            for addr, f in facts.items()
        },
        # v4: poolId -> ключ. Нероутируемые (хуки, плавающая ставка, нативный ETH)
        # выброшены здесь, а не в рантайме: их не должно быть видно и в API.
        "poolKeys": {
            pid: {
                "currency0": k["currency0"], "currency1": k["currency1"],
                "fee": k["fee"], "tickSpacing": k["tickSpacing"], "hooks": k["hooks"],
                "sym": k.get("sym"), "quote": k.get("quote"),
            }
            for pid, k in keys.items()
            if k.get("routable") and k["currency0"] != "0x" + "0" * 40
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: токенов {len(data['tokens'])}, "
          f"пулов v3 {len(data['pools'])}, ключей v4 {len(data['poolKeys'])}, "
          f"{OUT.stat().st_size // 1024}K")


if __name__ == "__main__":
    main()
