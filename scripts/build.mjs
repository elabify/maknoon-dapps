// Build the integrity manifests + catalog for the Maknoon dApps store.
//
// For each app under apps/<id>/ it:
//   1. hashes every shipped file (everything except manifest.json),
//   2. writes apps/<id>/manifest.json = { version, entry, files:[{path,sha256}] },
//   3. computes sha256(manifest.json bytes) and writes it into the matching
//      entry's `manifestSha256` in catalog.json.
//
// The Maknoon wallet pins `manifestSha256` from the catalog, then verifies
// every file against the manifest, so this script is the single place the
// trust chain is generated. Run it before committing/publishing:
//     node scripts/build.mjs
//
// No dependencies; Node >= 18.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const APPS_DIR = join(ROOT, "apps");
const CATALOG_PATH = join(ROOT, "catalog.json");

// Per-app metadata, keyed by catalog app id. Each app ships from ONE bundle
// `dir`, and can publish multiple release `channels` (stable, beta) built from
// the SAME files; only the manifest `version` (and hence its sha) differs, so a
// beta can stand in for "the next version" without duplicating the bundle. Each
// channel writes its own manifest file so the catalog can point stable + beta at
// distinct manifests inside the single folder. The loop matches the catalog
// entry by id + version.
const APP_META = {
  pos: {
    dir: "pos",
    entry: "index.html",
    channels: [
      {
        channel: "stable", version: "0.1.6", manifestFile: "manifest.json",
        requiresMaknoon: "0.6.3",
        capabilities: [
          { name: "identity", reason: "Verify each customer holds a sanctions-clean credential" },
          { name: "wallet", reason: "Read your receiving addresses across all networks, including assets and transaction history" },
        ],
      },
      {
        channel: "beta", version: "0.1.7", manifestFile: "manifest-beta.json",
        requiresMaknoon: "0.6.3",
        capabilities: [
          { name: "identity", reason: "Verify each customer holds a sanctions-clean credential" },
          { name: "wallet", reason: "Read your receiving addresses across all networks, including assets and transaction history" },
        ],
      },
    ],
  },
  "uniswap-v4": {
    dir: "uniswap-v4",
    entry: "index.html",
    channels: [
      {
        channel: "beta", version: "0.1.5", manifestFile: "manifest.json",
        requiresMaknoon: "0.6.7",
        capabilities: [
          { name: "wallet.ethereum.read", reason: "Read Ethereum chain state and discover credential-gated pools" },
          { name: "wallet.ethereum.write", reason: "Submit your approve and swap transactions (you approve each one)" },
          { name: "identity", reason: "Prove you are a verified, non-sanctioned human to access the pool" },
        ],
      },
    ],
  },
};

const BASE_URL = "https://elabify.github.io/maknoon-dapps/apps";

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    // `deploy/` is a co-located browser tool (MetaMask pool-deploy page), served
    // by Pages but NOT part of the mini-app bundle the wallet downloads/verifies.
    if (name === 'deploy') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else if (!/^manifest.*\.json$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
let built = 0;

for (const [appId, meta] of Object.entries(APP_META)) {
  const appDir = join(APPS_DIR, meta.dir);
  if (!statSync(appDir).isDirectory()) {
    console.warn(`[build] WARNING: app '${appId}' has no bundle dir '${meta.dir}'`);
    continue;
  }

  // The bundle file set is shared across channels; only the manifest version
  // (and thus its sha) differs, so hash the files once.
  const files = listFiles(appDir)
    .map((full) => ({
      path: relative(appDir, full).split(sep).join("/"),
      sha256: sha256Hex(readFileSync(full)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const ch of meta.channels) {
    const manifest = { version: ch.version, entry: meta.entry, files };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
    writeFileSync(join(appDir, ch.manifestFile), manifestBytes);
    const manifestSha = sha256Hex(manifestBytes);

    const entry = catalog.apps.find((a) => a.id === appId && a.version === ch.version);
    if (entry) {
      entry.manifestSha256 = manifestSha;
      entry.manifestURL = `${BASE_URL}/${meta.dir}/${ch.manifestFile}`;
      entry.channel = ch.channel;
      entry.version = ch.version;
      if (ch.requiresMaknoon) entry.requiresMaknoonVersion = ch.requiresMaknoon;
      if (ch.supersededAtMaknoon) entry.supersededAtMaknoonVersion = ch.supersededAtMaknoon;
      if (ch.capabilities) {
        entry.capabilities = ch.capabilities;
        entry.permissions = ch.capabilities.map((c) => c.name);
      }
      built++;
      console.log(`[build] ${appId}: v${ch.version} ${ch.channel} (${ch.manifestFile}) ${files.length} files, manifest ${manifestSha.slice(0, 12)}…`);
    } else {
      console.warn(`[build] WARNING: no catalog entry for ${appId} v${ch.version}`);
    }
  }
}

writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n");
console.log(`[build] wrote catalog.json (${built} app(s) hashed)`);
