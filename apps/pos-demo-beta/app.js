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

const PASSPORT_SCHEMA = "elabify://schema/global/passport/v1";
const ONE_YEAR = 365 * 24 * 60 * 60;
// Chains whose native Verify & Pay (commerce.collectAndCharge) sheet is wired
// end to end. Others fall through to the two-step identity.collect +
// payment.receive flow until their settlement lands.
const COMMERCE_CHAINS = ["ethereum", "solana", "tron", "bitcoin", "lightning"];

// Networks (the coin/chain family) and their chains (sub-networks). The chain
// dropdown is normally populated from the wallet's canonical ordered list via
// window.maknoon.wallet.getNetworks; this hardcoded table is the fallback for
// older hosts and the source of per-network tickers (e.g. Polygon -> POL).
// `network` values match the native enums. Families listed alphabetically.
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
  chainIndex: 0,        // selected chain within the family (index into state.chains)
  // The active chain list for the current family. Populated from the wallet's
  // canonical ordered network list (window.maknoon.wallet.getNetworks); falls
  // back to the family's hardcoded `chains` on older hosts. Each entry:
  // { network, label, ticker, isTestnet }.
  chains: [],
  address: null,
  addressName: null,
  // Which asset to receive. Defaults to the native coin of the family.
  // { symbol, contract|mint|null, decimals, kind: native|erc20|spl|trc20 }
  asset: null,
  // The customer attributes/predicates to verify. sdnScreen + screenFresh are
  // the sanctions defaults; the rest are optional PII.
  verifyChecks: ["sdnScreen", "screenFresh"],
  rate: null,           // fiat per 1 coin (null => no fiat)
  fiatCode: "USD",
};

function fam() { return FAMILIES[state.famIndex]; }
function isLightning() { return fam().chain === "lightning"; }
function isBitcoinFamily() { return fam().chain === "bitcoin" || fam().chain === "lightning"; }
// The active chain list: the wallet-provided list once populated, otherwise the
// family's hardcoded fallback (used at boot before populateChains has run).
function chainList() {
  return (state.chains && state.chains.length) ? state.chains : fam().chains;
}
// Flattened current selection: { chain, network, ticker, label }.
function net() {
  const f = fam();
  const list = chainList();
  const c = list[state.chainIndex] || list[0];
  return { chain: f.chain, network: c.network, ticker: c.ticker, label: `${f.label} · ${c.label}` };
}

// The native asset descriptor for the current family (the default selection).
// Native decimals per family: BTC/Lightning 8, ETH 18, SOL 9, TRON 6.
function nativeAsset() {
  const n = net();
  const decimals = { bitcoin: 8, lightning: 8, ethereum: 18, solana: 9, tron: 6 }[n.chain] ?? 18;
  return { symbol: n.ticker, contract: null, mint: null, decimals, kind: "native" };
}
// The currently selected asset, falling back to native.
function asset() { return state.asset || nativeAsset(); }

// --- persistence ----------------------------------------------------------
async function loadSettings() {
  try {
    const raw = await window.maknoon.storage.getItem("settings");
    if (raw) {
      const s = JSON.parse(raw);
      const fi = FAMILIES.findIndex((f) => f.chain === s.chain);
      if (fi >= 0) {
        state.famIndex = fi;
        // Remember the desired network id; the real index is resolved once
        // populateChains() has the wallet's ordered list (which may differ from
        // the hardcoded fallback order). Fall back to the hardcoded index now.
        state.networkId = s.network || null;
        const ci = FAMILIES[fi].chains.findIndex((c) => c.network === s.network);
        state.chainIndex = ci >= 0 ? ci : 0;
      }
      state.address = s.address || null;
      state.addressName = s.addressName || null;
      state.asset = s.asset || null;
      if (Array.isArray(s.verifyChecks) && s.verifyChecks.length) state.verifyChecks = s.verifyChecks;
    }
  } catch (e) { /* defaults */ }
}
async function saveSettings() {
  const s = {
    chain: net().chain, network: net().network,
    address: state.address, addressName: state.addressName,
    asset: state.asset, verifyChecks: state.verifyChecks,
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
  // No rate (e.g. testnet) -> force crypto entry. A USD stablecoin still has an
  // effective rate (~= 1.0), so fiat entry stays available there.
  if (effectiveRate() == null) state.inputIsFiat = false;
  renderAmount();
}

function enteredNumber() { return parseFloat(state.digits || "0") || 0; }

// Is the chosen asset a USD-pegged stablecoin?
function isStable() {
  const sym = asset().symbol;
  return asset().kind !== "native" && (sym === "USDC" || sym === "USDT");
}

// The fiat-per-1-unit rate used for conversion. For a USD stablecoin priced in
// USD we treat it as ~= 1.0 (documented simplification; real PoS would quote a
// live peg). Otherwise it is the native coin rate from the fiat quote.
function effectiveRate() {
  if (isStable() && state.fiatCode === "USD") return 1.0;
  return state.rate;
}

// The ticker shown for the crypto leg (the chosen asset, or the native coin).
function displayTicker() { return asset().symbol || net().ticker; }

// Returns { crypto, fiat } numeric amounts for the current entry.
// For Lightning, `crypto` is in sats (the rate is fiat-per-BTC).
function amounts() {
  const v = enteredNumber();
  const rate = effectiveRate();
  if (isLightning()) {
    if (state.inputIsFiat) {
      const sats = rate ? Math.round((v / rate) * 1e8) : 0;
      return { fiat: v, crypto: sats };
    } else {
      const sats = Math.round(v);
      const fiat = rate ? (sats / 1e8) * rate : null;
      return { fiat, crypto: sats };
    }
  }
  if (state.inputIsFiat) {
    const crypto = rate ? v / rate : 0;
    return { fiat: v, crypto };
  } else {
    const fiat = rate ? v * rate : null;
    return { fiat, crypto: v };
  }
}

function fmt(n, dp) { return (n || 0).toLocaleString(undefined, { maximumFractionDigits: dp }); }

function renderAmount() {
  const a = amounts();
  const rate = effectiveRate();
  const ticker = displayTicker();
  $("#unit").textContent = state.inputIsFiat ? fiatSymbol(state.fiatCode) : "";
  $("#amountLabel").textContent = state.inputIsFiat ? `Amount (${state.fiatCode})` : `Amount (${ticker})`;
  // Show exactly what's being typed (so "0.005" shows the dot + zeros live);
  // the parsed value drives the equivalent + charge logic below.
  $("#amount").textContent = state.digits;

  let equiv;
  if (rate == null) {
    equiv = "no rate on this network";
  } else if (state.inputIsFiat) {
    equiv = `≈ ${fmt(a.crypto, isLightning() ? 0 : 6)} ${ticker}`;
  } else {
    equiv = `≈ ${fiatSymbol(state.fiatCode)}${fmt(a.fiat, 2)}`;
  }
  $("#equivalent").textContent = equiv;
  $("#flipBtn").style.visibility = (rate == null) ? "hidden" : "visible";
  // A receiving wallet is required (for Lightning, the chosen account).
  $("#chargeBtn").disabled = !(a.crypto > 0) || !state.address;
  $("#netChip").textContent = net().label;
  renderReceiveLine();
}

function renderReceiveLine() {
  const el = $("#receiveLine");
  if (!el) return;
  if (!state.address) {
    el.textContent = `No ${esc(fam().label)} wallet. Set one up in Maknoon first.`;
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
  if (effectiveRate() == null) return;
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

// Block-explorer tx URL for a settled rail; null when none (e.g. Lightning,
// or an unknown network). The Maknoon host opens external https links in the
// device browser when tapped.
function explorerTxUrl(chain, network, txHash) {
  if (!txHash) return null;
  const E = {
    ethereum: {
      mainnet: "https://etherscan.io/tx/",
      sepolia: "https://sepolia.etherscan.io/tx/",
      "arbitrum-sepolia": "https://sepolia.arbiscan.io/tx/",
      "base-sepolia": "https://sepolia.basescan.org/tx/",
      "optimism-sepolia": "https://sepolia-optimism.etherscan.io/tx/",
    },
    solana: { mainnet: "https://explorer.solana.com/tx/", devnet: "https://explorer.solana.com/tx/" },
    tron: { mainnet: "https://tronscan.org/#/transaction/", nile: "https://nile.tronscan.org/#/transaction/" },
    bitcoin: {
      mainnet: "https://mempool.space/tx/",
      testnet: "https://mempool.space/testnet/tx/",
      testnet3: "https://mempool.space/testnet/tx/",
      signet: "https://mempool.space/signet/tx/",
    },
  };
  const base = (E[chain] || {})[network];
  if (!base) return null;
  let url = base + encodeURIComponent(txHash);
  if (chain === "solana" && network === "devnet") url += "?cluster=devnet";
  return url;
}

// Render a settlement ref as a tappable explorer link when we know the
// explorer, else plain mono text. Plain <a href> (no target) so the host's
// nav policy routes the tap to the system browser.
function txLink(chain, network, txHash, fallbackLabel) {
  if (!txHash) return `<p class="mono">${esc(fallbackLabel || "—")}</p>`;
  const url = explorerTxUrl(chain, network, txHash);
  const short = txHash.length > 18 ? txHash.slice(0, 10) + "…" + txHash.slice(-6) : txHash;
  return url
    ? `<p class="mono"><a href="${esc(url)}">${esc(short)} ↗</a></p>`
    : `<p class="mono">${esc(txHash)}</p>`;
}

// PII claims the merchant can optionally request, in display order.
// NB: the passport VC keys the document number as `passportNumber` (the issuer
// schema), so the merchant must request that key, not "documentNumber", or the
// match fails ("no matching credential"). The UI label stays "Document number".
const PII_CLAIMS = ["givenName", "familyName", "nationality", "dateOfBirth", "passportNumber"];

// Map the always-visible verifyChecks list to a single Passport request.
// `sdnScreen` rides the passport's own built-in screening result (the
// `sdnScreen` claim: { screenedAt, result, datasetVersion }); `screenFresh`
// gates that screening to within one year via maxAgeSec. Ticking any PII box
// adds that claim. One credential (the passport) covers both the sanctions
// gate and identity; there is no separate sanctions VC.
function captureRequest() {
  const checks = state.verifyChecks;
  const requiredClaims = [];
  if (checks.includes("sdnScreen")) requiredClaims.push("sdnScreen");
  for (const c of PII_CLAIMS) { if (checks.includes(c)) requiredClaims.push(c); }
  // Default to the sanctions claim if the merchant somehow cleared everything.
  if (!requiredClaims.length) requiredClaims.push("sdnScreen");

  const pii = PII_CLAIMS.filter((c) => checks.includes(c));
  const purpose = pii.length ? "Point-of-sale identity" : "Point-of-sale sanctions screening (passport)";
  const req = { schema: PASSPORT_SCHEMA, requiredClaims, purpose };
  // Freshness only applies to the sanctions screening.
  if (checks.includes("sdnScreen") && checks.includes("screenFresh")) req.maxAgeSec = ONE_YEAR;
  return req;
}

async function runCharge() {
  if (!has()) { return; }
  const a = amounts();
  if (!(a.crypto > 0) || !state.address) return;

  $("#overlay").classList.remove("hidden");
  $("#resultBox").className = "result-box hidden";
  setStep("verify", "active", "…");
  setStep("pay", "", "…");
  $("#verifyDetail").textContent = badgeFor({}) === "Sanctions clear"
    ? "Sanctions-clean, within 12 months" : "Passport identity";

  // Single-tap unified verify-and-pay (ADR-0031) for EVM rails: one native
  // sheet collects identity + the holder's signed payment and the wallet
  // broadcasts. Non-EVM networks fall through to the two-step flow below.
  if (COMMERCE_CHAINS.includes(net().chain) && window.maknoon.commerce) {
    // Unified verify+pay for every chain whose native commerce sheet is wired
    // (EVM + Solana today; Tron/Bitcoin/Lightning fall through to the two-step
    // flow until their settlement lands). No RPC here on purpose: the wallet
    // resolves the endpoint from the Maknoon user's own network settings.
    // The chosen asset parameterizes the rail: symbol + decimals always, and a
    // token contract (ERC-20) / mint (SPL) under `assetContract` (the field the
    // host reads); the host degrades to the native coin if it ignores it.
    const as = asset();
    const rail = {
      chain: net().chain, network: net().network, asset: as.symbol,
      address: state.address, amount: trimFloat(a.crypto), assetDecimals: as.decimals,
    };
    if (as.kind !== "native") {
      const c = as.contract || as.mint;
      if (c) rail.assetContract = c;
    }
    // Pass our own (live) store name so the customer sees it instead of the
    // catalog title. The dApp owns its name (window.maknoon.storage).
    let merchantName = "";
    try { merchantName = (await window.maknoon.storage.getItem("merchantName")) || ""; } catch (e) {}
    let v;
    try {
      v = await window.maknoon.commerce.collectAndCharge({
        merchantName: merchantName || undefined,
        identity: captureRequest(),
        payment: {
          fiatAmount: a.fiat != null ? a.fiat.toFixed(2) : "",
          fiatCode: state.fiatCode, acceptedRails: [rail], reference: "pos",
        },
        lane: "full",
      });
    } catch (e) {
      setStep("verify", "bad", "Cancelled");
      return result("bad", `<h3>Cancelled</h3><p>${esc(e.message || "")}</p>`);
    }
    if (v.decision !== "GRANT") {
      setStep("verify", "bad", "Denied");
      const missing = Array.isArray(v.missing) ? v.missing : [];
      const hint = missing.length
        ? `<p>Customer must also share: <strong>${esc(missing.join(", "))}</strong></p>` : "";
      return result("bad", `<h3>Payment blocked</h3><p>${esc(v.message || reasonText(v.reason))}</p>${hint}`);
    }
    setStep("verify", "ok", "Verified");
    setStep("pay", "ok", v.txHash ? "Received" : "Authorized");
    const fiatText = a.fiat != null ? `${fiatSymbol(state.fiatCode)}${fmt(a.fiat, 2)} ${state.fiatCode}` : null;
    await appendTx({
      at: new Date().toISOString(), chain: net().chain, network: net().network,
      ticker: displayTicker(), crypto: trimFloat(a.crypto), fiatText,
      badge: badgeFor(v), attrs: v.disclosed || {}, txHash: v.txHash || null,
    });
    result("ok",
      `<h3>Verified &amp; paid</h3>
       <p>${esc(trimFloat(a.crypto))} ${esc(displayTicker())}${fiatText ? " (" + esc(fiatText) + ")" : ""}</p>
       <p><span class="tx-badge">${esc(badgeFor(v))}</span></p>
       ${txLink(net().chain, net().network, v.txHash, "authorized")}`);
    state.digits = "0"; renderAmount();
    return;
  }

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
    // The wallet now returns a specific human `message` (which attributes are
    // missing vs shared) and a `missing` list; prefer them over the generic map.
    const msg = verdict.message || reasonText(verdict.reason);
    const missing = Array.isArray(verdict.missing) ? verdict.missing : [];
    const hint = missing.length
      ? `<p>Customer must also share: <strong>${esc(missing.join(", "))}</strong></p>`
      : "";
    return result("bad", `<h3>Payment blocked</h3><p>${esc(msg)}</p>${hint}`);
  }
  const badge = badgeFor(verdict);
  setStep("verify", "ok", "Verified");

  // 2. Receive payment.
  setStep("pay", "active", "…");
  $("#payDetail").textContent = `${net().label} · ${trimFloat(a.crypto)} ${displayTicker()}`;
  const fiatText = (a.fiat != null) ? `≈ ${fiatSymbol(state.fiatCode)}${fmt(a.fiat, 2)} ${state.fiatCode}` : null;
  // Pass the chosen asset descriptor; the host degrades to the native coin if
  // it does not understand `asset` (older hosts) since Bitcoin/Lightning are
  // always native and ETH/SOL/TRON carry symbol/contract|mint/decimals/kind.
  const as = asset();
  let pay;
  try {
    pay = await window.maknoon.payment.receive(isLightning() ? {
      chain: "lightning", account: state.address, amount: String(a.crypto), fiatText: fiatText || undefined,
    } : {
      chain: net().chain, network: net().network, address: state.address,
      amount: trimFloat(a.crypto), fiatText: fiatText || undefined,
      asset: as.kind === "native" ? undefined : {
        symbol: as.symbol, contract: as.contract || undefined, mint: as.mint || undefined,
        decimals: as.decimals, kind: as.kind,
      },
    });
  } catch (e) {
    setStep("pay", "bad", "Cancelled");
    return result("bad", `<h3>Payment not completed</h3><p>${esc(e.message || "")}</p>`);
  }
  setStep("pay", "ok", "Received");

  const entry = {
    at: new Date().toISOString(),
    chain: net().chain, network: net().network, ticker: displayTicker(),
    crypto: trimFloat(a.crypto), fiatText, badge,
    attrs: verdict.disclosed || {}, txHash: pay.txHash || null,
  };
  await appendTx(entry);

  result("ok",
    `<h3>Payment received</h3>
     <p>${esc(entry.crypto)} ${esc(displayTicker())}${fiatText ? " (" + esc(fiatText) + ")" : ""}</p>
     <p><span class="tx-badge">${esc(badge)}</span></p>
     ${txLink(net().chain, net().network, pay.txHash, "confirmed")}`);
  // Reset entry for the next sale.
  state.digits = "0"; renderAmount();
}

function badgeFor(v) {
  const checks = state.verifyChecks;
  const hasPII = PII_CLAIMS.some((c) => checks.includes(c));
  const sanctionsOnly = checks.includes("sdnScreen") && checks.includes("screenFresh") && !hasPII;
  return sanctionsOnly ? "Sanctions clear" : "Identity verified";
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
  state.networkId = null;       // new family -> default to its primary network
  state.chains = [];
  state.address = null; state.addressName = null;
  state.asset = null;           // reset to native for the new family
  await populateChains();
  await populateAddresses();
  await populateAssets();
  await refreshRate();
  await saveSettings();
});
$("#chainSelect").addEventListener("change", async (e) => {
  state.chainIndex = parseInt(e.target.value, 10) || 0;
  const sel = chainList()[state.chainIndex];
  state.networkId = sel ? sel.network : null;
  state.asset = null;           // assets differ per chain (different tokens)
  await populateAssets();
  await refreshRate();          // ticker/rate can differ per chain (e.g. POL)
  await saveSettings();
});
$("#addressSelect").addEventListener("change", async (e) => {
  state.address = e.target.value || null;
  const opt = e.target.selectedOptions[0];
  state.addressName = opt ? opt.dataset.name : null;
  await populateAssets();       // held tokens depend on the chosen address
  renderAmount(); saveSettings();
});
$("#assetSelect").addEventListener("change", (e) => {
  const opt = e.target.selectedOptions[0];
  if (opt && opt._asset) state.asset = opt._asset;
  else state.asset = null;      // "" -> native
  refreshRate(); renderAmount(); saveSettings();
});

// Build the Chain dropdown for the current family from the wallet's canonical
// ordered network list (window.maknoon.wallet.getNetworks({chain})). The bridge
// returns [{ id, label, isTestnet }] already ordered (primary mainnet first,
// other mainnets, then testnets). We render mainnets and testnets into separate
// <optgroup>s so the divider is visible. Tickers are not part of the bridge, so
// we borrow them from the hardcoded fallback by network id, defaulting to the
// family's native ticker. If getNetworks is missing or throws (older host), we
// fall back to the family's hardcoded chain list so the dApp never breaks.
async function resolveChains() {
  const f = fam();
  // Lightning has no on-chain networks; keep its single hardcoded entry.
  if (f.chain === "lightning") return f.chains.map((c) => ({ ...c, isTestnet: false }));

  let list = null;
  try {
    const wallet = window.maknoon && window.maknoon.wallet;
    if (wallet && typeof wallet.getNetworks === "function") {
      const got = await wallet.getNetworks({ chain: f.chain });
      if (Array.isArray(got) && got.length) {
        // Ticker lookup from the hardcoded fallback (e.g. Polygon -> POL).
        const tickerById = {};
        for (const c of f.chains) tickerById[c.network] = c.ticker;
        const nativeTicker = f.chains[0] ? f.chains[0].ticker : "";
        list = got.map((g) => ({
          network: g.id,
          label: g.label || g.id,
          ticker: tickerById[g.id] || nativeTicker,
          isTestnet: !!g.isTestnet,
        }));
      }
    }
  } catch (e) { list = null; }

  // Older host / empty / failure: hardcoded fallback. Derive isTestnet from the
  // label so the optgroup split still works on the fallback list.
  if (!list) {
    list = f.chains.map((c) => ({
      ...c,
      isTestnet: c.isTestnet != null ? c.isTestnet : /test|sepolia|devnet|nile|shasta|signet/i.test(c.network + " " + c.label),
    }));
  }
  return list;
}

async function populateChains() {
  const sel = $("#chainSelect");
  state.chains = await resolveChains();

  // Re-resolve the selected index from the persisted/current network id against
  // the (possibly reordered) list, so the right chain stays selected.
  const wantId = state.networkId || (chainList()[state.chainIndex] && chainList()[state.chainIndex].network);
  let idx = state.chains.findIndex((c) => c.network === wantId);
  if (idx < 0) idx = 0;
  state.chainIndex = idx;
  state.networkId = state.chains[idx] ? state.chains[idx].network : null;

  const opt = (c, i) =>
    `<option value="${i}" ${i === state.chainIndex ? "selected" : ""}>${esc(c.label)} (${esc(c.ticker)})</option>`;
  const mains = state.chains.map((c, i) => ({ c, i })).filter((x) => !x.c.isTestnet);
  const tests = state.chains.map((c, i) => ({ c, i })).filter((x) => x.c.isTestnet);

  // Use optgroups to put a visible divider between mainnets and testnets. If a
  // family has only one bucket, render the flat list (no empty group label).
  if (mains.length && tests.length) {
    sel.innerHTML =
      `<optgroup label="Mainnet">${mains.map((x) => opt(x.c, x.i)).join("")}</optgroup>` +
      `<optgroup label="Testnet">${tests.map((x) => opt(x.c, x.i)).join("")}</optgroup>`;
  } else {
    sel.innerHTML = state.chains.map((c, i) => opt(c, i)).join("");
  }
}

// Populate the Asset picker. Bitcoin + Lightning are fixed (BTC / sats) so the
// field is hidden. ETH/SOL/TRON ask the host for the wallet's assets via
// window.maknoon.wallet.getAssets, which returns native-first then alphabetical
// by symbol; we render in that order (no client-side re-sort). If getAssets is
// missing or throws (older host), fall back to native only and never crash.
async function populateAssets() {
  const field = $("#assetField"), hint = $("#assetHint"), sel = $("#assetSelect");
  if (!field) return;
  if (isBitcoinFamily()) {
    field.style.display = "none"; if (hint) hint.style.display = "none";
    state.asset = null;           // fixed native (BTC / sats)
    return;
  }
  field.style.display = ""; if (hint) hint.style.display = "";

  let assets = [nativeAsset()];
  try {
    const wallet = window.maknoon && window.maknoon.wallet;
    if (wallet && typeof wallet.getAssets === "function") {
      const got = await wallet.getAssets({ chain: net().chain, network: net().network, address: state.address });
      if (Array.isArray(got) && got.length) {
        assets = got.map((g) => ({
          symbol: g.symbol, name: g.name || g.symbol,
          contract: g.contract || null, mint: g.mint || null,
          decimals: typeof g.decimals === "number" ? g.decimals : nativeAsset().decimals,
          kind: g.kind || "native", balance: g.balance,
        }));
        // The getAssets bridge returns native-first then alphabetical by symbol;
        // render in the order returned (no client-side re-sort).
      }
    }
  } catch (e) { assets = [nativeAsset()]; }   // older host / failure -> native only

  // Keep the prior selection if it is still offered.
  const cur = state.asset;
  const key = (x) => `${x.kind}:${x.contract || x.mint || x.symbol}`;
  sel.innerHTML = "";
  assets.forEach((x) => {
    const o = document.createElement("option");
    o.value = key(x);
    o.textContent = x.kind === "native" ? `${x.symbol} (native)` : `${x.symbol}${x.name && x.name !== x.symbol ? " (" + x.name + ")" : ""}`;
    o._asset = x.kind === "native" ? null : x;   // null => native default
    sel.appendChild(o);
  });
  const match = cur && assets.find((x) => key(x) === key(cur));
  if (match) { state.asset = match.kind === "native" ? null : match; sel.value = key(match); }
  else { state.asset = null; sel.value = key(assets[0]); }
  if (hint) hint.textContent = assets.length > 1 ? "Pick which asset to receive." : "Receiving the native coin.";
}

async function openSettings() {
  const ns = $("#networkSelect");
  ns.innerHTML = FAMILIES.map((f, i) => `<option value="${i}" ${i === state.famIndex ? "selected" : ""}>${f.label}</option>`).join("");
  await populateChains();
  await populateAddresses();
  await populateAssets();
  syncVerifyChecks();
  try { $("#storeName").value = (await window.maknoon.storage.getItem("merchantName")) || ""; } catch (e) {}
  await renderMerchant();
  $("#settingsOverlay").classList.remove("hidden");
}

$("#verifyChecks").addEventListener("change", () => {
  state.verifyChecks = [...document.querySelectorAll("#verifyChecks input:checked")].map((i) => i.value);
  saveSettings();
});

// The store name customers see (verifierName / merchantName). Persisted under
// "merchantName"; the wallet injects it into requests this dApp signs.
$("#storeName").addEventListener("input", (e) => {
  try { window.maknoon.storage.setItem("merchantName", e.target.value.trim()); } catch (err) {}
  renderMerchant();   // refresh the mailto with the new name
});

// Copy the merchant DID. Prefer the async clipboard API; fall back to a hidden
// textarea + execCommand so it works in the webview without a clipboard grant.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
$("#copyMerchantId").addEventListener("click", async (e) => {
  const did = $("#merchantId").textContent || "";
  if (!did) return;
  const ok = await copyText(did);
  const btn = e.currentTarget, prev = btn.textContent;
  btn.textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => { btn.textContent = prev; }, 1500);
});

// Per-install merchant verifier identity + verification status (native key).
async function renderMerchant() {
  const statusEl = $("#merchantStatus"), idEl = $("#merchantId"),
        idRow = $("#merchantIdRow"), link = $("#requestVerify");
  if (!window.maknoon.merchant) { statusEl.textContent = ""; idRow.style.display = "none"; return; }
  try {
    const id = await window.maknoon.merchant.getIdentity();
    const verified = !!id.verified;
    statusEl.textContent = verified ? "✓ Verified merchant" : "Self-signed (not yet verified)";
    statusEl.style.color = verified ? "#2ecc71" : "#e67e22";
    idEl.textContent = id.did || "";
    idRow.style.display = id.did ? "flex" : "none";
    if (verified) {
      link.style.display = "none";
    } else {
      link.style.display = "block";
      const name = $("#storeName").value || "Merchant";
      const subject = encodeURIComponent("Maknoon merchant verification request");
      const body = encodeURIComponent(
        "Please register this merchant as a verified verifier:\n\n" +
        "Name: " + name + "\nVerifier DID: " + (id.did || "") + "\nPublic key: " + (id.publicKey || ""));
      link.href = "mailto:sales@elabify.com?subject=" + subject + "&body=" + body;
    }
  } catch (e) { statusEl.textContent = ""; idRow.style.display = "none"; }
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
    const suffix = isLightning() ? "" : ` (${short(e.address)})`;
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

// Reflect state.verifyChecks into the always-visible checklist.
function syncVerifyChecks() {
  [...document.querySelectorAll("#verifyChecks input")].forEach((i) => {
    i.checked = state.verifyChecks.includes(i.value);
  });
}

// --- receipts -------------------------------------------------------------
$("#receiptsBtn").addEventListener("click", async () => {
  const list = await loadTx();
  const el = $("#txList");
  el.innerHTML = list.length ? list.map(txRow).join("") : `<div class="tx-empty">No sales yet.</div>`;
  $("#receiptsOverlay").classList.remove("hidden");
});
$("#closeReceipts").addEventListener("click", () => $("#receiptsOverlay").classList.add("hidden"));

const ATTR_LABELS = {
  sdnScreen: "Sanctions", givenName: "Given name", familyName: "Family name",
  nationality: "Nationality", dateOfBirth: "Date of birth", passportNumber: "Document number",
};
// Human text for one disclosed claim value (sdnScreen is an object).
function attrText(key, value) {
  if (key === "sdnScreen" && value && typeof value === "object") {
    const r = value.result || "?";
    const at = String(value.screenedAt || "").slice(0, 10);
    return at ? `${r} (screened ${at})` : r;
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value == null ? "" : value);
}
function txRow(t) {
  const when = new Date(t.at).toLocaleString();
  const attrs = t.attrs || {};
  const attrRows = Object.keys(attrs).map((k) =>
    `<div class="tx-attr"><span>${esc(ATTR_LABELS[k] || k)}</span><span>${esc(attrText(k, attrs[k]))}</span></div>`,
  ).join("");
  // Settlement ref as a tappable block-explorer link (opens in the device browser).
  const link = t.txHash ? txLink(t.chain, t.network, t.txHash, "") : "";
  return `<div class="tx-row">
    <div class="tx-top"><span class="tx-amt">${esc(t.crypto)} ${esc(t.ticker)}</span>
      <span class="tx-badge">${esc(t.badge || "verified")}</span></div>
    <div class="tx-meta"><span>${esc(when)}</span><span class="tx-fiat">${esc(t.fiatText || "")}</span></div>
    ${attrRows ? `<div class="tx-attrs">${attrRows}</div>` : ""}
    ${link}
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
  // Resolve the chain list from the wallet's canonical network ordering so the
  // selected network id (and its index) is correct before pricing/addresses.
  try { await populateChains(); } catch (e) {}
  // Resolve a default address if none chosen yet.
  if (!state.address) { try { await populateAddresses(); } catch (e) {} }
  // Resolve the asset list (and re-validate any persisted asset) before pricing.
  try { await populateAssets(); } catch (e) {}
  await refreshRate();
  renderAmount();
})();
