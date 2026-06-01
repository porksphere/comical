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

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
