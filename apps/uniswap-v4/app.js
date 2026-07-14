// UniswapV4 credential-gated swap (Beta). A retail swap over the generalized
// Maknoon web3 bridge (window.ethereum): multi-chain, eth_sendTransaction with
// contract calldata, and eth_signTypedData_v4. The pool admits only a verified,
// non-sanctioned, passport-backed human; the gate is read on-chain via
// accessGate.isAllowed(address), which is gate-agnostic (works with the
// ONCHAINID / ERC-3643 gate or the fallback registry).
//
// Everything is config-driven (CONFIG below), so this extends to any EVM
// network and any Uniswap v4 pool. The shipped config is the pilot AUDD -> MMF
// pool on Base Sepolia (a tokenized AUD money-market fund, gated to verified,
// non-sanctioned holders). Signing/verification happen in native Maknoon sheets;
// this page only orchestrates and never sees key material.

"use strict";

// ---------------------------------------------------------------------------
// CONFIG. The Base Sepolia demo pool + gate + tokens (all verified on Basescan,
// 2026-07-14). To re-point at a redeploy, swap the pool addresses below.
// ---------------------------------------------------------------------------
const CONFIG = {
  chainIdHex: "0x14a34",            // 84532 Base Sepolia
  chainId: 84532,
  chainLabel: "Base Sepolia",
  caip2: "eip155:84532",
  // The Access Issuer (issuer-backend) runs POST /v1/networks/{caip2}/access-issuer/grant: it
  // verifies the passport, sanctions-clean presentation, then writes the on-chain ONCHAINID /
  // ERC-3643 claim (ADR-0058). Writing access is an issuer action, so this points at the issuer,
  // not the verifier; the native handler binds the wallet-control proof to issuerDid.
  issuerBaseUrl: "https://musnad-issuer.elabify.com",
  issuerDid: "did:elabify:sepolia:issuer:musnad",
  passportSchema: "elabify://schema/global/passport/v1",
  pool: {
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408", // Base Sepolia v4 PoolManager (verified)
    poolSwapTest: "0x8b5bcc363dde2614281ad875bad385e0a785d3b9", // Base Sepolia PoolSwapTest router (verified)
    accessGate: "0x5af09be4e3675838Ae1728749424971B094228e8",   // OnchainIdAccessGate (verified on Basescan)
    hook: "0xBB75553378783dc1390a078E7C07c81EEF1A0080",         // MusnadAccessHook (CREATE2-mined, verified)
    tokenIn:  { symbol: "AUDD", address: "0xcc2B67931962DF907281C8D66cdb306437eAcC99", decimals: 6 },  // MockAUDD (AUD stablecoin)
    tokenOut: { symbol: "MMF",  address: "0xf987E964d2C0A76651108c3a671DC81d934D2FF2", decimals: 18 }, // MockMMF (tokenized AUD money-market fund)
    fee: 3000,
    tickSpacing: 60,
  },
};

// Function selectors (keccak256(signature)[0:4], computed with `cast sig`):
const SELECTOR = {
  approve:   "095ea7b3", // approve(address,uint256)
  isAllowed: "babcc539", // isAllowed(address)
  balanceOf: "70a08231", // balanceOf(address)
  swap:      "2229d0b4", // swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)
};

// Uniswap v4 TickMath sqrt-price bounds (used as swap price limits).
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const $ = (s) => document.querySelector(s);
const hasEth = () => !!(window.ethereum && typeof window.ethereum.request === "function");

const state = { address: null, allowed: false, credId: null };

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

// --- reads ------------------------------------------------------------------
async function ethCall(to, dataHex) {
  return eth("eth_call", [{ to, data: dataHex }, "latest"]);
}
async function isAllowed(addr) {
  const out = await ethCall(CONFIG.pool.accessGate, "0x" + SELECTOR.isAllowed + encAddress(addr));
  return /[1-9a-f]/.test(stripHex(out).slice(-1)); // last byte nonzero => true
}

// currency0 < currency1 (v4 ordering); track which side is the input token.
function sortedPool() {
  const a = CONFIG.pool.tokenIn, b = CONFIG.pool.tokenOut;
  const inIsZero = BigInt(a.address) < BigInt(b.address);
  return {
    currency0: inIsZero ? a.address : b.address,
    currency1: inIsZero ? b.address : a.address,
    zeroForOne: inIsZero, // selling the input token
  };
}

// --- flow -------------------------------------------------------------------
async function connectAndGate() {
  clearErr();
  try {
    const accts = await eth("eth_requestAccounts");
    state.address = (accts && accts[0]) || null;
    if (!state.address) throw new Error(t("err_no_account"));
    const chain = await eth("eth_chainId");
    if (String(chain).toLowerCase() !== CONFIG.chainIdHex) {
      await eth("wallet_switchEthereumChain", [{ chainId: CONFIG.chainIdHex }]);
    }
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
      chain: CONFIG.caip2,
      gateAddress: CONFIG.pool.accessGate,
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
  const p = CONFIG.pool;
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
  $("#credCard").classList.toggle("hidden", !state.allowed);
  $("#swapCard").classList.toggle("hidden", !state.allowed);
  if (state.credId) $("#credId").textContent = state.credId;
  $("#paySym").textContent = CONFIG.pool.tokenIn.symbol;
  $("#getSym").textContent = CONFIG.pool.tokenOut.symbol;

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
  const url = "https://sepolia.basescan.org/tx/" + encodeURIComponent(hash);
  const short = hash.length > 18 ? hash.slice(0, 10) + "…" + hash.slice(-6) : hash;
  return `<p class="mono"><a href="${esc(url)}">${esc(short)} ↗</a></p>`;
}

// --- helpers ----------------------------------------------------------------
function toUnits(amount, decimals) {
  // decimal string -> integer token units, without float drift.
  const [whole, frac = ""] = String(amount).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((whole || "0") + fracPadded);
}
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

$("#payAmount").addEventListener("input", () => {
  const v = parseFloat($("#payAmount").value || "0");
  const btn = $("#swapBtn");
  btn.disabled = !(v > 0);
  btn.textContent = v > 0 ? t("btn_swap") : t("btn_enter_amount");
  $("#getAmount").textContent = v > 0 ? t("quoted_onchain") : "0.0";
});
$("#swapBtn").addEventListener("click", doSwap);
$("#closeOverlay").addEventListener("click", () => overlay(false));

// --- boot -------------------------------------------------------------------
(async function boot() {
  let locale = "en";
  try { const info = await window.maknoon.device.info(); locale = (info && info.locale) || "en"; } catch (e) {}
  window.__uniLang = normLocale(locale);
  document.documentElement.lang = window.__uniLang;
  document.documentElement.dir = (window.__uniLang === "ar") ? "rtl" : "ltr";
  applyStaticI18n();
  $("#netChip").textContent = CONFIG.chainLabel;

  if (!hasEth()) { $("#gateBody").textContent = t("open_inside"); $("#gateBtn").disabled = true; return; }
  renderGate();
})();
