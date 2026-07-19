// UniswapV4 credential-gated swap (Beta). A retail swap over the generalized
// Maknoon web3 bridge (window.ethereum): multi-chain, eth_sendTransaction with
// contract calldata, and eth_signTypedData_v4.
//
// The chain is chosen in the top-right dropdown (all Maknoon EVM chains, in the
// wallet's order, each showing how many issuer pools it has). Picking a chain
// switches the wallet, filters the issuer pools to that chain, and lets the user
// add a pool manually. A pool may be credential-gated (an OnchainIdAccessGate the
// hook enforces) or a plain v4 pool (no hook) that anyone can swap. Signing and
// verification happen in native Maknoon sheets; this page never sees key material.

"use strict";

// ---------------------------------------------------------------------------
const CONFIG = {
  // The Access Issuer (issuer-backend): serves GET /v1/pools and runs
  // POST /v1/networks/{caip2}/access-issuer/grant (ADR-0058).
  issuerBaseUrl: "https://musnad-issuer.elabify.com",
  issuerDid: "did:elabify:sepolia:issuer:musnad",
  passportSchema: "elabify://schema/global/passport/v1",
  slippageBps: 50, // 0.50%, applied to the quote for the display-only minimum received
  defaultChainId: 84532, // Base Sepolia, when the registry is empty
};

// All Maknoon-wallet EVM chains in the wallet's display order (Ethereum first,
// then mainnets A-Z, then testnets Sepolia-first A-Z). Each carries its canonical
// Uniswap v4 infra (PoolManager / V4Quoter / PoolSwapTest) when deployed; chains
// without v4 (poolManager null) can't host a pool. `demoGate` + `demoHook` are the
// credential-gated demo deployment on our two chains; a manual pool there reuses
// them (gated), elsewhere a manual pool is a plain no-hook v4 pool (ungated).
// PoolSwapTest is a testnet-only helper, so mainnet pools quote but cannot swap.
const CHAINS = [
  // ---- mainnets ----
  { id: 1, label: "Ethereum", testnet: false, explorer: "https://etherscan.io",
    poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90", quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203", poolSwapTest: null,
    stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227" },
  { id: 42161, label: "Arbitrum One", testnet: false, explorer: "https://arbiscan.io",
    poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32", quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5", poolSwapTest: null,
    stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990" },
  { id: 43114, label: "Avalanche", testnet: false, explorer: "https://snowtrace.io",
    poolManager: "0x06380c0e0912312b5150364b9dc4542ba0dbbc85", quoter: "0xbe40675bb704506a3c2ccfb762dcfd1e979845c2", poolSwapTest: null,
    stateView: "0xc3c9e198c735a4b97e3e683f391ccbdd60b69286" },
  { id: 8453, label: "Base", testnet: false, explorer: "https://basescan.org",
    poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b", quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d", poolSwapTest: null,
    stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71" },
  { id: 56, label: "BNB Smart Chain", testnet: false, explorer: "https://bscscan.com",
    poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df", quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0", poolSwapTest: null,
    stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4" },
  { id: 999, label: "Hyperliquid EVM", testnet: false, explorer: null, poolManager: null, quoter: null, poolSwapTest: null },
  { id: 59144, label: "Linea", testnet: false, explorer: "https://lineascan.build", poolManager: null, quoter: null, poolSwapTest: null },
  { id: 5000, label: "Mantle", testnet: false, explorer: "https://mantlescan.xyz", poolManager: null, quoter: null, poolSwapTest: null },
  { id: 10, label: "OP Mainnet", testnet: false, explorer: "https://optimistic.etherscan.io",
    poolManager: "0x9a13f98cb987694c9f086b1f5eb990eea8264ec3", quoter: "0x1f3131a13296fb91c90870043742c3cdbff1a8d7", poolSwapTest: null,
    stateView: "0xc18a3169788f4f75a170290584eca6395c75ecdb" },
  { id: 137, label: "Polygon", testnet: false, explorer: "https://polygonscan.com",
    poolManager: "0x67366782805870060151383f4bbff9dab53e5cd6", quoter: "0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9", poolSwapTest: null,
    stateView: "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a" },
  { id: 1101, label: "Polygon zkEVM", testnet: false, explorer: "https://zkevm.polygonscan.com", poolManager: null, quoter: null, poolSwapTest: null },
  { id: 534352, label: "Scroll", testnet: false, explorer: "https://scrollscan.com", poolManager: null, quoter: null, poolSwapTest: null },
  { id: 324, label: "zkSync Era", testnet: false, explorer: "https://explorer.zksync.io", poolManager: null, quoter: null, poolSwapTest: null },
  // ---- testnets ----
  { id: 11155111, label: "Sepolia", testnet: true, explorer: "https://sepolia.etherscan.io",
    poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543", quoter: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227", poolSwapTest: "0x9b6b46e2c869aa39918db7f52f5557fe577b6eee",
    demoGate: "0x481b1EaC56190fF8690d64204aF85A100Ae5487f", demoHook: "0xE45807DafdCB2E6F1B95111930D00EC8FFDDc080",
    stateView: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c" },
  { id: 99999, label: "ADI Testnet", testnet: true, explorer: null, poolManager: null, quoter: null, poolSwapTest: null },
  { id: 421614, label: "Arbitrum Sepolia", testnet: true, explorer: "https://sepolia.arbiscan.io",
    poolManager: "0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317", quoter: "0x7de51022d70a725b508085468052e25e22b5c4c9", poolSwapTest: "0xf3a39c86dbd13c45365e57fb90fe413371f65af8",
    stateView: "0x9d467fa9062b6e9b1a46e26007ad82db116c67cb" },
  { id: 84532, label: "Base Sepolia", testnet: true, explorer: "https://sepolia.basescan.org",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408", quoter: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba", poolSwapTest: "0x8b5bcc363dde2614281ad875bad385e0a785d3b9",
    demoGate: "0x5af09be4e3675838Ae1728749424971B094228e8", demoHook: "0xBB75553378783dc1390a078E7C07c81EEF1A0080",
    stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4" },
  { id: 11155420, label: "OP Sepolia", testnet: true, explorer: "https://sepolia-optimism.etherscan.io", poolManager: null, quoter: null, poolSwapTest: null },
];
const ZERO_HOOK = "0x0000000000000000000000000000000000000000";
function chainById(id) { return CHAINS.find((c) => c.id === Number(id)) || null; }

// Function selectors (keccak256(signature)[0:4], via `cast sig`):
const SELECTOR = {
  approve:   "095ea7b3", // approve(address,uint256)
  isAllowed: "babcc539", // isAllowed(address)
  balanceOf: "70a08231", // balanceOf(address)
  decimals:  "313ce567", // decimals()
  symbol:    "95d89b41", // symbol()
  swap:      "2229d0b4", // swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)
  quote:     "aa9d21cb", // quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
  getSlot0:  "c815641c", // StateView.getSlot0(bytes32) -> (uint160 sqrtPriceX96,int24,uint24,uint24)
};

// Uniswap v4 TickMath sqrt-price bounds (swap price limits).
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const $ = (s) => document.querySelector(s);
const hasEth = () => !!(window.ethereum && typeof window.ethereum.request === "function");

// chainId = the selected chain (top-right). pools = every issuer/manual pool;
// pool = the selected pool on the current chain (null if the chain has none).
const state = { address: null, allowed: false, credId: null, chainId: CONFIG.defaultChainId, pools: [], pool: null, menuOpen: false };

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

function encodeApprove(spender, amount) {
  return "0x" + SELECTOR.approve + encAddress(spender) + encUint(amount);
}

// --- keccak256 (pure JS, BigInt lanes; strict-CSP-safe, no external lib) -----
// Needed to derive a v4 poolId. A v4 pool has NO contract address: its identity
// is keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)) inside
// the single PoolManager. Validated against the standard keccak-256 vectors and
// a live StateView.getSlot0 read before shipping.
const KMASK64 = (1n << 64n) - 1n;
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39,
  41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const kIdx = (x, y) => x + 5 * y;
function kRotl(v, n) { n %= 64n; if (n === 0n) return v & KMASK64; return ((v << n) | (v >> (64n - n))) & KMASK64; }
function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = s[kIdx(x, 0)] ^ s[kIdx(x, 1)] ^ s[kIdx(x, 2)] ^ s[kIdx(x, 3)] ^ s[kIdx(x, 4)];
    const D = new Array(5);
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ kRotl(C[(x + 1) % 5], 1n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[kIdx(x, y)] ^= D[x];
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[kIdx(y, (2 * x + 3 * y) % 5)] = kRotl(s[kIdx(x, y)], BigInt(KECCAK_ROT[kIdx(x, y)]));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[kIdx(x, y)] = B[kIdx(x, y)] ^ ((~B[kIdx((x + 1) % 5, y)] & KMASK64) & B[kIdx((x + 2) % 5, y)]);
    s[0] ^= KECCAK_RC[round];
  }
}
function keccak256Bytes(msg) {
  const rate = 136;
  const s = new Array(25).fill(0n);
  const padLen = rate - (msg.length % rate);
  const total = msg.length + padLen;
  const p = new Uint8Array(total);
  p.set(msg);
  p[msg.length] |= 0x01;
  p[total - 1] |= 0x80;
  for (let b = 0; b < total; b += rate) {
    for (let i = 0; i < rate; i += 8) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(p[b + i + j]);
      s[i / 8] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((s[Math.floor(i / 8)] >> BigInt(8 * (i % 8))) & 0xffn);
  return out;
}
function hexToBytes(h) {
  const hn = stripHex(h);
  const out = new Uint8Array(hn.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hn.substr(i * 2, 2), 16);
  return out;
}
function keccak256Hex(hexNoPrefix) {
  return Array.from(keccak256Bytes(hexToBytes(hexNoPrefix))).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// v4 PoolId = keccak256(abi.encode(PoolKey{currency0,currency1,fee,tickSpacing,hooks})).
// currency0 MUST be the numerically-smaller token address.
function computePoolId(currency0, currency1, fee, tickSpacing, hooks) {
  const enc = encAddress(currency0) + encAddress(currency1) + encUint(fee) + encInt(tickSpacing) + encAddress(hooks);
  return "0x" + keccak256Hex(enc);
}

// PoolSwapTest.swap(key, params, testSettings, hookData) calldata.
function encodeSwap(key, params, testSettings, hookData) {
  const head =
    encAddress(key.currency0) + encAddress(key.currency1) +
    encUint(key.fee) + encInt(key.tickSpacing) + encAddress(key.hooks) +
    encBool(params.zeroForOne) + encInt(params.amountSpecified) + encUint(params.sqrtPriceLimitX96) +
    encBool(testSettings.takeClaims) + encBool(testSettings.settleUsingBurn);
  const offset = encUint(11 * 32);
  const hd = stripHex(hookData || "0x");
  const hdLen = encUint(hd.length / 2);
  const hdBody = hd.length ? hd.padEnd(Math.ceil(hd.length / 64) * 64, "0") : "";
  return "0x" + SELECTOR.swap + head + offset + hdLen + hdBody;
}

// V4Quoter.quoteExactInputSingle(QuoteExactSingleParams) calldata.
function encodeQuote(key, zeroForOne, exactAmount) {
  const struct =
    encAddress(key.currency0) + encAddress(key.currency1) +
    encUint(key.fee) + encInt(key.tickSpacing) + encAddress(key.hooks) +
    encBool(zeroForOne) + encUint(exactAmount) + encUint(8 * 32) +
    encUint(0);
  return "0x" + SELECTOR.quote + encUint(32) + struct;
}

// Real receive estimate via the Uniswap v4 Quoter (eth_call). `from` is the
// connected wallet so a gated pool's beforeSwap hook passes during simulation.
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
    return BigInt("0x" + hex.slice(0, 64));
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
  return /[1-9a-f]/.test(stripHex(out).slice(-1));
}
async function readDecimals(addr) {
  const h = stripHex(await ethCall(addr, "0x" + SELECTOR.decimals));
  return h ? Number(BigInt("0x" + h)) : 18;
}
async function readSymbol(addr) {
  const h = stripHex(await ethCall(addr, "0x" + SELECTOR.symbol));
  if (h.length >= 128) {
    const len = Number(BigInt("0x" + h.slice(64, 128)));
    const ascii = hexToAscii(h.slice(128, 128 + len * 2));
    if (ascii) return ascii;
  }
  return shortAddr(addr);
}
async function hydrateTokens() {
  const p = state.pool;
  if (!p) return;
  for (const tok of [p.tokenIn, p.tokenOut]) {
    if (tok.decimals == null) { try { tok.decimals = await readDecimals(tok.address); } catch (e) { tok.decimals = 18; } }
    if (tok.symbol == null) { try { tok.symbol = await readSymbol(tok.address); } catch (e) { tok.symbol = shortAddr(tok.address); } }
  }
  // Auto-name a manual pool from its token symbols once known.
  if (p.autoName) p.name = `${p.tokenIn.symbol} / ${p.tokenOut.symbol}`;
}

function sortedPool() {
  const a = state.pool.tokenIn, b = state.pool.tokenOut;
  const inIsZero = BigInt(a.address) < BigInt(b.address);
  return { currency0: inIsZero ? a.address : b.address, currency1: inIsZero ? b.address : a.address, zeroForOne: inIsZero };
}

// StateView.getSlot0(poolId) reads pool state WITHOUT triggering a hook's
// beforeSwap, so it works even on a credential-gated pool from an unverified
// caller. Returns the sqrtPriceX96 (0 => the pool is not initialized) or null.
async function readSlot0(stateView, poolId) {
  const out = await ethCall(stateView, "0x" + SELECTOR.getSlot0 + stripHex(poolId));
  const hex = stripHex(out);
  if (hex.length < 64) return null;
  return BigInt("0x" + hex.slice(0, 64));
}

// Discover a v4 pool from just its token pair. A v4 pool has no address, so we
// probe candidate PoolKeys ({demo gated hook, then no-hook} x common fee tiers)
// via getSlot0 and return the first initialized one, tagging whether it is the
// chain's demo credential-gated pool or a plain pool. Arbitrary third-party
// hooks cannot be guessed, so on a chain with no demo deployment only plain
// (no-hook) pools are discoverable.
async function probePool(chainId, tokenA, tokenB) {
  const c = chainById(chainId);
  if (!c || !c.poolManager || !c.stateView) return { error: "no_v4" };
  const [c0, c1] = BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  const hooks = [];
  if (c.demoHook) hooks.push({ hook: c.demoHook, gate: c.demoGate || null });
  hooks.push({ hook: ZERO_HOOK, gate: null });
  const tiers = [{ fee: 3000, ts: 60 }, { fee: 500, ts: 10 }, { fee: 100, ts: 1 }, { fee: 10000, ts: 200 }];
  for (const h of hooks) {
    for (const tr of tiers) {
      const id = computePoolId(c0, c1, tr.fee, tr.ts, h.hook);
      let sqrt = null;
      try { sqrt = await readSlot0(c.stateView, id); } catch (e) { sqrt = null; }
      if (sqrt != null && sqrt !== 0n) {
        return { found: true, fee: tr.fee, tickSpacing: tr.ts, hook: h.hook, gate: h.gate };
      }
    }
  }
  return { found: false };
}

// --- pool discovery ---------------------------------------------------------
// Build a pool from a row (issuer registry OR manual). Infra falls back to the
// chain's v4 defaults; `accessGate` may be null (ungated / no-hook pool).
function makePool(row, source) {
  const chainId = Number(row.chainId);
  const c = chainById(chainId) || {};
  const gate = row.gate || null;
  return {
    name: row.name || (gate ? "Gated pool" : "Pool"),
    autoName: !!row.autoName,
    chainId,
    chainIdHex: "0x" + chainId.toString(16),
    caip2: row.caip2 || ("eip155:" + chainId),
    chainLabel: c.label || ("Chain " + chainId),
    explorer: row.explorer || c.explorer || null,
    poolManager: row.poolManager || c.poolManager || null,
    poolSwapTest: row.poolSwapTest || c.poolSwapTest || null,
    quoter: row.quoter || c.quoter || null,
    accessGate: gate,
    hook: row.hook || ZERO_HOOK,
    fee: Number(row.fee != null ? row.fee : 3000),
    tickSpacing: Number(row.tickSpacing != null ? row.tickSpacing : 60),
    tokenIn:  { address: row.tokenA, symbol: null, decimals: null },
    tokenOut: { address: row.tokenB, symbol: null, decimals: null },
    source: source || { kind: "manual" },
  };
}

// Read the issuer registry through the native bridge (the sandbox has no fetch).
// No built-in fallback: pools come only from the issuer or the user's manual entry.
async function loadPools() {
  let rows = [];
  try {
    if (window.maknoon && window.maknoon.pools && window.maknoon.pools.list) {
      const res = await window.maknoon.pools.list({ issuerUrl: CONFIG.issuerBaseUrl });
      if (res && Array.isArray(res.pools)) rows = res.pools;
    }
  } catch (e) { /* registry unreachable: user can still add manually */ }
  let host = "";
  try { host = new URL(CONFIG.issuerBaseUrl).host; } catch (e) {}
  state.pools = rows.map((r) => makePool(r, { kind: "issuer", host }));
  // Default the chain to the first issuer pool's chain, else Base Sepolia.
  state.chainId = state.pools[0] ? state.pools[0].chainId : CONFIG.defaultChainId;
}

function poolsOnChain(id) { return state.pools.filter((p) => p.chainId === Number(id)); }
function countByChain(id) { return poolsOnChain(id).length; }

// --- chain dropdown (top-right) ---------------------------------------------
function renderChainChip() {
  const c = chainById(state.chainId);
  $("#netChip").textContent = (c ? c.label : "Chain " + state.chainId) + " ▾";
}

function renderChainMenu() {
  const menu = $("#chainMenu");
  menu.innerHTML = CHAINS.map((c) => {
    const n = countByChain(c.id);
    const noV4 = !c.poolManager;
    const cls = "chain-row" + (c.id === state.chainId ? " active" : "") + (n === 0 ? " empty" : "") + (noV4 ? " nov4" : "");
    return `<button type="button" class="${cls}" data-chain="${c.id}">
        <span class="chain-name">${esc(c.label)}</span>
        <span class="chain-count">${noV4 ? "—" : "(" + n + ")"}</span>
      </button>`;
  }).join("");
  menu.querySelectorAll(".chain-row").forEach((b) =>
    b.addEventListener("click", () => selectChain(Number(b.dataset.chain))));
  menu.classList.toggle("hidden", !state.menuOpen);
}

function toggleChainMenu(open) {
  state.menuOpen = open != null ? open : !state.menuOpen;
  renderChainMenu();
}

// Switch chains: filter pools, pick the first on that chain, align the wallet
// (silent switch), re-hydrate + re-gate.
async function selectChain(id) {
  state.chainId = Number(id);
  state.menuOpen = false;
  state.allowed = false;
  state.credId = null;
  const list = poolsOnChain(id);
  state.pool = list[0] || null;
  renderChainChip();
  renderChainMenu();
  populatePoolSelect();
  if (state.address) { await connectAndGate(); } else { renderGate(); }
}

function populatePoolSelect() {
  const list = poolsOnChain(state.chainId);
  const sel = $("#poolSelect");
  sel.innerHTML = list.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
  if (state.pool) sel.value = String(Math.max(0, list.indexOf(state.pool)));
  $("#poolEmpty").classList.toggle("hidden", list.length > 0);
  renderPoolSource();
  // A chain with no v4 infra can't host a manual pool; disable the form.
  const c = chainById(state.chainId);
  const noV4 = !c || !c.poolManager;
  $("#poolManual").classList.toggle("hidden", noV4);
  $("#poolNoV4").classList.toggle("hidden", !noV4);
}

function renderPoolSource() {
  const cap = $("#poolSource");
  const p = state.pool;
  if (!p) { cap.textContent = ""; return; }
  cap.textContent = p.source && p.source.kind === "issuer"
    ? t("src_issuer", { host: p.source.host })
    : t("src_manual");
}

async function selectPool(i) {
  const list = poolsOnChain(state.chainId);
  if (!list[i]) return;
  state.pool = list[i];
  state.allowed = false;
  state.credId = null;
  renderPoolSource();
  if (state.address) { await connectAndGate(); } else { renderGate(); }
}

// --- flow -------------------------------------------------------------------
async function connectAndGate() {
  clearErr();
  if (!state.pool) { showErr(new Error(t("err_no_pool"))); return; }
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
  // Ungated pools (no accessGate) are open: connecting is enough.
  if (!state.pool.accessGate) { state.allowed = true; renderGate(); return; }
  try {
    state.allowed = await isAllowed(state.address);
  } catch (e) {
    state.allowed = false;
  }
  renderGate();
}

// Verify to access (gated pools only): prove personhood + sanctions-clean via a
// passport, prove control of the EVM address, let the issuer write the on-chain grant.
async function verifyToAccess() {
  clearErr();
  overlay(true);
  renderSteps([{ key: "grant", label: t("step_granting") }]);
  setStep("grant", "active");
  try {
    const res = await window.maknoon.poolAccess.grant({
      issuerUrl: CONFIG.issuerBaseUrl,
      issuerDid: CONFIG.issuerDid,
      chain: state.pool.caip2,
      gateAddress: state.pool.accessGate,
    });
    if (!res || !res.granted) {
      throw new Error((res && (res.reason || res.message)) || t("err_verify_denied"));
    }
    state.allowed = await isAllowed(state.address).catch(() => true);
    for (let i = 0; i < 8 && !state.allowed; i++) {
      await sleep(1500);
      state.allowed = await isAllowed(state.address).catch(() => false);
    }
    state.credId = res.walletAddress || state.address;
    setStep("grant", "ok");
    result("ok", `<h3>${esc(t("access_granted"))}</h3>`);
    await sleep(700);
    overlay(false);
    renderGate();
  } catch (e) {
    const msg = (e && (e.message || String(e))) || t("err_generic");
    if (/reject|denied|cancel/i.test(msg)) { overlay(false); return; }
    setStep("grant", "bad");
    result("bad", `<h3>${esc(t("verify_failed"))}</h3><p>${esc(msg)}</p>`);
  }
}

// --- swap -------------------------------------------------------------------
async function doSwap() {
  clearErr();
  const raw = parseFloat($("#payAmount").value || "0");
  if (!(raw > 0)) return;
  const p = state.pool;
  if (!p.poolSwapTest) { showErr(new Error(t("err_no_router"))); return; }
  const amountUnits = toUnits(raw, p.tokenIn.decimals);
  const sp = sortedPool();

  overlay(true);
  $("#openWalletBtn").classList.add("hidden"); // shown only after a successful swap
  renderSteps([{ key: "approve", label: t("step_approve") }, { key: "swap", label: t("step_swap") }]);
  try {
    setStep("approve", "active");
    const approveTx = { from: state.address, to: p.tokenIn.address, data: encodeApprove(p.poolSwapTest, amountUnits) };
    await eth("eth_sendTransaction", [approveTx]);
    setStep("approve", "ok");

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
    // Offer "Open wallet" only if the host supports it (older builds won't).
    if (window.maknoon && window.maknoon.walletView) $("#openWalletBtn").classList.remove("hidden");
  } catch (e) {
    result("bad", `<h3>${esc(t("swap_failed"))}</h3><p>${esc(e && (e.message || String(e)))}</p>`);
  }
}

// --- rendering --------------------------------------------------------------
function renderGate() {
  const connected = !!state.address;
  const p = state.pool;
  const gated = !!(p && p.accessGate);
  // The credential card only makes sense for a gated pool.
  $("#credCard").classList.toggle("hidden", !state.allowed || !gated);
  $("#swapCard").classList.toggle("hidden", !state.allowed);
  if (state.credId) $("#credId").textContent = state.credId;
  $("#paySym").textContent = (p && p.tokenIn.symbol) || "";
  $("#getSym").textContent = (p && p.tokenOut.symbol) || "";
  if (state.allowed && p) {
    $("#feeVal").textContent = (p.fee / 10000).toFixed(2) + "%";
    $("#swapDetail").classList.remove("hidden");
    if (!p.poolSwapTest) { $("#swapBtn").disabled = true; $("#swapBtn").textContent = t("err_no_router"); }
  }

  const card = $("#gateCard");
  if (state.allowed) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  if (!connected) {
    $("#gateIcon").textContent = "🔒";
    $("#gateTitle").textContent = gated ? t("gate_connect_title") : t("gate_connect_open_title");
    $("#gateBody").textContent = !p ? t("gate_no_pool_body") : (gated ? t("gate_connect_body") : t("gate_connect_open_body"));
    $("#gateBtn").textContent = t("btn_connect");
    $("#gateBtn").disabled = !p;
    $("#gateBtn").onclick = connectAndGate;
  } else {
    $("#gateIcon").textContent = "🪪";
    $("#gateTitle").textContent = t("gate_verify_title");
    $("#gateBody").textContent = t("gate_verify_body");
    $("#gateBtn").textContent = t("btn_verify");
    $("#gateBtn").disabled = false;
    $("#gateBtn").onclick = verifyToAccess;
  }
}

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
  $("#minVal").textContent = `${fmtAmt(min, p.tokenOut.decimals)} ${p.tokenOut.symbol}`;
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

// --- manual pool entry (scoped to the selected chain) -----------------------
function mfVal(id) { return ($("#" + id).value || "").trim(); }
function mfAddr(id) {
  const v = mfVal(id);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(t("mf_bad_addr"));
  return v;
}
// Add a pool from just a token pair (+ optional name). Infra (PoolManager /
// Quoter / router / explorer) comes from the chain's v4 deployment; the fee
// tier and whether the pool is credential-gated are DISCOVERED on-chain by
// probing candidate PoolKeys with getSlot0 (a v4 pool has no address to paste).
async function addManualPool() {
  const err = $("#mf_err");
  const btn = $("#mf_add");
  err.classList.add("hidden");
  const c = chainById(state.chainId);
  let tokenA, tokenB;
  try {
    if (!c || !c.poolManager || !c.stateView) throw new Error(t("mf_no_v4"));
    if (!hasEth()) throw new Error(t("open_inside"));
    tokenA = mfAddr("mf_tokenA");
    tokenB = mfAddr("mf_tokenB");
    if (tokenA.toLowerCase() === tokenB.toLowerCase()) throw new Error(t("mf_same_token"));
  } catch (e) {
    err.textContent = (e && e.message) || String(e);
    err.classList.remove("hidden");
    return;
  }

  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("mf_probing");
  try {
    const res = await probePool(state.chainId, tokenA, tokenB);
    if (res.error === "no_v4") throw new Error(t("mf_no_v4"));
    if (!res.found) throw new Error(t("mf_not_found"));
    const row = {
      name: mfVal("mf_name") || undefined,
      autoName: !mfVal("mf_name"),
      chainId: c.id,
      caip2: "eip155:" + c.id,
      poolManager: c.poolManager,
      quoter: c.quoter,
      poolSwapTest: c.poolSwapTest,
      explorer: c.explorer,
      gate: res.gate,          // discovered: the demo gate if gated, else null
      hook: res.hook,          // discovered: demo hook, else no hook
      fee: res.fee,            // discovered fee tier
      tickSpacing: res.tickSpacing,
      tokenA,
      tokenB,
    };
    const pool = makePool(row, { kind: "manual" });
    state.pools.push(pool);
    populatePoolSelect();
    const list = poolsOnChain(state.chainId);
    $("#mf_name").value = ""; $("#mf_tokenA").value = ""; $("#mf_tokenB").value = "";
    selectPool(list.length - 1);
  } catch (e) {
    err.textContent = (e && e.message) || String(e);
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

// --- helpers ----------------------------------------------------------------
function toUnits(amount, decimals) {
  const [whole, frac = ""] = String(amount).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((whole || "0") + fracPadded);
}
function fromUnits(units, decimals) {
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
// Display amount: full-precision fromUnits (up to `decimals` places) overflows
// the swap box for 18-decimal tokens, so trim to a readable 6 places for the UI.
// The actual swap always uses the full-precision BigInt, not this string.
function fmtAmt(units, decimals) { return trimNum(parseFloat(fromUnits(units, decimals))); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function clearErr() { const e = $("#gateError"); e.classList.add("hidden"); e.textContent = ""; }
function showErr(e) {
  const msg = (e && (e.message || String(e))) || t("err_generic");
  if (/reject|denied|cancel/i.test(msg)) return;
  const el = $("#gateError"); el.textContent = msg; el.classList.remove("hidden");
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Flip the swap direction (tap the arrow between the tokens). Swaps tokenIn <->
// tokenOut on the pool, updates the symbols, and re-quotes the current amount in
// the new direction. sortedPool() re-derives zeroForOne from the addresses, so
// the quote + swap + approve all follow the flipped direction automatically.
function reverseDirection() {
  const p = state.pool;
  if (!p) return;
  const tmp = p.tokenIn;
  p.tokenIn = p.tokenOut;
  p.tokenOut = tmp;
  $("#paySym").textContent = p.tokenIn.symbol || "";
  $("#getSym").textContent = p.tokenOut.symbol || "";
  $("#payAmount").dispatchEvent(new Event("input"));
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
  $("#getAmount").textContent = t("quoted_onchain");
  const seq = ++quoteSeq;
  const out = await quoteReceive(toUnits(raw, state.pool.tokenIn.decimals));
  if (seq !== quoteSeq) return;
  if (out != null) $("#getAmount").textContent = fmtAmt(out, state.pool.tokenOut.decimals);
  renderSwapDetail(raw, out);
});
$("#swapBtn").addEventListener("click", doSwap);
$("#reverseBtn").addEventListener("click", reverseDirection);
$("#closeOverlay").addEventListener("click", () => overlay(false));
// Leave the mini app and open the exact wallet + chain the swap used (the host
// resyncs it and shows the pending tx). The bridge dismisses the mini app.
$("#openWalletBtn").addEventListener("click", () => {
  try {
    if (window.maknoon && window.maknoon.walletView) {
      window.maknoon.walletView.open({ chainId: state.chainId, address: state.address });
    }
  } catch (e) { /* navigation is best-effort */ }
  overlay(false);
});
$("#poolSelect").addEventListener("change", (e) => selectPool(Number(e.target.value)));
$("#mf_add").addEventListener("click", addManualPool);
$("#netChip").addEventListener("click", (e) => { e.stopPropagation(); toggleChainMenu(); });
document.addEventListener("click", () => { if (state.menuOpen) toggleChainMenu(false); });

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
  const list = poolsOnChain(state.chainId);
  state.pool = list[0] || null;
  renderChainChip();
  renderChainMenu();
  populatePoolSelect();
  renderGate();
})();
