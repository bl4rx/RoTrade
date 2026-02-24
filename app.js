const $ = (id) => document.getElementById(id);

const state = {
  itemsById: new Map(), // id -> item
  offerIds: [],
  requestIds: [],
};

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function pctDiff(theirValue, yourValue) {
  // % relative to your side (common for "overpay" feel)
  if (!yourValue || yourValue <= 0) return null;
  return ((theirValue - yourValue) / yourValue) * 100;
}

function renderSide(listEl, totalsEl, ids, sideName) {
  listEl.innerHTML = "";

  let totalV = 0;
  let totalR = 0;

  ids.forEach((id, idx) => {
    const it = state.itemsById.get(String(id));
    if (!it) return;

    totalV += it.effectiveValue;
    totalR += it.rap;

    const row = document.createElement("div");
    row.className = "item";

    row.innerHTML = `
      <div>
        <div><strong>${it.name}</strong> <span class="meta">(#${it.id})</span></div>
        <div class="meta">Value: ${fmt(it.effectiveValue)} • RAP: ${fmt(it.rap)}${it.projected ? " • ⚠ projected" : ""}</div>
      </div>
      <div>
        <button data-side="${sideName}" data-idx="${idx}">Remove</button>
      </div>
    `;
    listEl.appendChild(row);
  });

  totalsEl.textContent = `Total Value: ${fmt(totalV)} • Total RAP: ${fmt(totalR)}`;

  // Remove handlers
  listEl.querySelectorAll("button[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      if (Number.isFinite(idx)) {
        ids.splice(idx, 1);
        renderAll();
      }
    });
  });
}

function renderAll() {
  renderSide($("offerList"), $("offerTotals"), state.offerIds, "offer");
  renderSide($("requestList"), $("requestTotals"), state.requestIds, "request");
}

function addItemToSide(itemId, side) {
  const id = String(itemId).trim();
  if (!id) return;

  const it = state.itemsById.get(id);
  if (!it) {
    alert("Item not found in cache yet. Try searching first (or check the ID).");
    return;
  }

  if (side === "offer") state.offerIds.push(id);
  else state.requestIds.push(id);

  renderAll();
}

function renderSearchResults(items) {
  const box = $("searchResults");
  box.innerHTML = "";

  items.forEach((it) => {
    // store in map for quick add-by-id
    state.itemsById.set(String(it.id), it);

    const el = document.createElement("div");
    el.className = "item";

    el.innerHTML = `
      <div>
        <div><strong>${it.name}</strong> <span class="meta">(#${it.id})</span></div>
        <div class="meta">Value: ${fmt(it.effectiveValue)} • RAP: ${fmt(it.rap)}${it.projected ? " • ⚠ projected" : ""}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        <button data-add="offer" data-id="${it.id}">Add to Offer</button>
        <button data-add="request" data-id="${it.id}">Add to Request</button>
      </div>
    `;

    box.appendChild(el);
  });

  box.querySelectorAll("button[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      addItemToSide(btn.dataset.id, btn.dataset.add);
    });
  });
}

async function doSearch() {
  const q = $("searchInput").value.trim();
  const limit = Math.max(10, Math.min(2000, Number($("searchLimit").value || 80)));

  const url = new URL("/api/items", window.location.origin);
  if (q) url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url);
  const data = await res.json();

  if (!data.success) {
    alert(data.error || "Search failed");
    return;
  }

  renderSearchResults(data.items || []);
}

function renderSuggestionsBlock(title, entries, isCombo = false, targetValue = 0) {
  const wrap = document.createElement("div");
  wrap.className = "block";

  const h = document.createElement("div");
  h.innerHTML = `<strong>${title}</strong>`;
  wrap.appendChild(h);

  if (!entries || entries.length === 0) {
    const p = document.createElement("div");
    p.className = "small";
    p.textContent = "No results";
    wrap.appendChild(p);
    return wrap;
  }

  entries.forEach((x) => {
    const row = document.createElement("div");
    row.className = "item";

    let nameLine = "";
    let sumV = 0;
    let sumR = 0;
    let ids = [];

    if (isCombo) {
      const a = x.items[0];
      const b = x.items[1];
      ids = [a.id, b.id];
      sumV = x.sumValue;
      sumR = (a.rap || 0) + (b.rap || 0);
      nameLine = `${a.name} + ${b.name}`;
    } else {
      ids = [x.id];
      sumV = x.effectiveValue;
      sumR = x.rap || 0;
      nameLine = x.name;
    }

    const p = pctDiff(sumV, targetValue);
    const pTxt = p === null ? "" : ` • ${p >= 0 ? "+" : ""}${p.toFixed(2)}% vs your offer`;

    row.innerHTML = `
      <div>
        <div><strong>${nameLine}</strong></div>
        <div class="meta">Value: ${fmt(sumV)} • RAP: ${fmt(sumR)}${pTxt}</div>
        <div class="meta">${ids.map((id) => `#${id}`).join(" ")}</div>
      </div>
      <div>
        <button data-suggest-add="request" data-ids="${ids.join(",")}">Add to Their Items</button>
      </div>
    `;

    wrap.appendChild(row);
  });

  wrap.querySelectorAll("button[data-suggest-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ids = String(btn.dataset.ids || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      ids.forEach((id) => addItemToSide(id, "request"));
    });
  });

  return wrap;
}

async function doCalc() {
  const options = {
    tolerancePct: Number($("tolerancePct").value || 3),
    maxOverpayPct: Number($("maxOverpayPct").value || 10),
    maxResults: Number($("maxResults").value || 25),
    avoidProjected: $("avoidProjected").checked,
  };

  const res = await fetch("/api/calc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offerIds: state.offerIds,
      requestIds: state.requestIds,
      options,
    }),
  });

  const data = await res.json();
  if (!data.success) {
    alert(data.error || "Calculation failed");
    return;
  }

  const yourV = data.offer.totalValue;
  const theirV = data.request.totalValue;

  const p = pctDiff(theirV, yourV);
  const winLoss =
    p === null ? "N/A" : (p >= 0 ? `Win: +${p.toFixed(2)}%` : `Loss: ${p.toFixed(2)}%`);

  $("calcSummary").innerHTML = `
    <div><strong>Your total value:</strong> ${fmt(yourV)} • <strong>Their total value:</strong> ${fmt(theirV)}</div>
    <div class="small"><strong>Difference (their - yours):</strong> ${fmt(data.diff.value)} value • ${fmt(data.diff.rap)} RAP</div>
    <div class="small"><strong>${winLoss}</strong> (percentage uses your offer as baseline)</div>
  `;

  const sug = data.suggestions;
  const sugBox = $("suggestions");
  sugBox.innerHTML = "";

  sugBox.appendChild(renderSuggestionsBlock("Equal singles", sug.equalSingles, false, yourV));
  sugBox.appendChild(renderSuggestionsBlock("Better singles (small overpay)", sug.betterSingles, false, yourV));
  sugBox.appendChild(renderSuggestionsBlock("Equal 2-item combos", sug.equalCombos2, true, yourV));
  sugBox.appendChild(renderSuggestionsBlock("Better 2-item combos (small overpay)", sug.betterCombos2, true, yourV));
}

// UI wiring
$("searchBtn").addEventListener("click", doSearch);
$("addByIdBtn").addEventListener("click", () => {
  addItemToSide($("itemIdInput").value, $("sideSelect").value);
});

$("clearOfferBtn").addEventListener("click", () => {
  state.offerIds = [];
  renderAll();
});
$("clearRequestBtn").addEventListener("click", () => {
  state.requestIds = [];
  renderAll();
});

$("calcBtn").addEventListener("click", doCalc);

// initial warmup search (loads cache + gives something to click)
doSearch().catch(() => {});
