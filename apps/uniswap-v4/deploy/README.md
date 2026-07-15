# Credential-gated pool deploy tool

A public, static browser tool for deploying a credential-gated UniswapV4 pool. It lives alongside the
uniswap-v4 mini-app but is a standalone browser page (NOT part of the mini-app bundle: `build.mjs`
excludes this `deploy/` folder from the manifest the wallet downloads). Open it with a browser that
has MetaMask:

> https://elabify.github.io/maknoon-dapps/apps/uniswap-v4/deploy/

Your **MetaMask signs every transaction** — there is no server, no raw key, and no secret handled
here. It cannot run inside the Maknoon wallet mini-app host (that bridge rejects contract-creation
txs), so it is a standalone page, not a mini-app. Testnet only; never point it at mainnet.

## What it does

1. Connect MetaMask on the chosen chain (default Base Sepolia, `84532`).
2. For each of two tokens: **deploy** a fresh `MockConfigurableERC20(name, symbol, decimals)` (defaults
   AUDD 6-dec / MMF 18-dec), or **reuse** an existing ERC-20 by address (its name/symbol/decimals are
   read + shown as a sanity check).
3. Set the **exchange rate** (1 Token A = N Token B, in value; default 1:1). The pool is initialized at
   a decimal- and rate-aware `sqrtPriceX96`, so a 6-dec token pairs correctly with an 18-dec token.
4. CREATE2-mine + deploy the `MusnadAccessHook` against the `OnchainIdAccessGate` (reused if already
   deployed at its deterministic address), initialize the pool, and seed full-range liquidity
   (~1,000,000 units of value each side).
5. Print a **registry row** (JSON + CSV) to paste into the issuer pool registry / dapp:
   `name, chainId, poolManager, gate, hook, fee, tickSpacing, tokenA, tokenB`.

Overridable + sanity-checked infra: `poolManager`, `gate`, `poolSwapTest`.

## Notes

- **Reusing an existing token** has no faucet: the connected account must already hold enough of that
  token to seed liquidity (the tool checks and tells you if not).
- **Gating on other chains** only works if that chain has the ONCHAINID access stack + the Access
  Issuer grants there. Only register pools whose `gate` is real on their chain.
- `artifacts.json` is the committed creation bytecode (Pages has no build step). Regenerate it from
  `code/smart-contracts` after a contract change:
  `forge build` then re-run the sync (see the musnad repo's `tools/pool-deploy-page/sync-pool-artifacts.mjs`).
