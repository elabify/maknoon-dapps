// Build the integrity manifests + catalog for the Maknoon dApps store.
//
// VERSION-STAMPED RELEASES. Each published version is an immutable snapshot at
// apps/<id>/releases/<version>/, containing the bundle files AND their
// manifest.json. The working copy stays at apps/<id>/ and is what you edit.
//
// For each app it:
//   1. hashes every shipped file in the working copy,
//   2. copies them into apps/<id>/releases/<version>/ and writes the manifest
//      there,
//   3. computes sha256(manifest.json bytes) and writes it into the matching
//      entry's `manifestSha256` in catalog.json.
//
// Why versioned directories: the two release channels used to share ONE
// directory, so stable and beta hashed the identical files and differed only in
// a version string. "Ship to beta first" was therefore impossible: publishing
// the new bundle updated stable in the same push. With a directory per version,
// stable can stay pinned to the bundle it already serves while beta moves ahead,
// an older manifest keeps resolving for clients that have not refetched the
// catalog, and a rollback is a catalog edit rather than a rebuild.
//
// A published snapshot is IMMUTABLE. Rebuilding a version whose directory
// already differs is an error: those bytes are pinned by manifestSha256 in every
// installed client, so changing them under a version number that has shipped
// breaks the integrity check rather than updating anyone. Bump the version, or
// pass --allow-rewrite when the version has demonstrably never been published.
//
// The Maknoon wallet pins `manifestSha256` from the catalog, then verifies
// every file against the manifest, so this script is the single place the
// trust chain is generated. Run it before committing/publishing:
//     node scripts/build.mjs
//
// No dependencies; Node >= 18.

import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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
        // FROZEN: the bundle already serving stable users. Its snapshot is
        // committed under releases/0.1.6 and is not rebuilt, so shipping a beta
        // cannot disturb it. Promote by adding a new stable channel entry.
        channel: "stable", version: "0.1.6", frozen: true,
        requiresMaknoon: "0.6.3",
        capabilities: [
          { name: "identity", reason: "Verify each customer has a sanctions screening with no match" },
          { name: "wallet", reason: "Read your receiving addresses across all networks, including assets and transaction history" },
        ],
      },
      {
        channel: "beta", version: "0.1.8",
        requiresMaknoon: "0.6.3",
        capabilities: [
          { name: "identity", reason: "Verify each customer has a sanctions screening with no match" },
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
        // FROZEN, as above: releases/0.2.0 is what stable serves today.
        channel: "stable", version: "0.2.0", frozen: true,
        requiresMaknoon: "0.6.7",
        capabilities: [
          { name: "wallet.ethereum.read", reason: "Read Ethereum chain state and discover credential-gated pools" },
          { name: "wallet.ethereum.write", reason: "Submit your approve and swap transactions (you approve each one)" },
          { name: "identity", reason: "Prove you are a verified, non-sanctioned human to access the pool" },
        ],
      },
      {
        channel: "beta", version: "0.2.1",
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
    // Snapshots of previous versions live under releases/ and are OUTPUT, not
    // input. Hashing them would fold every past release into the next one.
    if (name === 'releases') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else if (!/^manifest.*\.json$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const ALLOW_REWRITE = process.argv.includes("--allow-rewrite");

/**
 * Materialize one immutable release snapshot.
 *
 * Refuses to change a snapshot that already exists with different content:
 * those exact bytes are pinned by `manifestSha256` in every installed client,
 * so rewriting them under a version that has shipped does not update anyone, it
 * fails their integrity check. Bump the version instead.
 */
function writeSnapshot(appDir, relDir, files, manifestBytes, appId, version) {
  const existing = join(relDir, "manifest.json");
  if (existsSync(existing) && !ALLOW_REWRITE) {
    if (!readFileSync(existing).equals(manifestBytes)) {
      throw new Error(
        `[build] ${appId} v${version} already exists at ${relDir} with DIFFERENT ` +
        `content. A published snapshot is immutable: its sha is pinned by every ` +
        `install. Bump the version, or pass --allow-rewrite if this version has ` +
        `never been published.`,
      );
    }
    return; // byte-identical, nothing to do
  }
  rmSync(relDir, { recursive: true, force: true });
  for (const f of files) {
    const dest = join(relDir, ...f.path.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(appDir, ...f.path.split("/"))));
  }
  writeFileSync(join(relDir, "manifest.json"), manifestBytes);
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
    // `frozen` channels are already-published snapshots we do not rebuild: the
    // bytes on disk under releases/<version>/ ARE the release. This is what lets
    // stable keep serving the bundle it always has while beta moves ahead.
    const relDir = join(appDir, "releases", ch.version);
    let manifestBytes;
    if (ch.frozen) {
      const mf = join(relDir, "manifest.json");
      if (!existsSync(mf)) {
        throw new Error(
          `[build] ${appId} v${ch.version} is frozen but ${mf} does not exist. ` +
          `A frozen channel serves a snapshot that must already be committed.`,
        );
      }
      manifestBytes = readFileSync(mf);
    } else {
      const snapshot = { version: ch.version, entry: meta.entry, files };
      manifestBytes = Buffer.from(JSON.stringify(snapshot, null, 2) + "\n", "utf8");
      writeSnapshot(appDir, relDir, files, manifestBytes, appId, ch.version);
    }
    const manifestSha = sha256Hex(manifestBytes);

    const entry = catalog.apps.find((a) => a.id === appId && a.version === ch.version);
    if (entry) {
      entry.manifestSha256 = manifestSha;
      entry.manifestURL = `${BASE_URL}/${meta.dir}/releases/${ch.version}/manifest.json`;
      entry.channel = ch.channel;
      entry.version = ch.version;
      if (ch.requiresMaknoon) entry.requiresMaknoonVersion = ch.requiresMaknoon;
      if (ch.supersededAtMaknoon) entry.supersededAtMaknoonVersion = ch.supersededAtMaknoon;
      if (ch.capabilities) {
        entry.capabilities = ch.capabilities;
        entry.permissions = ch.capabilities.map((c) => c.name);
      }
      built++;
      const how = ch.frozen ? "frozen" : `${files.length} files`;
      console.log(`[build] ${appId}: v${ch.version} ${ch.channel} (${how}) manifest ${manifestSha.slice(0, 12)}…`);
    } else {
      console.warn(`[build] WARNING: no catalog entry for ${appId} v${ch.version}`);
    }
  }
}

writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n");
console.log(`[build] wrote catalog.json (${built} app(s) hashed)`);
