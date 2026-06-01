#!/usr/bin/env bun
/**
 * `comical` — the command-line host. Loads a built bridge, supplies it real capabilities via the
 * Bun host, and runs a backend operation. Use `--set baseUrl=…` to point a bridge at your own
 * backend, or `--fixture` to run against the built-in legal demo backend (testkit).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { HostCapabilities, NetworkCapability, ResolvedSettings } from "@comical/contract";
import { type LoadedBridge, loadBridge } from "@comical/core";
import { createBunHost } from "@comical/host-bun";
import {
  type CassetteEntry,
  FixtureBackend,
  recordingNetwork,
  runConformance,
} from "@comical/testkit";
import { createServer } from "@comical/host-server";
import {
  ManifestStore,
  RegistryManager,
  generateKeyPair,
  resolveRegistryUrl,
  sha256Hex,
  signSha256,
} from "@comical/registry";
import { readdir, writeFile } from "node:fs/promises";
import { discoverBridges, readBundle, resolveBridge } from "./discover.ts";

const BRIDGES_DIR = join(import.meta.dir, "..", "..", "..", "bridges");

const HELP = `comical — content bridge runtime CLI

Usage:
  comical list
  comical serve                [--port N] [--data-dir DIR] [--origin URL] [--token SECRET]
  comical search <query>       --bridge <id> [--fixture | --set baseUrl=URL] [--page N]
  comical details <seriesId>   --bridge <id> [--fixture | --set baseUrl=URL]
  comical chapters <seriesId>  --bridge <id> [--fixture | --set baseUrl=URL]
  comical pages <seriesId> <chapterId> --bridge <id> [--fixture | --set baseUrl=URL]
  comical test                 --bridge <id> [--fixture | --set baseUrl=URL] [--set query=Q]
  comical record               --bridge <id> [--fixture | --set baseUrl=URL] --scenario search:Q

  Registry (M4):
  comical registry list                          list added registries
  comical registry add <url>                     add a registry (GitHub link or any URL)
  comical registry remove <url>                  remove a registry (orphans its bridges)
  comical registry browse [<url>]                browse available bridges
  comical registry install <url> <bridgeId>      install a bridge from a registry
  comical registry update <bridgeId>             update an installed bridge
  comical registry uninstall <bridgeId>          uninstall a registry bridge
  comical registry updates                       check for available updates
  comical registry publish --base-url URL --out DIR [--key FILE]   generate index.json
  comical registry keygen --out FILE             generate an Ed25519 keypair

Options:
  -b, --bridge <id>   Bridge id (see \`comical list\`)
  --set key=value     Supply a user setting (repeatable), e.g. --set baseUrl=https://…
  --fixture           Run against the built-in legal demo backend
  --port N            Port for \`comical serve\` (default 3100)
  --page N            Page number for search (default 1)
  --scenario S        Record scenario (repeatable): search:Q | details:ID | home
  --data-dir DIR      Persistent storage location (default: .comical/)
  --origin URL        Allowed CORS origin for \`comical serve\`
  --token SECRET      Bearer token for \`comical serve\`
  --base-url URL      Base URL for \`registry publish\` (e.g. https://me.github.io/bridges)
  --out DIR           Output directory for \`registry publish\`
  --key FILE          Path to private key file for \`registry publish\`
  --json              Emit raw JSON
`;

function parseSettings(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--set expects key=value, got "${pair}"`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function print(json: boolean, value: unknown): void {
  console.log(JSON.stringify(value, null, json ? 0 : 2));
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      bridge: { type: "string", short: "b" },
      page: { type: "string" },
      port: { type: "string" },
      set: { type: "string", multiple: true },
      "data-dir": { type: "string" },
      origin: { type: "string" },
      token: { type: "string" },
      scenario: { type: "string", multiple: true },
      "base-url": { type: "string" },
      out: { type: "string" },
      key: { type: "string" },
      fixture: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  if (!command || values.help) {
    console.log(HELP);
    return command ? 0 : 1;
  }

  if (command === "list") {
    const bridges = discoverBridges(BRIDGES_DIR);
    if (values.json) {
      print(true, bridges.map((b) => b.info));
    } else if (bridges.length === 0) {
      console.log("No built bridges found. Run `bun run build`.");
    } else {
      for (const b of bridges) {
        console.log(`${b.info.id}  ${b.info.name}  v${b.info.version}  [${b.info.capabilities.join(", ")}]`);
      }
    }
    return 0;
  }

  if (command === "serve") {
    const port = values.port ? Number(values.port) : 3100;
    const dataDir = values["data-dir"] ?? join(BRIDGES_DIR, "..", ".comical");
    const serveOpts: Parameters<typeof createServer>[0] = {
      port,
      bridgesDir: BRIDGES_DIR,
      dataDir,
    };
    if (values.origin) serveOpts.origin = values.origin;
    if (values.token) serveOpts.token = values.token;
    const server = createServer(serveOpts);
    console.log(`comical-server running on http://localhost:${server.port}`);
    console.log(`  bridges: ${BRIDGES_DIR}`);
    console.log(`  data:    ${dataDir}`);
    if (!values.token) console.warn("  no --token set — server is unauthenticated (LAN use only)");
    await new Promise(() => {}); // run until killed
    return 0;
  }

  // ── Registry commands ────────────────────────────────────────────────────────

  if (command === "registry") {
    const sub = positionals[1];
    const dataDir = values["data-dir"] ?? join(BRIDGES_DIR, "..", ".comical");
    const manifest = new ManifestStore(dataDir);
    const reg = new RegistryManager({
      cacheDir: join(dataDir, "bridge-cache"),
      manifest,
    });

    if (sub === "list") {
      const list = await reg.list();
      if (list.length === 0) { console.log("No registries added. Use `comical registry add <url>`."); }
      else for (const r of list) console.log(`${r.name}  ${r.url}  fetched:${r.lastFetched ?? "never"}`);
      return 0;
    }

    if (sub === "add") {
      const url = requireArg(positionals[2], "url");
      const added = await reg.add(url);
      console.log(`Added registry: ${added.name}  (${added.url})`);
      if (added.publicKeyFingerprint) console.log(`  Key fingerprint: ${added.publicKeyFingerprint}`);
      return 0;
    }

    if (sub === "remove") {
      const url = requireArg(positionals[2], "url");
      await reg.remove(resolveRegistryUrl(url));
      console.log("Registry removed. Bridges installed from it are now orphaned.");
      return 0;
    }

    if (sub === "browse") {
      const url = positionals[2];
      const bridges = url ? await reg.browse(url) : await reg.browseAll();
      if (values.json) { print(true, bridges); return 0; }
      for (const b of bridges) {
        const updateTag = b.updateAvailable ? `  [update: ${b.entry.version}]` : "";
        const installedTag = b.installedVersion ? ` (installed ${b.installedVersion})` : "";
        console.log(`${b.entry.id}  ${b.entry.name}  v${b.entry.version}${installedTag}${updateTag}`);
      }
      return 0;
    }

    if (sub === "install") {
      const url = requireArg(positionals[2], "registryUrl");
      const bridgeId = requireArg(positionals[3], "bridgeId");
      const result = await reg.install(url, bridgeId);
      console.log(`Installed ${result.id} v${result.version} → ${result.bundlePath}`);
      return 0;
    }

    if (sub === "update") {
      const bridgeId = requireArg(positionals[2], "bridgeId");
      const result = await reg.update(bridgeId);
      console.log(`Updated ${result.id} to v${result.version}`);
      return 0;
    }

    if (sub === "uninstall") {
      const bridgeId = requireArg(positionals[2], "bridgeId");
      await reg.uninstall(bridgeId);
      console.log(`Uninstalled ${bridgeId}`);
      return 0;
    }

    if (sub === "updates") {
      const updates = await reg.checkUpdates();
      if (updates.length === 0) { console.log("All bridges are up to date."); return 0; }
      for (const u of updates) console.log(`${u.id}  ${u.installedVersion} → ${u.availableVersion}`);
      return 0;
    }

    if (sub === "keygen") {
      const out = values.out ?? "registry.key.json";
      const pair = await generateKeyPair();
      await writeFile(out, JSON.stringify(pair, null, 2), "utf8");
      console.log(`Keypair written to ${out}`);
      console.log(`Public key: ${pair.publicKey}`);
      console.log("Keep registry.key.json private — never commit it.");
      return 0;
    }

    if (sub === "publish") {
      const baseUrl = requireArg(values["base-url"], "base-url");
      const outDir = requireArg(values.out, "out");
      const pubOpts: PublishOpts = { baseUrl, outDir };
      if (values.key) pubOpts.keyFile = values.key;
      await publishRegistry(pubOpts);
      return 0;
    }

    throw new Error(`unknown registry subcommand "${sub ?? ""}". Run \`comical --help\` for usage.`);
  }

  // All other commands need a bridge.
  const bridgeId = values.bridge;
  if (!bridgeId) throw new Error("missing --bridge <id>");
  const discovered = resolveBridge(BRIDGES_DIR, bridgeId);
  const settings = parseSettings(values.set);

  // Optionally back the bridge with the built-in demo backend.
  let fixture: { url: string; stop: () => void } | undefined;
  if (values.fixture) {
    fixture = new FixtureBackend().serve();
    settings.baseUrl ??= fixture.url;
  }

  const json = values.json ?? false;
  const page = values.page ? Number(values.page) : 1;

  try {
    // For `record` we must intercept the raw network before the core gates it.
    const recorded: CassetteEntry[] = [];
    const makeHost = (): HostCapabilities => {
      const host = createBunHost({
        bridgeId: discovered.id,
        settings: settings as ResolvedSettings,
        ...(values["data-dir"] ? { dataDir: values["data-dir"] } : {}),
      });
      if (command === "record") {
        const wrapped: NetworkCapability = recordingNetwork(host.network, recorded);
        return { ...host, network: wrapped };
      }
      return host;
    };

    const bridge: LoadedBridge = loadBridge({
      code: readBundle(discovered.bundlePath),
      capabilities: makeHost(),
      expectedId: discovered.id,
    });

    switch (command) {
      case "search": {
        const query = positionals[1] ?? "";
        print(json, await bridge.getSearchResults(query, page));
        break;
      }
      case "details": {
        const id = requireArg(positionals[1], "seriesId");
        print(json, await bridge.getSeriesDetails(id));
        break;
      }
      case "chapters": {
        const id = requireArg(positionals[1], "seriesId");
        print(json, await bridge.getChapters(id));
        break;
      }
      case "pages": {
        const id = requireArg(positionals[1], "seriesId");
        const chapterId = requireArg(positionals[2], "chapterId");
        print(json, await bridge.getChapterPages(id, chapterId));
        break;
      }
      case "test": {
        const query = settings.query ?? "";
        const report = await runConformance(bridge, { searchQuery: query });
        console.log(`✓ ${discovered.id} passed conformance (${report.checks.length} checks)`);
        for (const c of report.checks) console.log(`  - ${c}`);
        break;
      }
      case "record": {
        await runScenarios(bridge, values.scenario ?? []);
        const outPath = join(BRIDGES_DIR, discovered.dir, "__fixtures__", "cassette.json");
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify({ entries: recorded }, null, 2), "utf8");
        console.log(`Recorded ${recorded.length} exchange(s) → ${outPath}`);
        break;
      }
      default:
        throw new Error(`unknown command "${command}"`);
    }
  } finally {
    fixture?.stop();
  }
  return 0;
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing argument: ${name}`);
  return value;
}

async function runScenarios(bridge: LoadedBridge, scenarios: string[]): Promise<void> {
  if (scenarios.length === 0) throw new Error("record requires at least one --scenario");
  for (const scenario of scenarios) {
    const [kind, arg] = splitScenario(scenario);
    if (kind === "search") await bridge.getSearchResults(arg ?? "", 1);
    else if (kind === "details") await bridge.getSeriesDetails(requireArg(arg, "details:<id>"));
    else if (kind === "home") await bridge.getHomeSections?.();
    else throw new Error(`unknown scenario "${scenario}"`);
  }
}

function splitScenario(scenario: string): [string, string | undefined] {
  const colon = scenario.indexOf(":");
  if (colon < 0) return [scenario, undefined];
  return [scenario.slice(0, colon), scenario.slice(colon + 1)];
}

// ── Registry publish ──────────────────────────────────────────────────────────

interface PublishOpts {
  baseUrl: string;
  outDir: string;
  keyFile?: string;
}

async function publishRegistry({ baseUrl, outDir, keyFile }: PublishOpts): Promise<void> {
  const { mkdirSync, readFileSync, copyFileSync } = await import("node:fs");
  const { join: pjoin } = await import("node:path");

  let privateKey: string | undefined;
  let publicKey: string | undefined;
  if (keyFile) {
    const pair = JSON.parse(readFileSync(keyFile, "utf8")) as { publicKey: string; privateKey: string };
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  }

  const bridges = discoverBridges(BRIDGES_DIR);
  if (bridges.length === 0) throw new Error("no built bridges found — run `bun run build` first");

  mkdirSync(outDir, { recursive: true });

  const entries = [];
  for (const b of bridges) {
    const bundleBytes = new Uint8Array(readFileSync(b.bundlePath));
    const hash = await sha256Hex(bundleBytes);
    const sig = (privateKey && publicKey) ? await signSha256(hash, privateKey) : undefined;

    // Copy bundle to output.
    const relPath = `bridges/${b.id}/${b.info.version}/bridge.js`;
    const destPath = pjoin(outDir, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(b.bundlePath, destPath);

    const entry: Record<string, unknown> = {
      id: b.info.id,
      name: b.info.name,
      version: b.info.version,
      contractVersion: b.info.contractVersion,
      languages: b.info.languages,
      nsfw: b.info.nsfw,
      capabilities: b.info.capabilities,
      url: `${baseUrl.replace(/\/+$/, "")}/${relPath}`,
      sha256: hash,
    };
    if (sig) entry.signature = sig;
    entries.push(entry);
    console.log(`✓ ${b.info.id} v${b.info.version}  sha256:${hash.slice(0, 12)}…`);
  }

  const index: Record<string, unknown> = {
    registryVersion: "1",
    updated: new Date().toISOString(),
    bridges: entries,
  };
  if (publicKey) index.publicKey = publicKey;

  const indexPath = pjoin(outDir, "index.json");
  await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
  console.log(`\n✓ index.json written → ${indexPath}`);
  console.log(`  ${entries.length} bridge(s) published`);
  if (publicKey) console.log(`  Signed with key: ${publicKey.slice(0, 20)}…`);
  else console.log("  Unsigned (no --key provided) — users trust via HTTPS");
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
