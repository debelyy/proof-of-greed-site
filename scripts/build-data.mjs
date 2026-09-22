#!/usr/bin/env node
/**
 * MOG DATA PIPELINE — инкрементальный скан vault + пулы playmog → data/*.json.
 * Крутится в GitHub Actions по крону каждые 10 минут (best-effort: GH может разряжать
 * schedule, свежесть честно показана на сайте) и локально; бэкенда у сайта нет:
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
const CLAIM = "0x40018Cbb1926dae72DCb315E89AAB7320A191D02"; // pays ETH bounties+jackpots on-chain since game launch (verified: full-history claims ≈ playmog totalDistributedEth within 1%)
const DEPLOY = 60015914;
const GAME_START = 38280364; // first claim event = on-chain game launch (03.02.2026); backfill scans keys+claims from here
const SIG = {
  DEP: "0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca",
  WD: "0x33b093f4084754fd5547839fa67cdec248c92cc9d7df48b7f519049b9c15744f",
  WIN: "0xddb801b4a8a9df6a5c9beb0dfdde647b955a35f734f28af5c6532df875638471",
  CLAIM_B: "0x1ddd787c0b3d99344f6639d640b2d991e29512c85c952d530fbbe953328fb9c7", // (player, ethWei) bounty/gem payout
  CLAIM_J: "0x05b8b3cb6d59baf0ddb206b0927090ec793e2eab7bf5cf0d61a1d8db7f3f3362", // (player, ethWei) jackpot payout
};
// key shops: current USDC/ETH shop (77.9M→head) + legacy ETH shop (0.001 ETH/key, ≥38.5M→77.9M, counted at $1 face; pre-DEPLOY buys backfilled — true lifetime); KeysPurchased(buyer, qty, pricePerKey, totalPaid)
const KEY_SHOPS = ["0x3ef14148603202C0225eDFFcFdCcF3E68E5F5E03", "0xBDE2483b242C266a97E39826b2B5B3c06FC02916"];
const KP = "0x404d1f54ee326d5c061a2c9116c429c3dd776456700e045b563d2f68bea27089";
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
async function getLogs(from, to, address = [VAULT, ...KEY_SHOPS, CLAIM]) {
  try {
    return await rpc("eth_getLogs", [{ address, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  } catch (e) {
    if (/10000 results/i.test(String(e.message)) && to > from) {
      const mid = Math.floor((from + to) / 2);
      return [...await getLogs(from, mid, address), ...await getLogs(mid + 1, to, address)];
    }
    throw e;
  }
}
const word0 = l => parseInt(l.data.slice(2, 66) || "0", 16) / 1e6;
// deposit USD: word0 = USDC raw (1e6); VALOR-funded deposits carry word0=0, word1 = VALOR raw (1e6, 100 VALOR = $1)
const depUsd = l => { const w0 = parseInt(l.data.slice(2, 66) || "0", 16); return w0 > 0 ? w0 / 1e6 : parseInt(l.data.slice(66, 130) || "0", 16) / 1e8; };
// KeysPurchased: current shop pricePerKey=1e6 (USDC, totalPaid=word2); legacy ETH shop pricePerKey=1e15 wei (0.001 ETH) — counted at $1/key face
const kpUsd = l => parseInt(l.data.slice(66, 130) || "0", 16) > 1e12 ? parseInt(l.data.slice(2, 66) || "0", 16) : parseInt(l.data.slice(130, 194) || "0", 16) / 1e6;
const who = l => "0x" + l.topics[1].slice(-40);

const readJson = (f, def) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch { return def; }
};
fs.mkdirSync(DATA, { recursive: true });

const hall = readJson("hall.json", { wallets: {}, totals: { fed: 0, cashed: 0, hits: 0, fedN: 0, cashedN: 0, hitsN: 0 }, totalsE: { fed: 0, cashed: 0, hits: 0, fedN: 0, cashedN: 0, hitsN: 0 } });
hall.totalsE = hall.totalsE || { fed: 0, cashed: 0, hits: 0, fedN: 0, cashedN: 0, hitsN: 0 };
hall.totalsWk = hall.totalsWk || { fed: 0, hits: 0, cashed: 0 };
for (const tt of [hall.totals, hall.totalsE]) { tt.keys = tt.keys || 0; tt.keysN = tt.keysN || 0; tt.eth = tt.eth || 0; tt.ethN = tt.ethN || 0; }
hall.totalsWk.keys = hall.totalsWk.keys || 0;
for (const w of Object.values(hall.wallets)) { w.keys = w.keys || 0; w.keysE = w.keysE || 0; w.wkKeys = w.wkKeys || 0; w.big = w.big || 0; w.bigE = w.bigE || 0; w.last = w.last || 0; w.eth = w.eth || 0; w.ethE = w.ethE || 0; }
const state = readJson("state.json", { lastBlock: DEPLOY - 1 });
const startBlock = Math.max(state.lastBlock || 0, hall.lastBlock || 0, DEPLOY - 1);
const head = parseInt(await rpc("eth_blockNumber", []), 16);

// resumable one-time backfill (capped chunks/run so the GH 20-min timeout can never loop it):
// phase "kp"     — legacy-shop key buys GAME_START→DEPLOY (true lifetime fed, $1 face)
// phase "claims" — claim-vault ETH payouts GAME_START→lastBlock (bounties + jackpots)
if (state.bf2 !== "done") {
  const bf = state.bf2 && typeof state.bf2 === "object" ? state.bf2 : { phase: "kp", from: GAME_START };
  const CAP = 120; // 100k-block chunks per run
  let done = 0;
  const addWallet = a => hall.wallets[a] || (hall.wallets[a] = { fed: 0, keys: 0, cashed: 0, hits: 0, big: 0, last: 0, fedE: 0, keysE: 0, cashedE: 0, hitsE: 0, bigE: 0, wkFed: 0, wkKeys: 0, wkHits: 0, wkCashed: 0, eth: 0, ethE: 0 });
  while (done < CAP) {
    const target = bf.phase === "kp" ? DEPLOY - 1 : Math.min(state.lastBlock || head, head);
    if (bf.from > target) {
      if (bf.phase === "kp") { bf.phase = "claims"; bf.from = GAME_START; continue; }
      state.bf2 = "done"; break;
    }
    const to = Math.min(bf.from + CHUNK - 1, target);
    const logs = await getLogs(bf.from, to, [bf.phase === "kp" ? KEY_SHOPS[1] : CLAIM]);
    for (const l of logs) {
      if (!l.topics[1]) continue;
      const a = who(l);
      const w = addWallet(a);
      const blk = parseInt(l.blockNumber, 16);
      w.last = Math.max(w.last, blk);
      if (bf.phase === "kp" && l.topics[0] === KP) {
        const usd = kpUsd(l);
        w.fed += usd; hall.totals.fed += usd; hall.totals.fedN++;
        w.keys += usd; hall.totals.keys += usd; hall.totals.keysN++;
      } else if (bf.phase === "claims" && (l.topics[0] === SIG.CLAIM_B || l.topics[0] === SIG.CLAIM_J)) {
        const eth = parseInt(l.data.slice(2, 66) || "0", 16) / 1e18;
        w.eth += eth; hall.totals.eth += eth; hall.totals.ethN++;
        if (blk >= EVENT_BLOCK) { w.ethE += eth; hall.totalsE.eth += eth; hall.totalsE.ethN++; }
      }
    }
    bf.from = to + 1;
    done++;
  }
  if (state.bf2 !== "done") state.bf2 = bf;
  console.log("backfill:", state.bf2 === "done" ? "done" : JSON.stringify(state.bf2));
}

// pools first: week number drives per-wallet weekly accumulators
let poolsJ = null;
try {
  const pr = await fetch(POOLS_API, { headers: { "User-Agent": "Mozilla/5.0 mog-data/1.0" }, signal: AbortSignal.timeout(30000) });
  poolsJ = await pr.json();
  // shape guard: a renamed field must not silently publish $0 pools as if real
  if (poolsJ && (poolsJ.weeklyPoolValor == null || poolsJ.weekNumber == null || poolsJ.weekEnd == null)) {
    console.log("pools payload missing expected fields — ignoring this fetch");
    poolsJ = null;
  }
} catch (e) { console.log("pools fetch failed:", e.message); }
const wei = v => { try { return Number(BigInt(v ?? "0")) / 1e18; } catch { return 0; } };
const curWeek = poolsJ ? Number(poolsJ.weekNumber) : (hall.week || 0);
if (hall.week !== curWeek) {
  for (const w of Object.values(hall.wallets)) { w.wkFed = 0; w.wkKeys = 0; w.wkHits = 0; w.wkCashed = 0; }
  hall.totalsWk = { fed: 0, keys: 0, hits: 0, cashed: 0 };
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
    const t = l.topics[0];
    if (t !== SIG.DEP && t !== SIG.WD && t !== SIG.WIN && t !== KP && t !== SIG.CLAIM_B && t !== SIG.CLAIM_J) continue; // legacy/other vault events
    if (!l.topics[1]) continue;
    const usd = t === SIG.DEP ? depUsd(l) : t === KP ? kpUsd(l) : word0(l);
    const a = who(l);
    const w = hall.wallets[a] || (hall.wallets[a] = { fed: 0, keys: 0, cashed: 0, hits: 0, big: 0, last: 0, fedE: 0, keysE: 0, cashedE: 0, hitsE: 0, bigE: 0, wkFed: 0, wkKeys: 0, wkHits: 0, wkCashed: 0, eth: 0, ethE: 0 });
    const blk = parseInt(l.blockNumber, 16);
    w.last = blk;
    const inE = blk >= EVENT_BLOCK;
    const inW = weekStartBlock > 0 && blk >= weekStartBlock;
    if (t === SIG.CLAIM_B || t === SIG.CLAIM_J) {
      const eth = parseInt(l.data.slice(2, 66) || "0", 16) / 1e18;
      w.eth += eth; hall.totals.eth += eth; hall.totals.ethN++;
      if (inE) { w.ethE += eth; hall.totalsE.eth += eth; hall.totalsE.ethN++; }
    }
    else if (t === SIG.DEP || t === KP) {
      w.fed += usd; hall.totals.fed += usd; hall.totals.fedN++;
      if (t === KP) { w.keys += usd; hall.totals.keys += usd; hall.totals.keysN++; }
      if (inW) { w.wkFed += usd; hall.totalsWk.fed += usd; if (t === KP) { w.wkKeys += usd; hall.totalsWk.keys += usd; } }
      if (inE) { w.fedE += usd; hall.totalsE.fed += usd; hall.totalsE.fedN++; if (t === KP) { w.keysE += usd; hall.totalsE.keys += usd; hall.totalsE.keysN++; } }
    }
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
// ETH spot to value claim payouts in the tops (public CoinGecko; 0 on failure → tops stay cash-only)
let ethSpot = 0;
try {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { headers: { "User-Agent": "Mozilla/5.0 mog-data/1.0" }, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j && j.ethereum && j.ethereum.usd > 0) ethSpot = j.ethereum.usd;
} catch (e) { console.log("eth spot fetch failed:", e.message); }
const top = (pick, n = 10) => Object.entries(hall.wallets)
  .map(([a, w]) => ({ a, v: r2(pick(w)), fed: r2(w.fed), cashed: r2(w.cashed), hits: r2(w.hits), big: r2(w.big), eth: r2(w.eth || 0) }))
  .sort((x, y) => y.v - x.v).slice(0, n);
const topE = (pick, n = 10) => Object.entries(hall.wallets)
  .filter(([, w]) => (w.fedE || w.cashedE || w.hitsE || w.ethE))
  .map(([a, w]) => ({ a, v: r2(pick(w)), fed: r2(w.fedE), cashed: r2(w.cashedE), hits: r2(w.hitsE), big: r2(w.bigE), eth: r2(w.ethE || 0) }))
  .sort((x, y) => y.v - x.v).slice(0, n);
const out = {
  t: new Date().toISOString(),
  sinceBlock: GAME_START,
  eventBlock: EVENT_BLOCK,
  headBlock: head,
  ethSpot,
  totals: Object.fromEntries(Object.entries(hall.totals).map(([k, v]) => [k, r2(v)])),
  totalsE: Object.fromEntries(Object.entries(hall.totalsE).map(([k, v]) => [k, r2(v)])),
  totalsWk: Object.fromEntries(Object.entries(hall.totalsWk).map(([k, v]) => [k, r2(v)])),
  week: curWeek,
  lastBlock: head,
  tops: {
    net: top(w => w.cashed - w.fed + (w.eth || 0) * ethSpot),
    hits: top(w => w.hits),
    fed: top(w => w.fed),
  },
  topsE: {
    net: topE(w => w.cashedE - w.fedE + (w.ethE || 0) * ethSpot),
    hits: topE(w => w.hitsE),
    fed: topE(w => w.fedE),
  },
  wallets: Object.fromEntries(Object.keys(hall.wallets).sort().map(a => {
    const w = hall.wallets[a];
    return [a, { fed: r2(w.fed), keys: r2(w.keys || 0), cashed: r2(w.cashed), hits: r2(w.hits), big: r2(w.big || 0), last: w.last || 0, eth: r2(w.eth || 0), fedE: r2(w.fedE), keysE: r2(w.keysE || 0), cashedE: r2(w.cashedE), hitsE: r2(w.hitsE), bigE: r2(w.bigE || 0), ethE: r2(w.ethE || 0), wkFed: r2(w.wkFed), wkKeys: r2(w.wkKeys || 0), wkHits: r2(w.wkHits), wkCashed: r2(w.wkCashed) }];
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

// game's own server-side event dashboard (public PostHog share link) — quantifies what the chain
// cannot see: arcade keys by source (Robinhood-chain relay buys leave no Abstract trace, verified
// 22.09: on-chain season KP ≈ the "Abstract" bucket only) and gems the server paid (≈4x the vault WIN credits)
try {
  const ins = async id => {
    const r = await fetch(`https://us.posthog.com/api/environments/569134/insights/${id}/?from_dashboard=2114550&sharing_access_token=i2BtIlfGANozI7OO_cm1rIA2JKbPGg`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error("insight " + id + ": HTTP " + r.status);
    const j = await r.json();
    if (!Array.isArray(j.result)) throw new Error("insight " + id + ": no result");
    return j.result;
  };
  const ks = await ins(12041385); // keys purchased by source, since season start
  const gem = await ins(12040502); // gems paid, cumulative USD by day
  const row = (a, k) => { const r = a.find(x => x[0] === k); return r ? Number(r[1]) : 0; };
  const keysAbstract = row(ks, "Abstract"), keysRobinhood = row(ks, "Robinhood");
  const gemsPaidUsd = gem.length ? Number(gem[gem.length - 1][1]) : 0;
  if (keysAbstract + keysRobinhood + gemsPaidUsd > 0) {
    fs.writeFileSync(path.join(DATA, "posthog.json"), JSON.stringify({
      t: new Date().toISOString(),
      keysAbstract, keysRobinhood, keysTotal: keysAbstract + keysRobinhood,
      gemsPaidUsd, gemsAt: gem.length ? String(gem[gem.length - 1][0]) : null,
    }));
    console.log("posthog.json: keys " + (keysAbstract + keysRobinhood).toLocaleString("en-US") + " (robinhood " + keysRobinhood.toLocaleString("en-US") + ") · gems paid $" + gemsPaidUsd);
  } else console.log("posthog payload empty — file not touched");
} catch (e) { console.log("posthog fetch failed:", e.message); }
console.log(`hall.json: ${Object.keys(out.wallets).length} wallets, scanned ${scanned} new events, head ${head}`);
