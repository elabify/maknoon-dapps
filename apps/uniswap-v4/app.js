// UniswapV4 credential-gated swap (Beta). A retail swap over the generalized
// Maknoon web3 bridge (window.ethereum): multi-chain, eth_sendTransaction with
// contract calldata, and eth_signTypedData_v4. The pool admits only a verified,
// non-sanctioned, passport-backed human; the gate is read on-chain via
// accessGate.isAllowed(address), which is gate-agnostic (works with the
// ONCHAINID / ERC-3643 gate or the fallback registry).
//
// Pools are DISCOVERED, not hardcoded: window.maknoon.pools.list reads the Access
// Issuer's public /v1/pools registry (the sandbox blocks fetch/XHR, so the host
// does the read natively). The user picks a pool, or enters one manually. Token
// symbols + decimals are read on-chain; the per-chain Uniswap router + quoter come
// from CHAIN_INFRA. Signing/verification happen in native Maknoon sheets; this
// page only orchestrates and never sees key material.

"use strict";

// ---------------------------------------------------------------------------
// Static config. Pools themselves come from the issuer registry at runtime.
// ---------------------------------------------------------------------------
const CONFIG = {
  // The Access Issuer (issuer-backend): serves GET /v1/pools and runs
  // POST /v1/networks/{caip2}/access-issuer/grant. Verifies the passport +
  // sanctions-clean presentation, then writes the on-chain ONCHAINID / ERC-3643
  // claim (ADR-0058). The native handler binds the wallet-control proof to issuerDid.
  issuerBaseUrl: "https://musnad-issuer.elabify.com",
  issuerDid: "did:elabify:sepolia:issuer:musnad",
  passportSchema: "elabify://schema/global/passport/v1",
  slippageBps: 50, // 0.50%, applied to the quote for the display-only minimum received
};

// Per-chain Uniswap v4 infra. A registry row carries the pool identity + gate;
// the singleton PoolManager, the test router, and the Quoter are fixed per-chain
// deployments, so they live here keyed by chainId. A chain with no entry can
// still be gated + read (isAllowed / grant work via the bridge), but swaps + the
// receive estimate are disabled until its infra is filled in.
const CHAIN_INFRA = {
  84532: {
    label: "Base Sepolia",
    explorer: "https://sepolia.basescan.org",
    poolSwapTest: "0x8b5bcc363dde2614281ad875bad385e0a785d3b9", // PoolSwapTest router (verified)
    quoter: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba",       // v4 Quoter (fixed Uniswap deployment)
  },
};

// Fallback if the host predates window.maknoon.pools.list or the registry is
// unreachable: the pilot Base Sepolia AUDD -> MMF pool (same shape as a /v1/pools
// row). Keeps the demo working offline / on older builds.
const FALLBACK_POOLS = [
  {
    name: "AUDD / MMF",
    chainId: 84532,
    caip2: "eip155:84532",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    gate: "0x5af09be4e3675838Ae1728749424971B094228e8",
    hook: "0xBB75553378783dc1390a078E7C07c81EEF1A0080",
    fee: 3000,
    tickSpacing: 60,
    tokenA: "0xdb3BeA2FEa07f6A03B184f872E3Cd6e7Fa094E7A", // MockAUDD (you pay)
    tokenB: "0x1977d6eD61669C6145394D9c4db92dcf2547e546", // MockMMF (you receive)
  },
];

// Function selectors (keccak256(signature)[0:4], computed with `cast sig`):
const SELECTOR = {
  approve:   "095ea7b3", // approve(address,uint256)
  isAllowed: "babcc539", // isAllowed(address)
  balanceOf: "70a08231", // balanceOf(address)
  decimals:  "313ce567", // decimals()
  symbol:    "95d89b41", // symbol()
  swap:      "2229d0b4", // swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)
  quote:     "aa9d21cb", // quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
};

// Uniswap v4 TickMath sqrt-price bounds (used as swap price limits).
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const $ = (s) => document.querySelector(s);
const hasEth = () => !!(window.ethereum && typeof window.ethereum.request === "function");

const state = { address: null, allowed: false, credId: null, pools: [], pool: null };

// --- EIP-1193 ---------------------------------------------------------------
function eth(method, params) {
  return window.ethereum.request({ method, params: params || [] });
}

// --- minimal ABI encoding (no external lib; strict-CSP-safe) ----------------
function stripHex(h) { return (h || "").replace(/^0x/, ""); }
function pad32(hexNoPrefix) { return hexNoPrefix.padStart(64, "0"); }
function encAddress(addr) { return pad32(stripHex(addr).toLowerCase()); }
function encUint(v) { return pad32(BigInt(v).toString(16)); }
function encBool(b) { return pad32(b ? "1" : "0"); }
// int256 two's-complement (handles the negative exact-in amountSpecified).
function encInt(v) {
  let n = BigInt(v);
  if (n < 0n) n = (1n << 256n) + n;
  return pad32(n.toString(16));
}

// approve(spender, amount) calldata.
function encodeApprove(spender, amount) {
  return "0x" + SELECTOR.approve + encAddress(spender) + encUint(amount);
}

// PoolSwapTest.swap(key, params, testSettings, hookData) calldata. key/params/
// testSettings are static tuples encoded inline; hookData is dynamic (empty here).
function encodeSwap(key, params, testSettings, hookData) {
  const head =
    // PoolKey tuple (5 static words)
    encAddress(key.currency0) + encAddress(key.currency1) +
    encUint(key.fee) + encInt(key.tickSpacing) + encAddress(key.hooks) +
    // SwapParams tuple (3 static words)
    encBool(params.zeroForOne) + encInt(params.amountSpecified) + encUint(params.sqrtPriceLimitX96) +
    // TestSettings tuple (2 static words)
    encBool(testSettings.takeClaims) + encBool(testSettings.settleUsingBurn);
  // hookData is the only dynamic arg; its offset = bytes of the head + this
  // offset word itself. head has 10 tuple words + 1 offset word = 11 * 32 = 352.
  const offset = encUint(11 * 32);
  const hd = stripHex(hookData || "0x");
  const hdLen = encUint(hd.length / 2);
  const hdBody = hd.length ? hd.padEnd(Math.ceil(hd.length / 64) * 64, "0") : "";
  return "0x" + SELECTOR.swap + head + offset + hdLen + hdBody;
}

// V4Quoter.quoteExactInputSingle(QuoteExactSingleParams) calldata. The single arg
// is a dynamic struct (it carries `bytes hookData`), so the calldata opens with a
// 0x20 offset word. Struct layout: PoolKey (5 static words) + zeroForOne +
// exactAmount (uint128) + hookData offset (=8*32 within the struct) + the empty
// hookData length word.
function encodeQuote(key, zeroForOne, exactAmount) {
  const struct =
    encAddress(key.currency0) + encAddress(key.currency1) +
    encUint(key.fee) + encInt(key.tickSpacing) + encAddress(key.hooks) +
    encBool(zeroForOne) + encUint(exactAmount) + encUint(8 * 32) +
    encUint(0); // hookData length = 0 (empty)
  return "0x" + SELECTOR.quote + encUint(32) + struct;
}

// Real on-chain receive estimate via the Uniswap v4 Quoter (eth_call, which
// simulates the swap). `from` is the connected wallet so the pool's beforeSwap
// hook (gate.isAllowed(tx.origin)) passes during the simulation. Returns tokenOut
// units (BigInt), or null when the quote can't be produced (wallet not verified,
// no liquidity, missing quoter) so the caller falls back to the placeholder.
async function quoteReceive(exactAmount) {
  const p = state.pool;
  if (!state.address || !p || !p.quoter) return null;
  const sp = sortedPool();
  const key = { currency0: sp.currency0, currency1: sp.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hook };
  try {
    const out = await eth("eth_call", [
      { to: p.quoter, from: state.address, data: encodeQuote(key, sp.zeroForOne, exactAmount) },
      "latest",
    ]);
    const hex = stripHex(out);
    if (hex.length < 64) return null;
    return BigInt("0x" + hex.slice(0, 64)); // amountOut is the first return word
  } catch (e) {
    return null;
  }
}

// --- reads ------------------------------------------------------------------
async function ethCall(to, dataHex) {
  return eth("eth_call", [{ to, data: dataHex }, "latest"]);
}
async function isAllowed(addr) {
  const out = await ethCall(state.pool.accessGate, "0x" + SELECTOR.isAllowed + encAddress(addr));
  return /[1-9a-f]/.test(stripHex(out).slice(-1)); // last byte nonzero => true
}
async function readDecimals(addr) {
  const h = stripHex(await ethCall(addr, "0x" + SELECTOR.decimals));
  return h ? Number(BigInt("0x" + h)) : 18;
}
async function readSymbol(addr) {
  const h = stripHex(await ethCall(addr, "0x" + SELECTOR.symbol));
  // ABI-encoded string: [offset][length][data...]; decode ASCII (token symbols).
  if (h.length >= 128) {
    const len = Number(BigInt("0x" + h.slice(64, 128)));
    const ascii = hexToAscii(h.slice(128, 128 + len * 2));
    if (ascii) return ascii;
  }
  return shortAddr(addr);
}
// Read symbol + decimals for the active pool's tokens (once, cached on the pool).
async function hydrateTokens() {
  const p = state.pool;
  if (!p) return;
  for (const tok of [p.tokenIn, p.tokenOut]) {
    if (tok.decimals == null) { try { tok.decimals = await readDecimals(tok.address); } catch (e) { tok.decimals = 18; } }
    if (tok.symbol == null) { try { tok.symbol = await readSymbol(tok.address); } catch (e) { tok.symbol = shortAddr(tok.address); } }
  }
}

// currency0 < currency1 (v4 ordering); track which side is the input token.
function sortedPool() {
  const a = state.pool.tokenIn, b = state.pool.tokenOut;
  const inIsZero = BigInt(a.address) < BigInt(b.address);
  return {
    currency0: inIsZero ? a.address : b.address,
    currency1: inIsZero ? b.address : a.address,
    zeroForOne: inIsZero, // selling the input token
  };
}

// --- pool discovery ---------------------------------------------------------
// Build the internal pool object from a registry row: enrich with per-chain
// infra + a chain label, and default direction to tokenA (pay) -> tokenB (receive).
function makePool(row) {
  const chainId = Number(row.chainId);
  const infra = CHAIN_INFRA[chainId] || {};
  return {
    name: row.name || ("Pool " + shortAddr(row.gate)),
    chainId,
    chainIdHex: "0x" + chainId.toString(16),
    caip2: row.caip2 || ("eip155:" + chainId),
    chainLabel: infra.label || ("Chain " + chainId),
    explorer: infra.explorer || null,
    poolManager: row.poolManager,
    poolSwapTest: infra.poolSwapTest || null,
    quoter: infra.quoter || null,
    accessGate: row.gate,
    hook: row.hook,
    fee: Number(row.fee),
    tickSpacing: Number(row.tickSpacing),
    tokenIn:  { address: row.tokenA, symbol: null, decimals: null },
    tokenOut: { address: row.tokenB, symbol: null, decimals: null },
  };
}

// Read the issuer's pool registry through the native bridge (the sandbox has no
// fetch). Falls back to the pilot pool on an older host or a network failure.
async function loadPools() {
  let rows = null;
  try {
    if (window.maknoon && window.maknoon.pools && window.maknoon.pools.list) {
      const res = await window.maknoon.pools.list({ issuerUrl: CONFIG.issuerBaseUrl });
      if (res && Array.isArray(res.pools) && res.pools.length) rows = res.pools;
    }
  } catch (e) { /* old host or offline: fall back below */ }
  if (!rows || !rows.length) rows = FALLBACK_POOLS;
  state.pools = rows.map(makePool);
  state.pool = state.pools[0];
}

function populatePoolSelect() {
  const sel = $("#poolSelect");
  sel.innerHTML = state.pools
    .map((p, i) => `<option value="${i}">${esc(p.name)} · ${esc(p.chainLabel)}</option>`)
    .join("");
  sel.value = String(Math.max(0, state.pools.indexOf(state.pool)));
  // Only show the picker chrome when there's a real choice; a single pool just
  // renders in the gate below.
  $("#poolPicker").classList.toggle("hidden", state.pools.length <= 1 && !state.showManual);
}

// Switch to a pool: reset gate state, update the chip, and (if already connected)
// re-run connect so we switch chain + re-hydrate + re-gate for the new pool.
async function selectPool(i) {
  if (!state.pools[i]) return;
  state.pool = state.pools[i];
  state.allowed = false;
  state.credId = null;
  $("#netChip").textContent = state.pool.chainLabel;
  if (state.address) { await connectAndGate(); } else { renderGate(); }
}

// --- flow -------------------------------------------------------------------
async function connectAndGate() {
  clearErr();
  try {
    const accts = await eth("eth_requestAccounts");
    state.address = (accts && accts[0]) || null;
    if (!state.address) throw new Error(t("err_no_account"));
    const chain = await eth("eth_chainId");
    if (String(chain).toLowerCase() !== state.pool.chainIdHex) {
      await eth("wallet_switchEthereumChain", [{ chainId: state.pool.chainIdHex }]);
    }
    await hydrateTokens();
    await refreshGate();
  } catch (e) {
    showErr(e);
  }
}

async function refreshGate() {
  try {
    state.allowed = await isAllowed(state.address);
  } catch (e) {
    state.allowed = false;
  }
  renderGate();
}

// Verify to access: prove personhood + sanctions-clean via a passport
// presentation, prove control of the EVM address, and let the verifier write
// the on-chain grant / ONCHAINID claim.
async function verifyToAccess() {
  clearErr();
  try {
    // The host performs the whole grant natively (mirrors commerce): it discloses
    // a passport, sanctions-clean presentation, proves control of this EVM address
    // with an EIP-712 WalletControl signature (bound to the issuer DID), and POSTs
    // both to the Access Issuer's /v1/networks/{caip2}/access-issuer/grant. The
    // presentation and key material never enter this app; we only receive
    // { granted, walletAddress, txHash, expiry }.
    const res = await window.maknoon.poolAccess.grant({
      issuerUrl: CONFIG.issuerBaseUrl,
      issuerDid: CONFIG.issuerDid,
      chain: state.pool.caip2,
      gateAddress: state.pool.accessGate,
    });
    if (!res || !res.granted) {
      throw new Error((res && (res.reason || res.message)) || t("err_verify_denied"));
    }

    // The verifier awaits the on-chain grant tx before returning, so isAllowed
    // should already be true; confirm with a short poll.
    state.allowed = await isAllowed(state.address).catch(() => true);
    for (let i = 0; i < 8 && !state.allowed; i++) {
      await sleep(1500);
      state.allowed = await isAllowed(state.address).catch(() => false);
    }
    state.credId = res.walletAddress || state.address;
    renderGate();
  } catch (e) {
    showErr(e);
  }
}

// --- swap -------------------------------------------------------------------
async function doSwap() {
  clearErr();
  const raw = parseFloat($("#payAmount").value || "0");
  if (!(raw > 0)) return;
  const p = state.pool;
  if (!p.poolSwapTest) { showErr(new Error(t("err_no_router"))); return; }
  const amountUnits = toUnits(raw, p.tokenIn.decimals); // BigInt token units
  const sp = sortedPool();

  overlay(true);
  renderSteps([
    { key: "approve", label: t("step_approve") },
    { key: "swap", label: t("step_swap") },
  ]);
  try {
    // 1. approve(poolSwapTest, amount) on the input token.
    setStep("approve", "active");
    const approveTx = { from: state.address, to: p.tokenIn.address, data: encodeApprove(p.poolSwapTest, amountUnits) };
    await eth("eth_sendTransaction", [approveTx]);
    setStep("approve", "ok");

    // 2. poolSwapTest.swap(...). Exact-in => negative amountSpecified.
    setStep("swap", "active");
    const key = { currency0: sp.currency0, currency1: sp.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hook };
    const params = {
      zeroForOne: sp.zeroForOne,
      amountSpecified: (-amountUnits).toString(),
      sqrtPriceLimitX96: (sp.zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n).toString(),
    };
    const testSettings = { takeClaims: false, settleUsingBurn: false };
    const swapTx = { from: state.address, to: p.poolSwapTest, data: encodeSwap(key, params, testSettings, "0x") };
    const hash = await eth("eth_sendTransaction", [swapTx]);
    setStep("swap", "ok");
    result("ok", `<h3>${esc(t("swap_done"))}</h3>${txLink(hash)}`);
  } catch (e) {
    result("bad", `<h3>${esc(t("swap_failed"))}</h3><p>${esc(e && (e.message || String(e)))}</p>`);
  }
}

// --- rendering --------------------------------------------------------------
function renderGate() {
  const connected = !!state.address;
  const p = state.pool;
  $("#credCard").classList.toggle("hidden", !state.allowed);
  $("#swapCard").classList.toggle("hidden", !state.allowed);
  if (state.credId) $("#credId").textContent = state.credId;
  $("#paySym").textContent = (p && p.tokenIn.symbol) || "";
  $("#getSym").textContent = (p && p.tokenOut.symbol) || "";
  if (state.allowed && p) {
    // Static pool detail: fee tier (rate + min received fill in on a quote).
    $("#feeVal").textContent = (p.fee / 10000).toFixed(2) + "%";
    $("#swapDetail").classList.remove("hidden");
    if (!p.poolSwapTest) { $("#swapBtn").disabled = true; $("#swapBtn").textContent = t("err_no_router"); }
  }

  const card = $("#gateCard");
  if (state.allowed) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  if (!connected) {
    $("#gateIcon").textContent = "🔒";
    $("#gateTitle").textContent = t("gate_connect_title");
    $("#gateBody").textContent = t("gate_connect_body");
    $("#gateBtn").textContent = t("btn_connect");
    $("#gateBtn").onclick = connectAndGate;
  } else {
    $("#gateIcon").textContent = "🪪";
    $("#gateTitle").textContent = t("gate_verify_title");
    $("#gateBody").textContent = t("gate_verify_body");
    $("#gateBtn").textContent = t("btn_verify");
    $("#gateBtn").onclick = verifyToAccess;
  }
}

// Rate / minimum-received detail for the entered amount. `out` is the Quoter
// estimate (BigInt tokenOut units) or null. Minimum received applies the
// display-only slippage tolerance; on-chain min-out is not enforced here.
function renderSwapDetail(rawIn, out) {
  const p = state.pool;
  if (!p) return;
  $("#feeVal").textContent = (p.fee / 10000).toFixed(2) + "%";
  if (out == null) { $("#rateVal").textContent = "—"; $("#minVal").textContent = "—"; return; }
  const outHuman = parseFloat(fromUnits(out, p.tokenOut.decimals));
  const inHuman = parseFloat(rawIn);
  const rate = inHuman > 0 ? outHuman / inHuman : 0;
  $("#rateVal").textContent = `1 ${p.tokenIn.symbol} ≈ ${trimNum(rate)} ${p.tokenOut.symbol}`;
  const min = (out * BigInt(10000 - CONFIG.slippageBps)) / 10000n;
  $("#minVal").textContent = `${fromUnits(min, p.tokenOut.decimals)} ${p.tokenOut.symbol}`;
}

function renderSteps(steps) {
  $("#resultBox").className = "result-box hidden";
  $("#steps").innerHTML = steps.map((s) =>
    `<div class="step" data-step="${s.key}"><span class="step-dot"></span>
       <div class="step-title">${esc(s.label)}</div>
       <span class="step-state" data-state="${s.key}">…</span></div>`).join("");
}
function setStep(key, cls) {
  const s = document.querySelector(`.step[data-step="${key}"]`);
  if (!s) return;
  s.classList.remove("active", "ok", "bad");
  if (cls) s.classList.add(cls);
  document.querySelector(`.step-state[data-state="${key}"]`).textContent =
    cls === "ok" ? "✓" : cls === "bad" ? "✕" : "…";
}
function result(kind, html) { const b = $("#resultBox"); b.className = "result-box " + kind; b.innerHTML = html; }
function overlay(show) { $("#overlay").classList.toggle("hidden", !show); }

function txLink(hash) {
  if (!hash) return "";
  const base = (state.pool && state.pool.explorer) || "https://sepolia.basescan.org";
  const url = base + "/tx/" + encodeURIComponent(hash);
  const short = hash.length > 18 ? hash.slice(0, 10) + "…" + hash.slice(-6) : hash;
  return `<p class="mono"><a href="${esc(url)}">${esc(short)} ↗</a></p>`;
}

// --- manual pool entry ------------------------------------------------------
function mfVal(id) { return ($("#" + id).value || "").trim(); }
function mfAddr(id) {
  const v = mfVal(id);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(t("mf_bad_addr"));
  return v;
}
function addManualPool() {
  const err = $("#mf_err");
  err.classList.add("hidden");
  try {
    const chainId = parseInt(mfVal("mf_chainId"), 10);
    if (!(chainId > 0)) throw new Error(t("mf_bad_chain"));
    const fee = parseInt(mfVal("mf_fee"), 10);
    const tickSpacing = parseInt(mfVal("mf_tickSpacing"), 10);
    if (!(fee >= 0) || !(tickSpacing > 0)) throw new Error(t("mf_bad_fee"));
    const row = {
      name: mfVal("mf_name") || "Custom pool",
      chainId,
      caip2: "eip155:" + chainId,
      poolManager: mfAddr("mf_poolManager"),
      gate: mfAddr("mf_gate"),
      hook: mfAddr("mf_hook"),
      fee,
      tickSpacing,
      tokenA: mfAddr("mf_tokenA"),
      tokenB: mfAddr("mf_tokenB"),
    };
    state.pools.push(makePool(row));
    populatePoolSelect();
    selectPool(state.pools.length - 1);
  } catch (e) {
    err.textContent = (e && e.message) || String(e);
    err.classList.remove("hidden");
  }
}

// --- helpers ----------------------------------------------------------------
function toUnits(amount, decimals) {
  // decimal string -> integer token units, without float drift.
  const [whole, frac = ""] = String(amount).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((whole || "0") + fracPadded);
}
function fromUnits(units, decimals) {
  // integer token units -> trimmed decimal string (inverse of toUnits).
  const s = BigInt(units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
function hexToAscii(h) {
  let s = "";
  for (let i = 0; i + 1 < h.length; i += 2) {
    const c = parseInt(h.substr(i, 2), 16);
    if (c) s += String.fromCharCode(c);
  }
  return s;
}
function shortAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }
function trimNum(n) { return (Math.round(n * 1e6) / 1e6).toString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function clearErr() { const e = $("#gateError"); e.classList.add("hidden"); e.textContent = ""; }
function showErr(e) {
  const msg = (e && (e.message || String(e))) || t("err_generic");
  if (/reject|denied|cancel/i.test(msg)) return; // user backed out; not an error banner
  const el = $("#gateError"); el.textContent = msg; el.classList.remove("hidden");
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let quoteSeq = 0;
$("#payAmount").addEventListener("input", async () => {
  const raw = $("#payAmount").value || "0";
  const v = parseFloat(raw);
  const btn = $("#swapBtn");
  const noRouter = !(state.pool && state.pool.poolSwapTest);
  btn.disabled = !(v > 0) || noRouter;
  btn.textContent = noRouter ? t("err_no_router") : (v > 0 ? t("btn_swap") : t("btn_enter_amount"));
  if (!(v > 0)) { $("#getAmount").textContent = "0.0"; renderSwapDetail(raw, null); return; }
  // Show the placeholder immediately, then replace it with the real Quoter
  // estimate. If the quote can't be produced, the placeholder stands.
  $("#getAmount").textContent = t("quoted_onchain");
  const seq = ++quoteSeq;
  const out = await quoteReceive(toUnits(raw, state.pool.tokenIn.decimals));
  if (seq !== quoteSeq) return; // a newer keystroke superseded this quote
  if (out != null) $("#getAmount").textContent = fromUnits(out, state.pool.tokenOut.decimals);
  renderSwapDetail(raw, out);
});
$("#swapBtn").addEventListener("click", doSwap);
$("#closeOverlay").addEventListener("click", () => overlay(false));
$("#poolSelect").addEventListener("change", (e) => selectPool(Number(e.target.value)));
$("#mf_add").addEventListener("click", addManualPool);

// --- boot -------------------------------------------------------------------
(async function boot() {
  let locale = "en";
  try { const info = await window.maknoon.device.info(); locale = (info && info.locale) || "en"; } catch (e) {}
  window.__uniLang = normLocale(locale);
  document.documentElement.lang = window.__uniLang;
  document.documentElement.dir = (window.__uniLang === "ar") ? "rtl" : "ltr";
  applyStaticI18n();

  if (!hasEth()) { $("#gateBody").textContent = t("open_inside"); $("#gateBtn").disabled = true; return; }

  await loadPools();
  populatePoolSelect();
  $("#netChip").textContent = state.pool.chainLabel;
  renderGate();
})();
