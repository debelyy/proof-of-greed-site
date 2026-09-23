#!/usr/bin/env python
"""
SERVER LEDGER FETCH — SIWE-логин в playmog.xyz и дамп того, что видит только
авторизованный игрок: недельная таблица гонки (top-100 + userStats по адресу),
живые недельный пул/джекпот/раффл. Пишет data/server.json + data/weekly.json.

Ключ: env POG_SIWE_KEY (для GitHub Actions secret) или data/.siwe-key.json (локально).
Аккаунт — выделенный фан-аккаунт проекта (создан 23.09, ник proofofgreed, без средств);
эндпоинты те же, что видит любой вошедший игрок; объём запросов — единицы на прогон.

Запуск: python scripts/fetch-server.py   (зависимость: pip install eth-account)
"""
import json, os, sys, datetime, http.cookiejar, urllib.request, urllib.error

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DATA = os.path.join(ROOT, "data")
BASE = "https://playmog.xyz"
CHAIN_ID = 2741  # Abstract mainnet
UA = {"User-Agent": "Mozilla/5.0 mog-server-ledger/1.0", "accept": "application/json, text/plain, */*",
      "Origin": BASE, "Referer": BASE + "/"}


def load_key():
    k = os.environ.get("POG_SIWE_KEY")
    if k and k.startswith("0x") and len(k) == 66:
        return k
    try:
        return json.load(open(os.path.join(DATA, ".siwe-key.json")))["key"]
    except Exception:
        return None


def login():
    """SIWE по флоу клиента: /api/auth/nonce → сообщение(statement+expiration) → /api/auth/verify."""
    from eth_account import Account
    from eth_account.messages import encode_defunct
    key = load_key()
    if not key:
        print("siwe: no key (POG_SIWE_KEY env or data/.siwe-key.json) — server ledger skipped")
        return None
    acct = Account.from_key(key)
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    nonce = opener.open(urllib.request.Request(BASE + "/api/auth/nonce", headers=UA), timeout=30).read().decode().strip()
    iso = lambda dt: dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    now = datetime.datetime.now(datetime.timezone.utc)
    # ровно как клиент (createSiweMessage): domain=host, uri=origin, statement, +7d expiration
    msg = (f"{BASE.split('//')[1]} wants you to sign in with your Ethereum account:\n{acct.address}\n\n"
           "Sign in with Ethereum to the app.\n"
           f"\nURI: {BASE}\nVersion: 1\nChain ID: {CHAIN_ID}\nNonce: {nonce}\nIssued At: {iso(now)}"
           f"\nExpiration Time: {iso(now + datetime.timedelta(days=7))}")
    signed = acct.sign_message(encode_defunct(text=msg))
    body = json.dumps({"message": msg, "signature": "0x" + signed.signature.hex(), "walletKind": "EXTERNAL"}).encode()
    r = opener.open(urllib.request.Request(BASE + "/api/auth/verify", data=body,
                                           headers={**UA, "Content-Type": "application/json"}), timeout=30)
    if r.status != 200:
        raise RuntimeError("siwe verify failed: " + str(r.status))
    print("siwe: logged in as " + acct.address)
    return opener


def get(opener, path):
    r = opener.open(urllib.request.Request(BASE + "/" + path, headers=UA), timeout=30)
    return json.loads(r.read().decode())


def user_stats(opener, addr):
    """userStats по ЛЮБОМУ адресу — то, чего нет на цепи (treasure/ранг/ключи недели)."""
    try:
        j = get(opener, "api/runs?mode=weekly&address=" + addr.lower())
        return {"weekNumber": j.get("weekNumber"), "totalPlayers": j.get("total"),
                "stats": j.get("userStats") or None}
    except Exception as e:
        print("userStats " + addr[:10] + " failed: " + str(e)[:60], file=sys.stderr)
        return None


def main():
    opener = login()
    if not opener:
        return 1
    week = get(opener, "api/runs?mode=weekly")
    raffle = get(opener, "api/raffle/status")
    jackpot = get(opener, "api/jackpot/pool")
    weekly_pool = get(opener, "api/weekly-pool")
    claims = get(opener, "api/claims")

    lb = week.get("leaderboard") or []
    out = {
        "t": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "weekNumber": week.get("weekNumber"),
        "weekStart": week.get("weekStart"), "weekEnd": week.get("weekEnd"),
        "totalPlayers": week.get("total"), "totalTreasure": week.get("totalGlobalTreasure"),
        "poolValor": int(weekly_pool.get("currentPoolValor") or 0),
        "raffle": {
            "weekNumber": raffle.get("weekNumber"), "globalEntries": raffle.get("globalEntries"),
            "totalEntrants": raffle.get("totalEntrants"), "drawTime": raffle.get("drawTime"),
        },
        "jackpot": {
            "balanceEth": int(jackpot.get("balanceWei") or 0) / 1e18,
            "totalPaidEth": int(jackpot.get("totalPaidWei") or 0) / 1e18,
            "poolValor": int(jackpot.get("poolValor") or 0),
        },
        "claims": {
            "weekNumber": (claims.get("currentWeek") or {}).get("weekNumber"),
            "poolValor": int((claims.get("currentWeek") or {}).get("pool") or 0),
            "totalTreasure": (claims.get("currentWeek") or {}).get("totalTreasure"),
            "claimsUnlockAt": claims.get("claimsUnlockAt"),
        },
        "top": [{"rank": r["rank"], "address": r["address"], "username": r.get("username"),
                 "treasure": r["treasure"], "runCount": r.get("runCount"), "totalKeysSpent": r.get("totalKeysSpent")}
                for r in lb[:100]],
    }
    with open(os.path.join(DATA, "server.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("server.json: wk#" + str(out["weekNumber"]) + " · top " + str(len(out["top"])) + " of " + str(out["totalPlayers"])
          + " · pool " + str(out["poolValor"]) + " VALOR · jackpot " + str(round(out["jackpot"]["balanceEth"], 2)) + " ETH"
          + " · raffle " + str(out["raffle"]["globalEntries"]) + " entries/" + str(out["raffle"]["totalEntrants"]) + " entrants")
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--stats"] and len(sys.argv) >= 3:
        # per-wallet bridge for the TG bot: prints {weekNumber, totalPlayers, stats} as JSON
        opener = login()
        s = user_stats(opener, sys.argv[2]) if opener else None
        print(json.dumps(s or {}))
        sys.exit(0)
    sys.exit(main())
