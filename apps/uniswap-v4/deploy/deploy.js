/* Self-service deploy tool for a credential-gated UniswapV4 pool. Public, static, MetaMask-only:
 * the operator's own browser wallet signs every tx, so there is no server, no raw key, and no
 * secret. Served from GitHub Pages (no python). It CANNOT run inside the Maknoon wallet mini-app
 * host, because that bridge rejects contract-creation txs (eth_sendTransaction requires `to`).
 *
 * Flow: connect MetaMask on the chosen chain -> for each of two tokens either deploy a fresh
 * MockConfigurableERC20(name,symbol,decimals) or reuse an existing ERC-20 (sanity-checked) ->
 * CREATE2-mine + deploy MusnadAccessHook(poolManager, gate) (reused if already deployed) ->
 * PoolManager.initialize at a decimal- AND rate-aware price -> seed FULL-RANGE liquidity via a
 * fresh PoolModifyLiquidityTest -> print a registry row (JSON + CSV) for the dapp/issuer registry.
 */

/* global ethers */

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C'; // canonical deterministic factory
const BEFORE_SWAP_FLAG = 1n << 7n; // Uniswap v4 Hooks.BEFORE_SWAP_FLAG
const FLAG_MASK = (1n << 14n) - 1n;
const Q96 = 1n << 96n;
// Full-range position: min/max usable tick aligned to tickSpacing. Full range always brackets the
// current tick, so seeded liquidity stays active at any starting price.
const TICK_LOWER = -887220;
const TICK_UPPER = 887220;
const TICK_SPACING = 60;
const FEE = 3000;
// Target ~1,000,000 units of value on each side of the pool (deep, low-slippage for a demo).
const TARGET_UNITS = 1_000_000n;

// Reliable read + confirmation-polling RPC per chain (MetaMask's default endpoint
// rate-limits under tx polling). Chains not listed fall back to MetaMask's own
// provider for reads, so no RPC input is needed in the form.
const DEFAULT_RPC = {
  84532: 'https://base-sepolia-rpc.publicnode.com', // Base Sepolia
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com', // Ethereum Sepolia
};

// Per-chain infra defaults. ONLY the two chains we operate get prefilled; every
// other chain (mainnets, other testnets) starts blank, so the operator must paste
// + verify the addresses for that chain. `quoter` is the Uniswap V4Quoter the
// mini-app uses for its receive estimate (recorded in the registry row, not used
// by the deploy itself).
const CHAIN_DEFAULTS = {
  84532: { // Base Sepolia
    poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
    gate: '0x5af09be4e3675838Ae1728749424971B094228e8',
    poolSwapTest: '0x8b5bcc363dde2614281ad875bad385e0a785d3b9',
    quoter: '0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba',
  },
  11155111: { // Ethereum Sepolia
    poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
    gate: '0x481b1EaC56190fF8690d64204aF85A100Ae5487f',
    poolSwapTest: '0x9b6b46e2c869aa39918db7f52f5557fe577b6eee',
    quoter: '0x61b3f2011a92d183c7dbadbda940a7555ccf9227',
  },
};

const DEFAULTS = {
  chainId: 84532,
  tokenA: { name: 'Mock AUDD', symbol: 'AUDD', decimals: 6 },
  tokenB: { name: 'Mock AUD Money Market Fund', symbol: 'MMF', decimals: 18 },
  rate: '1', // tokenB per tokenA, in value
};

const POOL_MANAGER_ABI = [
  'function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, uint160 sqrtPriceX96) returns (int24)',
];
const LP_ROUTER_ABI = [
  'constructor(address _manager)',
  'function modifyLiquidity((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, (int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt) params, bytes hookData) payable returns (bytes)',
];
const ERC20_ABI = [
  'function approve(address spender,uint256 amount) returns (bool)',
  'function mint(address to,uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];
const CONFIGURABLE_TOKEN_ABI = ['constructor(string name,string symbol,uint8 decimals)'];
const GATE_ABI = ['function isAllowed(address) view returns (bool)'];

const state = {
  eip1193: null,
  provider: null,
  reader: null,
  signer: null,
  account: null,
  artifacts: null,
  chainId: DEFAULTS.chainId,
  deployed: {},
};

const $ = (id) => document.getElementById(id);
function log(msg) {
  const el = $('log');
  const line = document.createElement('div');
  line.textContent = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function fail(e) {
  console.error(e);
  log('ERROR: ' + (e?.info?.error?.message || e?.shortMessage || e?.message || String(e)));
}

// ---- price math (decimal + rate aware) ----

// Integer square root for bigint (Newton's method).
function isqrt(n) {
  if (n < 2n) return n < 0n ? 0n : n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + n / x) >> 1n; }
  return x;
}

// Parse a positive decimal rate string into an exact { num, den } fraction.
function parseRate(s) {
  const t = String(s || '1').trim();
  if (!/^\d*\.?\d+$/.test(t)) throw new Error(`Bad rate "${s}" (use e.g. 1, 1.5, 0.25)`);
  const [whole, frac = ''] = t.split('.');
  const num = BigInt((whole || '0') + frac) || 1n;
  const den = 10n ** BigInt(frac.length);
  if (num === 0n) throw new Error('Rate must be > 0');
  return { num, den };
}

// sqrtPriceX96 for currency1-per-currency0 raw price = (num * 10^dec1) / (den * 10^dec0).
// (Decimal-blind sqrt(1)*2^96 is the classic bug: 1 AUDD (6dec) -> ~1e-12 MMF (18dec).)
function sqrtPriceX96For(dec0, dec1, num, den) {
  const ratioX192 = (num * (10n ** BigInt(dec1)) << 192n) / (den * (10n ** BigInt(dec0)));
  return isqrt(ratioX192);
}

// Populate fees + gas from the reliable reader; MetaMask signs, assigns nonce, broadcasts.
async function sendTx(req, label) {
  const fee = await state.reader.getFeeData();
  const gasLimit = ((await state.reader.estimateGas({ from: state.account, ...req })) * 12n) / 10n;
  const feeFields = fee.maxFeePerGas
    ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.maxFeePerGas, type: 2 }
    : { gasPrice: fee.gasPrice, type: 0 };
  const sent = await state.signer.sendTransaction({ ...req, gasLimit, chainId: state.chainId, ...feeFields });
  if (label) log(`${label}: ${sent.hash}`);
  return state.reader.waitForTransaction(sent.hash);
}

async function loadArtifacts() {
  if (state.artifacts) return state.artifacts;
  const res = await fetch('artifacts.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('artifacts.json not found next to this page');
  state.artifacts = (await res.json()).artifacts;
  return state.artifacts;
}

// Pick the injected provider via EIP-6963 (prefer MetaMask when several wallets are installed).
async function pickProvider() {
  const found = new Map();
  const onAnnounce = (e) => found.set(e.detail.info.rdns, e.detail);
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, 350));
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  if (found.size > 0) {
    log(`wallets: ${[...found.values()].map((v) => v.info.name).join(', ')}`);
    const chosen = found.get('io.metamask') ?? [...found.values()][0];
    log(`using ${chosen.info.name}`);
    return chosen.provider;
  }
  if (window.ethereum) { log('using window.ethereum'); return window.ethereum; }
  throw new Error('no EVM wallet extension found');
}

// The chain from the dropdown, or the custom field when "Custom chain ID…" is picked.
function selectedChainId() {
  const sel = $('chainSelect').value;
  if (sel === 'custom') {
    const c = parseInt($('chainIdCustom').value.trim(), 10);
    if (!Number.isFinite(c) || c <= 0) throw new Error('Enter a valid custom chain ID');
    return c;
  }
  return parseInt(sel, 10) || DEFAULTS.chainId;
}

const INFRA_FIELDS = ['poolManager', 'gate', 'poolSwapTest', 'quoter'];

// Fill (or blank) the infra inputs for the selected chain. Only the chains in
// CHAIN_DEFAULTS have known addresses; every other chain blanks the fields so the
// operator supplies + verifies them. Re-runs verification for whatever is filled.
function applyChainDefaults() {
  let chainId;
  try { chainId = selectedChainId(); } catch (e) { chainId = null; }
  const d = (chainId && CHAIN_DEFAULTS[chainId]) || {};
  for (const id of INFRA_FIELDS) {
    $(id).value = d[id] || '';
    verifyField(id);
  }
}

// A read provider for contract sanity checks before/without a wallet connection:
// the live reader if connected, else a known per-chain RPC, else none.
function fieldReader() {
  if (state.reader) return state.reader;
  let cid; try { cid = selectedChainId(); } catch (e) { return null; }
  return DEFAULT_RPC[cid] ? new ethers.JsonRpcProvider(DEFAULT_RPC[cid], cid) : null;
}

// Sanity-check one infra address and reflect it in the field's ✓/✗ indicator:
// blank -> neutral, non-address -> ✗, no reader -> "?", has code -> ✓, else ✗.
async function verifyField(id) {
  const box = $(id + 'Chk');
  if (!box) return;
  const addr = $(id).value.trim();
  const set = (cls, mark, title) => { box.className = 'verified-chk ' + cls; box.textContent = mark; box.title = title; };
  if (!addr) { set('', '', ''); return; }
  if (!ethers.isAddress(addr)) { set('bad', '✗', 'not a valid address'); return; }
  const reader = fieldReader();
  if (!reader) { set('pending', '?', 'connect (or pick a known chain) to verify'); return; }
  set('pending', '…', 'checking');
  try {
    const code = await reader.getCode(addr);
    const ok = code && code !== '0x';
    set(ok ? 'ok' : 'bad', ok ? '✓' : '✗', ok ? 'contract verified on-chain' : 'no contract code at this address');
  } catch (e) { set('pending', '?', 'could not reach the chain to verify'); }
}

async function connect() {
  const chainId = selectedChainId();
  state.chainId = chainId;
  const chainHex = '0x' + chainId.toString(16);
  const eth = (state.eip1193 = await pickProvider());
  await eth.request({ method: 'eth_requestAccounts' });
  const current = await eth.request({ method: 'eth_chainId' });
  if (current !== chainHex) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
    } catch (switchErr) {
      if (switchErr && switchErr.code === 4902 && DEFAULT_RPC[chainId]) {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [{ chainId: chainHex, chainName: `Chain ${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [DEFAULT_RPC[chainId]], blockExplorerUrls: [] }],
        });
      } else if (switchErr && switchErr.code === 4902) {
        throw new Error(`Add chain ${chainId} to MetaMask first, then reconnect`);
      } else { throw switchErr; }
    }
  }
  state.provider = new ethers.BrowserProvider(eth);
  // Reads + confirmation polling: a known reliable RPC per chain, else MetaMask's
  // own provider (dodges MetaMask's rate-limited default endpoint on common chains).
  state.reader = DEFAULT_RPC[chainId] ? new ethers.JsonRpcProvider(DEFAULT_RPC[chainId], chainId) : state.provider;
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  await loadArtifacts();
  $('account').textContent = state.account;
  log(`connected ${state.account} on chain ${chainId}`);
  INFRA_FIELDS.forEach(verifyField); // now that we have a live reader
  $('btn-deploy').disabled = false;
  $('btn-mint').disabled = false;
}

async function deployBytecode(name, abi, args = []) {
  const factory = new ethers.ContractFactory(abi, state.artifacts[name].bytecode, state.signer);
  const deployTx = await factory.getDeployTransaction(...args);
  const rcpt = await sendTx({ data: deployTx.data }, `deploy ${name}`);
  if (!rcpt.contractAddress) throw new Error(`${name} deploy produced no address`);
  log(`${name} at ${rcpt.contractAddress}`);
  return rcpt.contractAddress;
}

// Sanity-check + read metadata of an existing ERC-20 (reuse path).
async function readExistingToken(addr) {
  if (!ethers.isAddress(addr)) throw new Error(`Not an address: ${addr}`);
  const code = await state.reader.getCode(addr);
  if (!code || code === '0x') throw new Error(`No contract code at ${addr}`);
  const c = new ethers.Contract(addr, ERC20_ABI, state.reader);
  const [decimals, symbol, name] = await Promise.all([c.decimals(), c.symbol().catch(() => '?'), c.name().catch(() => '?')]);
  log(`existing token ${addr}: ${symbol} "${name}" (${decimals} dec)`);
  return { address: ethers.getAddress(addr), decimals: Number(decimals), symbol, name, deployed: false };
}

// Resolve token side `ab` ('A'|'B'): deploy a fresh MockConfigurableERC20 or reuse an existing one.
async function resolveToken(ab) {
  const mode = document.querySelector(`input[name="mode${ab}"]:checked`).value;
  if (mode === 'existing') {
    return readExistingToken($(`addr${ab}`).value.trim());
  }
  const name = $(`name${ab}`).value.trim() || `Token ${ab}`;
  const symbol = $(`symbol${ab}`).value.trim() || ab;
  const decimals = parseInt($(`decimals${ab}`).value.trim() || '18', 10);
  const addr = await deployBytecode('MockConfigurableERC20', CONFIGURABLE_TOKEN_ABI, [name, symbol, decimals]);
  return { address: addr, decimals, symbol, name, deployed: true };
}

function mineHook(initcode) {
  const initHash = ethers.keccak256(initcode);
  for (let s = 0; s < 500000; s++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(s), 32);
    const addr = ethers.getCreate2Address(CREATE2_DEPLOYER, salt, initHash);
    if ((BigInt(addr) & FLAG_MASK) === BEFORE_SWAP_FLAG) return { salt, addr };
    if (s % 20000 === 0) log(`mining hook salt... ${s}`);
  }
  throw new Error('no CREATE2 salt with BEFORE_SWAP_FLAG');
}

async function sanityCheckInfra(poolManager, gate, poolSwapTest, quoter) {
  for (const [label, addr] of [['poolManager', poolManager], ['gate', gate], ['poolSwapTest', poolSwapTest]]) {
    if (!ethers.isAddress(addr)) throw new Error(`${label} is not an address: ${addr}`);
    const code = await state.reader.getCode(addr);
    if (!code || code === '0x') throw new Error(`${label} has no contract code at ${addr}`);
  }
  // The gate must answer isAllowed(address) (the hook + dapp both call it).
  try {
    await new ethers.Contract(gate, GATE_ABI, state.reader).isAllowed(state.account);
    log('gate.isAllowed() responds');
  } catch (e) {
    throw new Error(`gate ${gate} does not answer isAllowed(address): ${e?.shortMessage || e?.message}`);
  }
  // Quoter is optional for the deploy (the mini-app uses it for the receive
  // estimate), but if given it must be a real contract or the registry row is bad.
  if (quoter) {
    if (!ethers.isAddress(quoter)) throw new Error(`quoter is not an address: ${quoter}`);
    const code = await state.reader.getCode(quoter);
    if (!code || code === '0x') throw new Error(`quoter has no contract code at ${quoter}`);
  } else {
    log('WARNING: no Quoter set -- the mini-app will not show a receive estimate for this pool.');
  }
}

async function runDeploy() {
  try {
    $('btn-deploy').disabled = true;
    const cd = CHAIN_DEFAULTS[state.chainId] || {};
    const poolManager = $('poolManager').value.trim() || cd.poolManager || '';
    const gate = $('gate').value.trim() || cd.gate || '';
    const poolSwapTest = $('poolSwapTest').value.trim() || cd.poolSwapTest || '';
    const quoter = $('quoter').value.trim() || cd.quoter || '';
    const poolName = $('poolName').value.trim() || 'Credential-gated pool';
    await sanityCheckInfra(poolManager, gate, poolSwapTest, quoter);

    // 1. Tokens (deploy or reuse).
    const tokenA = await resolveToken('A');
    const tokenB = await resolveToken('B');
    if (tokenA.address.toLowerCase() === tokenB.address.toLowerCase()) throw new Error('tokenA and tokenB are the same');

    // 2. CREATE2-mine + deploy the hook (reused if already at its deterministic address).
    const args = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address'], [poolManager, gate]);
    const initcode = ethers.concat([state.artifacts.MusnadAccessHook.bytecode, args]);
    log('mining hook (BEFORE_SWAP_FLAG)...');
    const { salt, addr: hook } = mineHook(initcode);
    if ((await state.reader.getCode(hook)) !== '0x') {
      log(`hook already deployed at ${hook} (reusing)`);
    } else {
      await sendTx({ to: CREATE2_DEPLOYER, data: ethers.concat([salt, initcode]) }, 'deploy hook');
      if ((await state.reader.getCode(hook)) === '0x') throw new Error('hook CREATE2 deploy produced no code');
      log(`hook at ${hook}`);
    }

    // 3. Sort currencies + derive the decimal- AND rate-aware sqrtPriceX96.
    const aIs0 = BigInt(tokenA.address) < BigInt(tokenB.address);
    const [c0, c1] = aIs0 ? [tokenA, tokenB] : [tokenB, tokenA];
    const rate = parseRate($('rate').value); // tokenB per tokenA
    // currency1-per-currency0 value fraction: if currency0 is tokenA it's `rate`; else it's 1/rate.
    const { num, den } = aIs0 ? rate : { num: rate.den, den: rate.num };
    const sqrtPriceX96 = sqrtPriceX96For(c0.decimals, c1.decimals, num, den);
    const key = { currency0: c0.address, currency1: c1.address, fee: FEE, tickSpacing: TICK_SPACING, hooks: hook };
    log(`price: 1 ${tokenA.symbol} = ${$('rate').value || '1'} ${tokenB.symbol} (sqrtPriceX96 ${sqrtPriceX96})`);

    const pmI = new ethers.Interface(POOL_MANAGER_ABI);
    const erc20I = new ethers.Interface(ERC20_ABI);
    const lpI = new ethers.Interface(LP_ROUTER_ABI);

    // 4. Initialize the pool.
    await sendTx({ to: poolManager, data: pmI.encodeFunctionData('initialize', [key, sqrtPriceX96]) }, 'initialize');

    // 5. Seed FULL-RANGE liquidity. L targets ~TARGET_UNITS of value each side. For deployed mocks we
    //    mint the needed balances; for reused tokens the operator must already hold enough.
    const lpRouter = await deployBytecode('PoolModifyLiquidityTest', LP_ROUTER_ABI, [poolManager]);
    const liquidity = (TARGET_UNITS * (10n ** BigInt(c1.decimals)) * Q96) / sqrtPriceX96;
    const amount0 = (liquidity * Q96) / sqrtPriceX96;   // currency0 raw (approx, full range)
    const amount1 = (liquidity * sqrtPriceX96) / Q96;   // currency1 raw (approx)
    for (const [cur, amt] of [[c0, amount0], [c1, amount1]]) {
      const need = amt * 2n; // buffer for full-range rounding
      if (cur.deployed) {
        await sendTx({ to: cur.address, data: erc20I.encodeFunctionData('mint', [state.account, need]) }, `mint ${cur.symbol}`);
      } else {
        const bal = await new ethers.Contract(cur.address, ERC20_ABI, state.reader).balanceOf(state.account);
        if (bal < amt) throw new Error(`Need ~${amt} raw ${cur.symbol} to seed liquidity but hold ${bal}. Fund the deployer or lower the amount.`);
      }
      await sendTx({ to: cur.address, data: erc20I.encodeFunctionData('approve', [lpRouter, ethers.MaxUint256]) }, `approve ${cur.symbol}`);
    }
    await sendTx(
      { to: lpRouter, data: lpI.encodeFunctionData('modifyLiquidity', [key, { tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: liquidity, salt: ethers.ZeroHash }, '0x']) },
      'seed liquidity',
    );
    log('liquidity seeded');

    state.deployed = { tokenA, tokenB, hook, lpRouter, poolManager, gate, poolSwapTest, quoter, poolName, fee: FEE, tickSpacing: TICK_SPACING };
    renderResults();
    log('DONE. Copy the registry row into the issuer pool registry / dapp.');
  } catch (e) {
    fail(e);
    $('btn-deploy').disabled = false;
  }
}

async function runMint() {
  try {
    const to = $('mintTo').value.trim() || state.account;
    const erc20I = new ethers.Interface(ERC20_ABI);
    for (const t of [state.deployed.tokenA, state.deployed.tokenB]) {
      if (!t) throw new Error('deploy first');
      if (!t.deployed) { log(`${t.symbol} is an existing token (no faucet); skipping mint`); continue; }
      const amt = 1000n * (10n ** BigInt(t.decimals));
      await sendTx({ to: t.address, data: erc20I.encodeFunctionData('mint', [to, amt]) }, `mint 1000 ${t.symbol}`);
    }
    log(`minted test assets to ${to}`);
  } catch (e) { fail(e); }
}

function registryRow() {
  const d = state.deployed;
  const row = {
    name: d.poolName,
    chainId: state.chainId,
    caip2: `eip155:${state.chainId}`,
    poolManager: d.poolManager,
    gate: d.gate,
    hook: d.hook,
    fee: d.fee,
    tickSpacing: d.tickSpacing,
    tokenA: d.tokenA.address,
    tokenB: d.tokenB.address,
    poolSwapTest: d.poolSwapTest,
  };
  if (d.quoter) row.quoter = d.quoter; // optional; enables the mini-app receive estimate
  return row;
}

const CSV_COLS = ['name', 'chainId', 'poolManager', 'gate', 'hook', 'fee', 'tickSpacing', 'tokenA', 'tokenB', 'poolSwapTest', 'quoter'];

function renderResults() {
  const d = state.deployed;
  const row = registryRow();
  const csv = CSV_COLS.map((c) => row[c] != null ? row[c] : '').join(',');
  const rows = [
    ['tokenA', `${d.tokenA.symbol} (${d.tokenA.decimals}) ${d.tokenA.address}`],
    ['tokenB', `${d.tokenB.symbol} (${d.tokenB.decimals}) ${d.tokenB.address}`],
    ['hook', d.hook],
    ['lpRouter', d.lpRouter],
    ['registry JSON', JSON.stringify(row)],
    ['registry CSV', CSV_COLS.join(',') + '\n' + csv],
  ];
  const box = $('results');
  box.innerHTML = '';
  for (const [label, val] of rows) {
    const r = document.createElement('div');
    r.className = 'result-row';
    const l = document.createElement('span'); l.className = 'result-label'; l.textContent = label;
    const v = document.createElement('code'); v.textContent = val;
    const btn = document.createElement('button'); btn.textContent = 'Copy'; btn.onclick = () => navigator.clipboard.writeText(val);
    r.append(l, v, btn);
    box.appendChild(r);
  }
  $('results-card').style.display = 'block';
}

// Show the deploy-fields vs the existing-address field per token, driven by the radios.
function wireModeToggle(ab) {
  const apply = () => {
    const existing = document.querySelector(`input[name="mode${ab}"]:checked`).value === 'existing';
    $(`deploy${ab}`).style.display = existing ? 'none' : '';
    $(`existing${ab}`).style.display = existing ? '' : 'none';
  };
  document.querySelectorAll(`input[name="mode${ab}"]`).forEach((r) => r.addEventListener('change', apply));
  apply();
}

window.addEventListener('DOMContentLoaded', () => {
  $('btn-connect').onclick = () => connect().catch(fail);
  $('btn-deploy').onclick = () => runDeploy();
  $('btn-mint').onclick = () => runMint();
  wireModeToggle('A');
  wireModeToggle('B');
  const chainSel = $('chainSelect');
  const onChainChange = () => {
    $('chainIdCustom').style.display = chainSel.value === 'custom' ? '' : 'none';
    applyChainDefaults(); // prefill known chains, blank the rest
  };
  chainSel.addEventListener('change', onChainChange);
  $('chainIdCustom').addEventListener('input', applyChainDefaults);
  // Re-verify a field whenever the operator edits it.
  INFRA_FIELDS.forEach((id) => $(id).addEventListener('blur', () => verifyField(id)));
  onChainChange(); // sync fields to the default-selected chain on load
});
