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

// Per-app metadata. `version` is the bundle/app version (bump to force
// wallets to re-download). `channel` is the release track (beta|stable).
// `requiresMaknoon` is the minimum Maknoon app version the dApp targets.
const APP_META = {
  "pos-demo": {
    version: "0.1.0", entry: "index.html", channel: "beta", requiresMaknoon: "0.4.1",
    capabilities: [
      { name: "identity", reason: "Verify each customer holds a sanctions-clean credential" },
      { name: "payment", reason: "Receive payments and pick a receiving address" },
    ],
  },
};

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else if (name !== "manifest.json") {
      out.push(full);
    }
  }
  return out;
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
let built = 0;

for (const appId of readdirSync(APPS_DIR)) {
  const appDir = join(APPS_DIR, appId);
  if (!statSync(appDir).isDirectory()) continue;
  const meta = APP_META[appId] || { version: "1.0.0", entry: "index.html" };

  const files = listFiles(appDir)
    .map((full) => ({
      path: relative(appDir, full).split(sep).join("/"),
      sha256: sha256Hex(readFileSync(full)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const manifest = { version: meta.version, entry: meta.entry, files };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  writeFileSync(join(appDir, "manifest.json"), manifestBytes);
  const manifestSha = sha256Hex(manifestBytes);

  const entry = catalog.apps.find((a) => a.id === appId);
  if (entry) {
    entry.manifestSha256 = manifestSha;
    // Keep the catalog's advertised version/channel/compat in sync with APP_META.
    entry.version = meta.version;
    if (meta.channel) entry.channel = meta.channel;
    if (meta.requiresMaknoon) entry.requiresMaknoonVersion = meta.requiresMaknoon;
    if (meta.capabilities) entry.capabilities = meta.capabilities;
    built++;
    console.log(`[build] ${appId}: v${meta.version} ${meta.channel || ""} ${files.length} files, manifest ${manifestSha.slice(0, 12)}…`);
  } else {
    console.warn(`[build] WARNING: app '${appId}' has no catalog entry`);
  }
}

writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n");
console.log(`[build] wrote catalog.json (${built} app(s) hashed)`);
