// Maknoon POS (Beta). A merchant point-of-sale that:
//   1. takes an amount (fiat-first, flippable to crypto),
//   2. verifies a SEPARATE customer's credential cross-device via
//      window.maknoon.identity.collect (sanctions check by default, or
//      passport attributes),
//   3. receives payment on the configured network via
//      window.maknoon.payment.receive (multi-chain QR + on-chain auto-detect),
//   4. records the sale (datetime, crypto + fiat-at-time, tx, trusted badge).
//
// All camera/QR/signing/verification happen in native Maknoon sheets; this
// page only orchestrates. Settings + receipts persist via window.maknoon.storage.

"use strict";

const SANCTIONS_SCHEMA = "elabify://schema/global/musnadMaknoon/v1";
const PASSPORT_SCHEMA = "elabify://schema/global/passport/v1";
const ONE_YEAR = 365 * 24 * 60 * 60;

// Networks (the coin/chain family) and their chains (sub-networks).
// rawValues match the native enums.
// Listed alphabetically by label.
const FAMILIES = [
  { chain: "bitcoin", label: "Bitcoin", chains: [
    { network: "mainnet",  label: "Mainnet", ticker: "BTC" },
    { network: "testnet3", label: "Testnet", ticker: "tBTC" },
  ]},
  { chain: "lightning", label: "Bitcoin Lightning", chains: [
    { network: "lightning", label: "Lightning", ticker: "sats" },
  ]},
  { chain: "ethereum", label: "Ethereum", chains: [
    { network: "sepolia",  label: "Sepolia",      ticker: "ETH" },
    { network: "mainnet",  label: "Mainnet",      ticker: "ETH" },
    { network: "base",     label: "Base",         ticker: "ETH" },
    { network: "arbitrum", label: "Arbitrum One", ticker: "ETH" },
    { network: "polygon",  label: "Polygon",      ticker: "POL" },
  ]},
  { chain: "solana", label: "Solana", chains: [
    { network: "mainnet", label: "Mainnet", ticker: "SOL" },
    { network: "devnet",  label: "Devnet",  ticker: "SOL" },
  ]},
  { chain: "tron", label: "Tron", chains: [
    { network: "mainnet", label: "Mainnet", ticker: "TRX" },
    { network: "nile",    label: "Nile",    ticker: "TRX" },
  ]},
];

const $ = (s) => document.querySelector(s);
const has = () => !!(window.maknoon);

const state = {
  digits: "0",          // raw entry string
  inputIsFiat: true,    // fiat-first by default
  famIndex: 0,          // selected network family
  chainIndex: 0,        // selected chain within the family
  address: null,
  addressName: null,
  capture: "sanctions", // or "passport"
  passportAttrs: ["givenName", "familyName", "nationality"],
  rate: null,           // fiat per 1 coin (null => no fiat)
  fiatCode: "USD",
};

function fam() { return FAMILIES[state.famIndex]; }
function isLightning() { return fam().chain === "lightning"; }
// Flattened current selection: { chain, network, ticker, label }.
function net() {
  const f = fam();
  const c = f.chains[state.chainIndex] || f.chains[0];
  return { chain: f.chain, network: c.network, ticker: c.ticker, label: `${f.label} · ${c.label}` };
}

// --- persistence ----------------------------------------------------------
async function loadSettings() {
  try {
    const raw = await window.maknoon.storage.getItem("settings");
    if (raw) {
      const s = JSON.parse(raw);
      const fi = FAMILIES.findIndex((f) => f.chain === s.chain);
      if (fi >= 0) {
        state.famIndex = fi;
        const ci = FAMILIES[fi].chains.findIndex((c) => c.network === s.network);
        state.chainIndex = ci >= 0 ? ci : 0;
      }
      state.address = s.address || null;
      state.addressName = s.addressName || null;
      state.capture = s.capture || "sanctions";
      if (Array.isArray(s.passportAttrs)) state.passportAttrs = s.passportAttrs;
    }
  } catch (e) { /* defaults */ }
}
async function saveSettings() {
  const s = {
    chain: net().chain, network: net().network,
    address: state.address, addressName: state.addressName,
    capture: state.capture, passportAttrs: state.passportAttrs,
  };
  try { await window.maknoon.storage.setItem("settings", JSON.stringify(s)); } catch (e) {}
}

async function loadTx() {
  try { return JSON.parse((await window.maknoon.storage.getItem("txlog")) || "[]"); }
  catch (e) { return []; }
}
async function appendTx(entry) {
  const list = await loadTx();
  list.unshift(entry);
  try { await window.maknoon.storage.setItem("txlog", JSON.stringify(list.slice(0, 200))); } catch (e) {}
}

// --- fiat / amount --------------------------------------------------------
async function refreshRate() {
  state.rate = null;
  try {
    const q = await window.maknoon.fiat.quote({ chain: net().chain, network: net().network });
    state.fiatCode = q.fiatCode || "USD";
    state.rate = (typeof q.rate === "number") ? q.rate : null;
  } catch (e) {}
  // No rate (e.g. testnet) -> force crypto entry.
  if (state.rate == null) state.inputIsFiat = false;
  renderAmount();
}

function enteredNumber() { return parseFloat(state.digits || "0") || 0; }

// Returns { crypto, fiat } numeric amounts for the current entry.
// For Lightning, `crypto` is in sats (the rate is fiat-per-BTC).
function amounts() {
  const v = enteredNumber();
  if (isLightning()) {
    if (state.inputIsFiat) {
      const sats = state.rate ? Math.round((v / state.rate) * 1e8) : 0;
      return { fiat: v, crypto: sats };
    } else {
      const sats = Math.round(v);
      const fiat = state.rate ? (sats / 1e8) * state.rate : null;
      return { fiat, crypto: sats };
    }
  }
  if (state.inputIsFiat) {
    const crypto = state.rate ? v / state.rate : 0;
    return { fiat: v, crypto };
  } else {
    const fiat = state.rate ? v * state.rate : null;
    return { fiat, crypto: v };
  }
}

function fmt(n, dp) { return (n || 0).toLocaleString(undefined, { maximumFractionDigits: dp }); }

function renderAmount() {
  const a = amounts();
  $("#unit").textContent = state.inputIsFiat ? fiatSymbol(state.fiatCode) : "";
  $("#amountLabel").textContent = state.inputIsFiat ? `Amount (${state.fiatCode})` : `Amount (${net().ticker})`;
  // Show exactly what's being typed (so "0.005" shows the dot + zeros live);
  // the parsed value drives the equivalent + charge logic below.
  $("#amount").textContent = state.digits;

  let equiv;
  if (state.rate == null) {
    equiv = "no rate on this network";
  } else if (state.inputIsFiat) {
    equiv = `≈ ${fmt(a.crypto, isLightning() ? 0 : 6)} ${net().ticker}`;
  } else {
    equiv = `≈ ${fiatSymbol(state.fiatCode)}${fmt(a.fiat, 2)}`;
  }
  $("#equivalent").textContent = equiv;
  $("#flipBtn").style.visibility = (state.rate == null) ? "hidden" : "visible";
  // A receiving wallet is required (for Lightning, the chosen account).
  $("#chargeBtn").disabled = !(a.crypto > 0) || !state.address;
  $("#netChip").textContent = net().label;
  renderReceiveLine();
}

function renderReceiveLine() {
  const el = $("#receiveLine");
  if (!el) return;
  if (!state.address) {
    el.textContent = `No ${esc(fam().label)} wallet — set one up in Maknoon first.`;
    return;
  }
  if (isLightning()) {
    el.innerHTML = `Receiving on <b>Bitcoin Lightning</b> → <b>${esc(state.addressName || "Lightning wallet")}</b>`;
  } else {
    el.innerHTML = `Receiving on ${esc(net().label)} → <b>${esc(state.addressName || "wallet")}</b> <span class="addr">${esc(short(state.address))}</span>`;
  }
}

function fiatSymbol(code) {
  return ({ USD: "$", EUR: "€", GBP: "£", AED: "د.إ", JPY: "¥" }[code] || (code + " "));
}

// --- keypad ---------------------------------------------------------------
function press(k) {
  if (k === "del") {
    state.digits = state.digits.length > 1 ? state.digits.slice(0, -1) : "0";
  } else if (k === ".") {
    if (!state.digits.includes(".")) state.digits += state.digits === "0" ? "." : ".";
  } else {
    const dp = state.digits.split(".")[1];
    // Fiat = 2 dp; crypto = 8 dp, except Lightning sats are whole numbers.
    const cap = state.inputIsFiat ? 2 : (isLightning() ? 0 : 8);
    if (dp && dp.length >= cap) return;
    state.digits = (state.digits === "0") ? k : state.digits + k;
  }
  renderAmount();
}

$("#keypad").addEventListener("click", (e) => {
  const b = e.target.closest(".key"); if (b) press(b.dataset.k);
});
$("#flipBtn").addEventListener("click", () => {
  if (state.rate == null) return;
  // Convert the current value across modes so the displayed total is stable.
  const a = amounts();
  state.inputIsFiat = !state.inputIsFiat;
  const v = state.inputIsFiat ? a.fiat : a.crypto;
  state.digits = (v && v > 0) ? String(state.inputIsFiat ? v.toFixed(2) : trimFloat(v)) : "0";
  renderAmount();
});
function trimFloat(n) { return parseFloat(n.toFixed(8)).toString(); }

// --- charge ---------------------------------------------------------------
$("#chargeBtn").addEventListener("click", runCharge);
$("#closeOverlay").addEventListener("click", () => $("#overlay").classList.add("hidden"));

function setStep(name, cls, txt) {
  const s = document.querySelector(`.step[data-step="${name}"]`);
  s.classList.remove("active", "ok", "bad");
  if (cls) s.classList.add(cls);
  document.querySelector(`.step-state[data-state="${name}"]`).textContent = txt;
}
function result(kind, html) {
  const box = $("#resultBox");
  box.className = "result-box " + kind;
  box.innerHTML = html;
}

function captureRequest() {
  if (state.capture === "passport") {
    return {
      schema: PASSPORT_SCHEMA,
      requiredClaims: state.passportAttrs.length ? state.passportAttrs : ["givenName", "familyName"],
      purpose: "Point-of-sale identity",
    };
  }
  return {
    schema: SANCTIONS_SCHEMA,
    requiredClaims: ["sanctionsScreenedAt", "jurisdiction", "isPep"],
    maxAgeSec: ONE_YEAR,
    purpose: "Point-of-sale sanctions check",
  };
}

async function runCharge() {
  if (!has()) { return; }
  const a = amounts();
  if (!(a.crypto > 0) || !state.address) return;

  $("#overlay").classList.remove("hidden");
  $("#resultBox").className = "result-box hidden";
  setStep("verify", "active", "…");
  setStep("pay", "", "…");
  $("#verifyDetail").textContent = state.capture === "passport" ? "Passport identity" : "Sanctions-clean, within 12 months";

  // 1. Verify the customer (cross-device).
  let verdict;
  try {
    verdict = await window.maknoon.identity.collect(captureRequest());
  } catch (e) {
    setStep("verify", "bad", "Cancelled");
    return result("bad", `<h3>Verification cancelled</h3><p>${esc(e.message || "")}</p>`);
  }
  if (verdict.decision !== "GRANT") {
    setStep("verify", "bad", "Denied");
    return result("bad", `<h3>Payment blocked</h3><p>${esc(reasonText(verdict.reason))}</p>`);
  }
  const badge = badgeFor(verdict);
  setStep("verify", "ok", "Verified");

  // 2. Receive payment.
  setStep("pay", "active", "…");
  $("#payDetail").textContent = `${net().label} · ${trimFloat(a.crypto)} ${net().ticker}`;
  const fiatText = (a.fiat != null) ? `≈ ${fiatSymbol(state.fiatCode)}${fmt(a.fiat, 2)} ${state.fiatCode}` : null;
  let pay;
  try {
    pay = await window.maknoon.payment.receive(isLightning() ? {
      chain: "lightning", account: state.address, amount: String(a.crypto), fiatText: fiatText || undefined,
    } : {
      chain: net().chain, network: net().network, address: state.address,
      amount: trimFloat(a.crypto), fiatText: fiatText || undefined,
    });
  } catch (e) {
    setStep("pay", "bad", "Cancelled");
    return result("bad", `<h3>Payment not completed</h3><p>${esc(e.message || "")}</p>`);
  }
  setStep("pay", "ok", "Received");

  const entry = {
    at: new Date().toISOString(),
    chain: net().chain, network: net().network, ticker: net().ticker,
    crypto: trimFloat(a.crypto), fiatText, badge,
    attrs: verdict.disclosed || {}, txHash: pay.txHash || null,
  };
  await appendTx(entry);

  result("ok",
    `<h3>Payment received</h3>
     <p>${esc(entry.crypto)} ${esc(net().ticker)}${fiatText ? " (" + esc(fiatText) + ")" : ""}</p>
     <p><span class="tx-badge">${esc(badge)}</span></p>
     ${pay.txHash ? `<p class="mono">${esc(pay.txHash)}</p>` : `<p class="mono">confirmed</p>`}`);
  // Reset entry for the next sale.
  state.digits = "0"; renderAmount();
}

function badgeFor(v) {
  if (state.capture === "passport") return "Identity verified";
  const fresh = v.checks && v.checks.fresh !== false;
  return fresh ? "Sanctions clear" : "Sanctions verified";
}
function reasonText(r) {
  return ({
    no_matching_credential: "Customer has no matching credential.",
    missing_claims: "Customer did not disclose the required details.",
    stale_screening: "The sanctions screening is older than 12 months.",
    wrong_schema: "Customer presented the wrong credential type.",
    verification_failed: "The credential failed verification.",
  }[r] || ("Verifier decision: " + (r || "denied")));
}

// --- settings UI ----------------------------------------------------------
$("#settingsBtn").addEventListener("click", openSettings);
$("#netChip").addEventListener("click", openSettings);
$("#saveSettings").addEventListener("click", async () => {
  await saveSettings();
  $("#settingsOverlay").classList.add("hidden");
});
$("#networkSelect").addEventListener("change", async (e) => {
  state.famIndex = parseInt(e.target.value, 10) || 0;
  state.chainIndex = 0;
  state.address = null; state.addressName = null;
  populateChains();
  await populateAddresses();
  await refreshRate();
  await saveSettings();
});
$("#chainSelect").addEventListener("change", async (e) => {
  state.chainIndex = parseInt(e.target.value, 10) || 0;
  await refreshRate();          // ticker/rate can differ per chain (e.g. POL)
  await saveSettings();
});
$("#addressSelect").addEventListener("change", (e) => {
  state.address = e.target.value || null;
  const opt = e.target.selectedOptions[0];
  state.addressName = opt ? opt.dataset.name : null;
  renderAmount(); saveSettings();
});

function populateChains() {
  const sel = $("#chainSelect");
  sel.innerHTML = fam().chains.map((c, i) =>
    `<option value="${i}" ${i === state.chainIndex ? "selected" : ""}>${c.label} (${c.ticker})</option>`).join("");
}
document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
  state.capture = b.dataset.capture;
  syncCaptureUI();
}));
$("#passportAttrs").addEventListener("change", () => {
  state.passportAttrs = [...document.querySelectorAll("#passportAttrs input:checked")].map((i) => i.value);
});

async function openSettings() {
  const ns = $("#networkSelect");
  ns.innerHTML = FAMILIES.map((f, i) => `<option value="${i}" ${i === state.famIndex ? "selected" : ""}>${f.label}</option>`).join("");
  populateChains();
  await populateAddresses();
  syncCaptureUI();
  $("#settingsOverlay").classList.remove("hidden");
}

async function populateAddresses() {
  const sel = $("#addressSelect");
  // Lightning receives into the active Lightning account; no address to pick.
  // Build a uniform list of {address, name, isOwnWallet} for the chain.
  // Lightning lists the user's Lightning accounts (address = account id);
  // on-chain lists address-book entries (own wallets + contacts).
  let list = [];
  try {
    if (isLightning()) {
      const accts = await window.maknoon.payment.lightningAccounts();
      list = (accts || []).map((a) => ({ address: a.id, name: a.label, isOwnWallet: true }));
    } else {
      list = (await window.maknoon.addressBook.list({ chain: net().chain })) || [];
    }
  } catch (e) { list = []; }

  if (!list.length) {
    sel.innerHTML = `<option value="">No ${esc(fam().label)} wallet</option>`;
    $("#addressHint").textContent = `Set up a ${fam().label} wallet in Maknoon first, then reopen.`;
    state.address = null; state.addressName = null;
    renderReceiveLine();
    return;
  }

  sel.innerHTML = list.map((e) => {
    const suffix = isLightning() ? "" : ` — ${short(e.address)}`;
    return `<option value="${esc(e.address)}" data-name="${esc(e.name)}" ${e.address === state.address ? "selected" : ""}>${esc(e.name)}${e.isOwnWallet && !isLightning() ? " (my wallet)" : ""}${suffix}</option>`;
  }).join("");
  if (!state.address || !list.some((e) => e.address === state.address)) {
    state.address = list[0].address;
    state.addressName = list[0].name;
    sel.value = state.address;
  } else {
    const cur = list.find((e) => e.address === state.address);
    if (cur) state.addressName = cur.name;
  }
  $("#addressHint").textContent = isLightning()
    ? "Pick which Lightning wallet receives."
    : "Pick one of your wallets or saved addresses.";
  renderReceiveLine();
}

function syncCaptureUI() {
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.capture === state.capture));
  $("#passportAttrs").classList.toggle("hidden", state.capture !== "passport");
  [...document.querySelectorAll("#passportAttrs input")].forEach((i) => { i.checked = state.passportAttrs.includes(i.value); });
}

// --- receipts -------------------------------------------------------------
$("#receiptsBtn").addEventListener("click", async () => {
  const list = await loadTx();
  const el = $("#txList");
  el.innerHTML = list.length ? list.map(txRow).join("") : `<div class="tx-empty">No sales yet.</div>`;
  $("#receiptsOverlay").classList.remove("hidden");
});
$("#closeReceipts").addEventListener("click", () => $("#receiptsOverlay").classList.add("hidden"));

function txRow(t) {
  const when = new Date(t.at).toLocaleString();
  return `<div class="tx-row">
    <div class="tx-top"><span class="tx-amt">${esc(t.crypto)} ${esc(t.ticker)}</span>
      <span class="tx-badge">${esc(t.badge || "verified")}</span></div>
    <div class="tx-meta"><span>${esc(when)}</span><span class="tx-fiat">${esc(t.fiatText || "")}</span></div>
  </div>`;
}

// --- helpers --------------------------------------------------------------
function short(a) { return a && a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-4) : a; }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- boot -----------------------------------------------------------------
(async function boot() {
  if (!has()) {
    $("#equivalent").textContent = "open inside Maknoon";
    return;
  }
  await loadSettings();
  await refreshRate();
  // Resolve a default address if none chosen yet.
  if (!state.address) { try { await populateAddresses(); } catch (e) {} }
  renderAmount();
})();
