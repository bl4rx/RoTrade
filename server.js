import express from "express";

const app = express();
app.use(express.json());

/**
 * Rolimon’s Item Details endpoint
 * GET https://www.rolimons.com/itemapi/itemdetails
 * Rate limit: 1 request per minute (cached by Rolimon’s)
 */
const ROLIMONS_ITEMDETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";

let cache = {
  fetchedAt: 0,
  ttlMs: 65_000, // >= 60s to respect Rolimon's rate limit
  itemsById: null,
  itemsList: null,
};

function normalizeItem(id, arr) {
  // [Name, Acronym, Rap, Value, Default Value, Demand, Trend, Projected, Hyped, Rare]
  const name = arr[0];
  const rap = Number(arr[2] ?? 0);
  const value = Number(arr[3] ?? -1);
  const defaultValue = Number(arr[4] ?? 0);

  const demand = Number(arr[5] ?? -1);
  const trend = Number(arr[6] ?? -1);
  const projected = Number(arr[7] ?? -1);
  const hyped = Number(arr[8] ?? -1);
  const rare = Number(arr[9] ?? -1);

  const effectiveValue = value !== -1 ? value : defaultValue;

  return {
    id: String(id),
    name,
    rap,
    value,
    defaultValue,
    effectiveValue,
    demand,
    trend,
    projected: projected === 1,
    hyped: hyped === 1,
    rare: rare === 1,
  };
}

async function getRolimonsItemsCached() {
  const now = Date.now();
  if (cache.itemsById && (now - cache.fetchedAt) < cache.ttlMs) return cache;

  const res = await fetch(ROLIMONS_ITEMDETAILS_URL, {
    headers: { "User-Agent": "rotrade/1.0 (respect-rate-limit)" },
  });

  if (!res.ok) throw new Error(`Rolimons fetch failed: ${res.status} ${res.statusText}`);

  const data = await res.json();
  if (!data?.success || !data?.items) throw new Error("Unexpected Rolimons response shape");

  const itemsById = {};
  const itemsList = [];

  for (const [id, arr] of Object.entries(data.items)) {
    if (id === "Item ID") continue;
    if (!Array.isArray(arr)) continue;
    const item = normalizeItem(id, arr);
    itemsById[item.id] = item;
    itemsList.push(item);
  }

  itemsList.sort((a, b) => (b.effectiveValue - a.effectiveValue));
  cache = { ...cache, fetchedAt: now, itemsById, itemsList };
  return cache;
}

function sumTrade(itemsById, ids) {
  let totalValue = 0;
  let totalRap = 0;
  const picked = [];

  for (const id of ids) {
    const it = itemsById[String(id)];
    if (!it) continue;
    totalValue += it.effectiveValue;
    totalRap += it.rap;
    picked.push(it);
  }
  return { totalValue, totalRap, picked };
}

function suggest(itemsList, targetValue, opts) {
  const { tolerancePct = 3, maxOverpayPct = 10, maxResults = 25, avoidProjected = true } = opts || {};

  const tol = (tolerancePct / 100) * targetValue;
  const minEqual = Math.max(0, Math.floor(targetValue - tol));
  const maxEqual = Math.ceil(targetValue + tol);

  const maxOverpay = Math.ceil(targetValue * (maxOverpayPct / 100));
  const maxBetter = targetValue + maxOverpay;

  const eligible = itemsList.filter((it) => {
    if (avoidProjected && it.projected) return false;
    if (!Number.isFinite(it.effectiveValue) || it.effectiveValue <= 0) return false;
    return true;
  });

  const equalSingles = [];
  const betterSingles = [];

  for (const it of eligible) {
    if (it.effectiveValue >= minEqual && it.effectiveValue <= maxEqual) equalSingles.push(it);
    else if (it.effectiveValue > targetValue && it.effectiveValue <= maxBetter) betterSingles.push(it);
  }

  equalSingles.sort((a, b) => Math.abs(a.effectiveValue - targetValue) - Math.abs(b.effectiveValue - targetValue));
  betterSingles.sort((a, b) => (a.effectiveValue - targetValue) - (b.effectiveValue - targetValue));

  const K = 700;
  const candidates = eligible.slice(0, K);

  const equalCombos2 = [];
  const betterCombos2 = [];

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    for (let j = i; j < candidates.length; j++) {
      const b = candidates[j];
      const sum = a.effectiveValue + b.effectiveValue;

      if (sum >= minEqual && sum <= maxEqual) {
        equalCombos2.push({ items: [a, b], sumValue: sum, diff: Math.abs(sum - targetValue) });
      } else if (sum > targetValue && sum <= maxBetter) {
        betterCombos2.push({ items: [a, b], sumValue: sum, diff: sum - targetValue });
      }
    }
  }

  equalCombos2.sort((x, y) => x.diff - y.diff);
  betterCombos2.sort((x, y) => x.diff - y.diff);

  return {
    equalSingles: equalSingles.slice(0, maxResults),
    betterSingles: betterSingles.slice(0, maxResults),
    equalCombos2: equalCombos2.slice(0, maxResults),
    betterCombos2: betterCombos2.slice(0, maxResults),
    meta: { targetValue, minEqual, maxEqual, maxBetter, tolerancePct, maxOverpayPct, avoidProjected },
  };
}

// Routes
app.get("/api/health", (_, res) => res.json({ ok: true }));

app.get("/api/items", async (req, res) => {
  try {
    const { itemsList, fetchedAt, ttlMs } = await getRolimonsItemsCached();
    const q = String(req.query.q || "").toLowerCase().trim();
    const limit = Math.min(Number(req.query.limit || 200), 2000);

    let out = itemsList;
    if (q) out = itemsList.filter((it) => it.name.toLowerCase().includes(q) || it.id === q);

    res.json({ success: true, fetchedAt, cacheTtlMs: ttlMs, count: out.length, items: out.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/calc", async (req, res) => {
  try {
    const { offerIds = [], requestIds = [], options = {} } = req.body || {};
    const { itemsById, itemsList } = await getRolimonsItemsCached();

    const offer = sumTrade(itemsById, offerIds);
    const request = sumTrade(itemsById, requestIds);

    const diffValue = request.totalValue - offer.totalValue;
    const diffRap = request.totalRap - offer.totalRap;

    const suggestions = suggest(itemsList, offer.totalValue, options);

    res.json({ success: true, offer, request, diff: { value: diffValue, rap: diffRap }, suggestions });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Serve frontend
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
