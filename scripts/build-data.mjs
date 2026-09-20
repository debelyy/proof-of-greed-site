#!/usr/bin/env node
/**
 * MOG DATA PIPELINE — инкрементальный скан vault + пулы playmog → data/*.json.
 * Крутится в GitHub Actions раз в час (и локально), бэкенда у сайта нет:
 * страница просто читает готовые JSON рядом с собой.
 *
 * Запуск: node scripts/build-data.mjs   (Node >= 18, без зависимостей)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");

const RPC = "https://api.mainnet.abs.xyz";
const POOLS_API = "https://playmog.xyz/api/public/pools";
const VAULT = "0x2DDF2129a55cF132E580cc5d69faD1dE3d213BbA";
const DEPLOY = 60015914;
const SIG = {
  DEP: "0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca",
  WD: "0x33b093f4084754fd5547839fa67cdec248c92cc9d7df48b7f519049b9c15744f",
  WIN: "0xddb801b4a8a9df6a5c9beb0dfdde647b955a35f734f28af5c6532df875638471",
};
const CHUNK = 100_000;
const VALOR_PER_USD = 100;
const EVENT_BLOCK = 84166603; // Deed Season start: 17.09.2026 16:00:00 UTC

let rpcId = 0;
async function rpc(method, params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(s => setTimeout(s, 500 * (i + 1)));
    }
  }
}
async function getLogs(from, to) {
  try {
    return await rpc("eth_getLogs", [{ address: VAULT, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  } catch (e) {
    if (/10000 results/i.test(String(e.message)) && to > from) {
      const mid = Math.floor((from + to) / 2);
      return [...await getLogs(from, mid), ...await getLogs(mid + 1, to)];
    }
    throw e;
  }
}
const word0 = l => parseInt(l.data.slice(2, 66) || "0", 16) / 1e6;
const who = l => "0x" + l.topics[1].slice(-40);

const readJson = (f, def) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch { return def; }
};
fs.mkdirSync(DATA, { recursive: true });

const hall = readJson("hall.json", { wallets: {}, totals: { fed: 0, cashed: 0, hits: 0, fedN: 0, cashedN: 0, hitsN: 0 }, totalsE: { fed: 0, cashed: 0, hits: 0, fedN: 0, cashedN: 0, hitsN: 0 } });
hall.totalsE = hall.totalsE || { fed: 0, cashed: 0, hits: 0, fedN: 0, cashedN: 0, hitsN: 0 };
const state = readJson("state.json", { lastBlock: DEPLOY - 1 });
const head = parseInt(await rpc("eth_blockNumber", []), 16);

let scanned = 0;
for (let from = Math.max(state.lastBlock + 1, DEPLOY); from <= head; from += CHUNK) {
  const to = Math.min(from + CHUNK - 1, head);
  const logs = await getLogs(from, to);
  scanned += logs.length;
  for (const l of logs) {
    const t = l.topics[0], usd = word0(l);
    if (t !== SIG.DEP && t !== SIG.WD && t !== SIG.WIN) continue; // legacy/other vault events
    if (!l.topics[1]) continue;
    const a = who(l);
    const w = hall.wallets[a] || (hall.wallets[a] = { fed: 0, cashed: 0, hits: 0, big: 0, last: 0, fedE: 0, cashedE: 0, hitsE: 0, bigE: 0 });
    const blk = parseInt(l.blockNumber, 16);
    w.last = blk;
    const inE = blk >= EVENT_BLOCK;
    if (t === SIG.DEP) { w.fed += usd; hall.totals.fed += usd; hall.totals.fedN++; if (inE) { w.fedE += usd; hall.totalsE.fed += usd; hall.totalsE.fedN++; } }
    else if (t === SIG.WD) { w.cashed += usd; hall.totals.cashed += usd; hall.totals.cashedN++; if (inE) { w.cashedE += usd; hall.totalsE.cashed += usd; hall.totalsE.cashedN++; } }
    else if (t === SIG.WIN) {
      w.hits += usd; hall.totals.hits += usd; hall.totals.hitsN++; if (usd > w.big) w.big = usd;
      if (inE) { w.hitsE += usd; hall.totalsE.hits += usd; hall.totalsE.hitsN++; if (usd > w.bigE) w.bigE = usd; }
    }
  }
  state.lastBlock = to;
  process.stderr.write(`\rscanned → block ${to.toLocaleString("en-US")} (${scanned} events)`);
}
process.stderr.write("\n");

const r2 = x => Math.round(x * 100) / 100;
const top = (pick, n = 10) => Object.entries(hall.wallets)
  .map(([a, w]) => ({ a, v: r2(pick(w)), fed: r2(w.fed), cashed: r2(w.cashed), hits: r2(w.hits), big: r2(w.big) }))
  .sort((x, y) => y.v - x.v).slice(0, n);
const topE = (pick, n = 10) => Object.entries(hall.wallets)
  .filter(([, w]) => (w.fedE || w.cashedE || w.hitsE))
  .map(([a, w]) => ({ a, v: r2(pick(w)), fed: r2(w.fedE), cashed: r2(w.cashedE), hits: r2(w.hitsE), big: r2(w.bigE) }))
  .sort((x, y) => y.v - x.v).slice(0, n);
const out = {
  t: new Date().toISOString(),
  sinceBlock: DEPLOY,
  eventBlock: EVENT_BLOCK,
  headBlock: head,
  totals: Object.fromEntries(Object.entries(hall.totals).map(([k, v]) => [k, r2(v)])),
  totalsE: Object.fromEntries(Object.entries(hall.totalsE).map(([k, v]) => [k, r2(v)])),
  tops: {
    net: top(w => w.cashed - w.fed),
    hits: top(w => w.hits),
    fed: top(w => w.fed),
  },
  topsE: {
    net: topE(w => w.cashedE - w.fedE),
    hits: topE(w => w.hitsE),
    fed: topE(w => w.fedE),
  },
  wallets: Object.fromEntries(Object.keys(hall.wallets).sort().map(a => [a, hall.wallets[a]])),
};
fs.writeFileSync(path.join(DATA, "hall.json"), JSON.stringify(out));
fs.writeFileSync(path.join(DATA, "state.json"), JSON.stringify(state));

try {
  const p = await fetch(POOLS_API, { headers: { "User-Agent": "Mozilla/5.0 mog-data/1.0" } });
  const j = await p.json();
  fs.writeFileSync(path.join(DATA, "pools.json"), JSON.stringify({
    t: new Date().toISOString(),
    weekNumber: j.weekNumber, weekEnd: j.weekEnd,
    weeklyPoolUsd: Number(j.weeklyPoolValor ?? 0) / VALOR_PER_USD,
    bountyPoolUsd: Number(j.jackpotPoolValor ?? 0) / VALOR_PER_USD,
    bountyPoolEth: Number(BigInt(j.jackpotPoolWei ?? "0")) / 1e18,
    totalDistributedEth: Number(BigInt(j.totalDistributedWei ?? "0")) / 1e18,
    jackpotsPaidEth: Number(BigInt(j.jackpotsPaidWei ?? "0")) / 1e18,
  }));
  console.log("pools.json updated");
} catch (e) {
  console.log("pools fetch failed:", e.message);
}
console.log(`hall.json: ${Object.keys(out.wallets).length} wallets, scanned ${scanned} new events, head ${head}`);
