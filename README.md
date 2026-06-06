# Maknoon dApps

Reference mini apps for the [Maknoon](https://maknoon.elabify.com) wallet.

A mini app is a static HTML/CSS/JS bundle. The wallet:

1. reads `catalog.json` (this repo, served via GitHub Pages),
2. downloads each app's `manifest.json` and pins it against the
   `manifestSha256` in the catalog,
3. downloads every file the manifest lists and verifies its SHA-256,
4. serves the verified files into a sandboxed WebView from a per-app
   local origin, injecting two providers:
   - `window.ethereum` — EIP-1193, pinned to Sepolia, for payments;
   - `window.maknoon.identity` — request a verifiable-credential proof.

Keys never reach the page: every signature, disclosure, and send is
approved by the user inside the wallet and gated by Face ID.

## Apps

| App | Description |
| --- | --- |
| `pos-demo` | Point-of-sale terminal: gate a sale on a sanctions-clean Musnad credential (screened within 12 months), then take payment on Sepolia. |

## Layout

```
catalog.json            store metadata + app entries (manifestSha256 generated)
apps/<id>/              one mini app
  index.html
  app.js
  styles.css
  manifest.json         generated: { version, entry, files:[{path, sha256}] }
scripts/build.mjs       regenerate manifests + catalog hashes
```

## Developing

```
node scripts/build.mjs      # regenerate manifest.json + catalog hashes
```

Commit the regenerated `catalog.json` and `apps/*/manifest.json`. GitHub
Pages serves this repo's `main` branch directly, so the committed files are
exactly what the wallet fetches — always run the build before committing so
the catalog's `manifestSha256` matches the published manifest.

Bump an app's `version` in `scripts/build.mjs` (the `APP_META` map) to make
wallets re-download a changed bundle.

## Bridge API (quick reference)

```js
// Identity: ask the holder to prove a credential.
const verdict = await window.maknoon.identity.request({
  schemas: ["elabify://schema/global/musnadMaknoon/v1"],
  requiredClaims: ["sanctionsScreenedAt", "jurisdiction", "isPep"],
  maxAgeSec: 365 * 24 * 60 * 60,
  purpose: "Point-of-sale payment",
});
// -> { decision: "GRANT"|"DENY", checks, disclosed, requestId, offline }

// Wallet: EIP-1193 on Sepolia.
await window.ethereum.request({ method: "eth_requestAccounts" });
const txHash = await window.ethereum.request({
  method: "eth_sendTransaction",
  params: [{ to: "0x…", value: "0x…" }],
});
```

This is a demo. Apps here are not audited for production custody.
