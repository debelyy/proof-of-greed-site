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
hall.totalsWk = hall.totalsWk || { fed: 0, hits: 0, cashed: 0 };
const state = readJson("state.json", { lastBlock: DEPLOY - 1 });
const startBlock = Math.max(state.lastBlock || 0, hall.lastBlock || 0, DEPLOY - 1);
const head = parseInt(await rpc("eth_blockNumber", []), 16);

// pools first: week number drives per-wallet weekly accumulators
let poolsJ = null;
try {
  const pr = await fetch(POOLS_API, { headers: { "User-Agent": "Mozilla/5.0 mog-data/1.0" }, signal: AbortSignal.timeout(30000) });
  poolsJ = await pr.json();
} catch (e) { console.log("pools fetch failed:", e.message); }
const wei = v => { try { return Number(BigInt(v ?? "0")) / 1e18; } catch { return 0; } };
const curWeek = poolsJ ? Number(poolsJ.weekNumber) : (hall.week || 0);
if (hall.week !== curWeek) {
  for (const w of Object.values(hall.wallets)) { w.wkFed = 0; w.wkHits = 0; w.wkCashed = 0; }
  hall.totalsWk = { fed: 0, hits: 0, cashed: 0 };
  hall.week = curWeek;
  hall.weekStartBlock = null;
}
// block where the current week began (weekEnd − 7d), binary-searched once per week
let weekStartBlock = hall.weekStartBlock || 0;
if (poolsJ && poolsJ.weekEnd && (!weekStartBlock || hall.weekStartBlockWeek !== curWeek)) {
  const ts = Math.floor((Date.parse(poolsJ.weekEnd) - 7 * 86400000) / 1000);
  const tsAt = async b => parseInt((await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false])).timestamp, 16);
  let lo = DEPLOY, hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await tsAt(mid) >= ts) hi = mid; else lo = mid + 1;
  }
  weekStartBlock = lo;
  hall.weekStartBlock = lo;
  hall.weekStartBlockWeek = curWeek;
}

let scanned = 0;
for (let from = Math.max(startBlock + 1, DEPLOY); from <= head; from += CHUNK) {
  const to = Math.min(from + CHUNK - 1, head);
  const logs = await getLogs(from, to);
  scanned += logs.length;
  for (const l of logs) {
    const t = l.topics[0], usd = word0(l);
    if (t !== SIG.DEP && t !== SIG.WD && t !== SIG.WIN) continue; // legacy/other vault events
    if (!l.topics[1]) continue;
    const a = who(l);
    const w = hall.wallets[a] || (hall.wallets[a] = { fed: 0, cashed: 0, hits: 0, big: 0, last: 0, fedE: 0, cashedE: 0, hitsE: 0, bigE: 0, wkFed: 0, wkHits: 0, wkCashed: 0 });
    const blk = parseInt(l.blockNumber, 16);
    w.last = blk;
    const inE = blk >= EVENT_BLOCK;
    const inW = blk >= weekStartBlock;
    if (t === SIG.DEP) { w.fed += usd; hall.totals.fed += usd; hall.totals.fedN++; if (inW) { w.wkFed += usd; hall.totalsWk.fed += usd; } if (inE) { w.fedE += usd; hall.totalsE.fed += usd; hall.totalsE.fedN++; } }
    else if (t === SIG.WD) { w.cashed += usd; hall.totals.cashed += usd; hall.totals.cashedN++; if (inW) { w.wkCashed += usd; hall.totalsWk.cashed += usd; } if (inE) { w.cashedE += usd; hall.totalsE.cashed += usd; hall.totalsE.cashedN++; } }
    else if (t === SIG.WIN) {
      w.hits += usd; hall.totals.hits += usd; hall.totals.hitsN++; if (usd > w.big) w.big = usd;
      if (inW) { w.wkHits += usd; hall.totalsWk.hits += usd; }
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
  totalsWk: Object.fromEntries(Object.entries(hall.totalsWk).map(([k, v]) => [k, r2(v)])),
  week: curWeek,
  lastBlock: head,
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
  wallets: Object.fromEntries(Object.keys(hall.wallets).sort().map(a => {
    const w = hall.wallets[a];
    return [a, { fed: r2(w.fed), cashed: r2(w.cashed), hits: r2(w.hits), fedE: r2(w.fedE), cashedE: r2(w.cashedE), hitsE: r2(w.hitsE), wkFed: r2(w.wkFed), wkHits: r2(w.wkHits), wkCashed: r2(w.wkCashed) }];
  })),
};
fs.writeFileSync(path.join(DATA, "hall.json"), JSON.stringify(out));
fs.writeFileSync(path.join(DATA, "state.json"), JSON.stringify(state));

if (poolsJ) {
  fs.writeFileSync(path.join(DATA, "pools.json"), JSON.stringify({
    t: new Date().toISOString(),
    weekNumber: Number(poolsJ.weekNumber), weekEnd: String(poolsJ.weekEnd),
    weeklyPoolUsd: Number(poolsJ.weeklyPoolValor ?? 0) / VALOR_PER_USD,
    bountyPoolUsd: Number(poolsJ.jackpotPoolValor ?? 0) / VALOR_PER_USD,
    bountyPoolEth: wei(poolsJ.jackpotPoolWei),
    totalDistributedEth: wei(poolsJ.totalDistributedWei),
    jackpotsPaidEth: wei(poolsJ.jackpotsPaidWei),
  }));
  const hist = readJson("pools_hist.json", { points: [], lastWeek: null, week: null });
  const wUsd = Number(poolsJ.weeklyPoolValor ?? 0) / VALOR_PER_USD;
  if (hist.week !== null && Number(poolsJ.weekNumber) !== hist.week && hist.points.length) {
    hist.lastWeek = { week: hist.week, paidUsd: r2(hist.points[hist.points.length - 1].w), at: new Date().toISOString() };
  }
  hist.week = Number(poolsJ.weekNumber);
  const lastPt = hist.points[hist.points.length - 1];
  if (!lastPt || Date.now() - lastPt.t > 120000) hist.points.push({ t: Date.now(), wk: hist.week, w: r2(wUsd), b: r2(Number(poolsJ.jackpotPoolValor ?? 0) / VALOR_PER_USD) });
  if (hist.points.length > 8000) hist.points = hist.points.slice(-8000);
  fs.writeFileSync(path.join(DATA, "pools_hist.json"), JSON.stringify(hist));
  console.log("pools.json + pools_hist.json updated");
} else {
  console.log("pools fetch failed — hist not touched");
}
console.log(`hall.json: ${Object.keys(out.wallets).length} wallets, scanned ${scanned} new events, head ${head}`);
