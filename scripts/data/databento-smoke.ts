import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

interface ProbeResult {
  exitCode: number;
  report: JsonObject | null;
  stderr: string;
  stdout: string;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const pythonScript = resolve(repoRoot, "scripts/sim/check-databento-mnq-availability.py");
const rthSchemas = ["mbo", "mbp-1", "mbp-10", "trades"];
const runbookPath = "docs/RUNBOOK-backtester.md";

function main(): number {
  const argv = process.argv.slice(2);
  const outputPath = extractOption(argv, "--out");
  const userSchemasWereProvided = hasOption(argv, "--schemas");
  const baseArgs = removeOptions(argv, new Set(["--schemas", "--out"]));

  const apiKey = readDatabentoApiKey();
  if (apiKey === undefined) {
    printError(
      `DATABENTO_API_KEY is not set. Export it or add it to ${resolve(repoRoot, ".env")}; see ${runbookPath} for setup.`,
    );
    return 1;
  }

  const sessionId = extractOption(baseArgs, "--session-id");
  const start = extractOption(baseArgs, "--start");
  const end = extractOption(baseArgs, "--end");
  if (sessionId === undefined || start === undefined || end === undefined) {
    printError(
      `Missing required --session-id, --start, or --end. See ${runbookPath} for the canonical Databento smoke command.`,
    );
    return 1;
  }

  const definitionDate = utcDateFromTimestamp(start);
  if (definitionDate === undefined) {
    printError(`Unable to derive UTC date from --start value '${start}'. Use ISO-8601 or nanoseconds.`);
    return 1;
  }

  const env = { ...process.env, DATABENTO_API_KEY: apiKey };
  const rthArgs = [...baseArgs, "--schemas", rthSchemas.join(",")];
  const definitionArgs = [
    ...replaceOptions(baseArgs, {
      "--session-id": `${sessionId}-definition`,
      "--start": `${definitionDate}T00:00:00Z`,
      "--end": `${definitionDate}T00:00:01Z`,
    }),
    "--schemas",
    "definition",
  ];

  const rthProbe = runProbe(rthArgs, env);
  const definitionProbe = runProbe(definitionArgs, env);
  const warnings = buildWarnings({
    definitionProbe,
    userSchemasWereProvided,
  });

  const status = rthProbe.exitCode === 0 ? "ready" : "blocked";
  const report: JsonObject = {
    databento_smoke_schema_version: 1,
    ticket_id: "QFA-100",
    status,
    exit_code_contract: {
      gates_on: "RTH probe for mbo, mbp-1, mbp-10, trades",
      definition_probe_gates_exit_code: false,
      definition_probe_note:
        "Databento definition snapshots are UTC-midnight aligned, so the wrapper probes them separately from the RTH window.",
    },
    rth_probe: {
      python_exit_code: rthProbe.exitCode,
      schemas: rthSchemas,
      report: rthProbe.report,
    },
    definition_probe: {
      python_exit_code: definitionProbe.exitCode,
      schema: "definition",
      window: {
        start: `${definitionDate}T00:00:00Z`,
        end: `${definitionDate}T00:00:01Z`,
      },
      report: definitionProbe.report,
    },
    warnings,
  };

  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath !== undefined) {
    const resolvedOutputPath = resolve(repoRoot, outputPath);
    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    writeFileSync(resolvedOutputPath, rendered, "utf8");
  }
  process.stdout.write(rendered);

  return rthProbe.exitCode === 0 ? 0 : rthProbe.exitCode;
}

function runProbe(args: string[], env: NodeJS.ProcessEnv): ProbeResult {
  const child = spawnSync("python", [pythonScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }
  if (child.error !== undefined) {
    return {
      exitCode: 1,
      report: null,
      stderr,
      stdout,
    };
  }
  return {
    exitCode: child.status ?? 1,
    report: parseJson(stdout),
    stderr,
    stdout,
  };
}

function buildWarnings(input: {
  definitionProbe: ProbeResult;
  userSchemasWereProvided: boolean;
}): string[] {
  const warnings: string[] = [];
  if (input.userSchemasWereProvided) {
    warnings.push(
      "data:databento-smoke owns --schemas; user-provided --schemas was ignored so the fixed QFA-100 smoke contract is applied.",
    );
  }
  const definitionAvailable = schemaAvailable(input.definitionProbe.report, "definition");
  if (input.definitionProbe.exitCode !== 0 || !definitionAvailable) {
    warnings.push(
      "Definition probe did not return records. This does not fail the smoke because RTH backtester consumers use mbo, mbp-1, mbp-10, and trades on the critical path.",
    );
  }
  if (input.definitionProbe.report === null && input.definitionProbe.stdout.trim().length > 0) {
    warnings.push("Definition probe stdout was not valid JSON; inspect stderr/stdout from the Python availability script.");
  }
  return warnings;
}

function schemaAvailable(report: JsonObject | null, schema: string): boolean {
  const schemas = report?.schemas;
  if (!isJsonObject(schemas)) {
    return false;
  }
  const schemaReport = schemas[schema];
  return isJsonObject(schemaReport) && schemaReport.available === true;
}

function readDatabentoApiKey(): string | undefined {
  const fromEnv = process.env.DATABENTO_API_KEY;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv;
  }

  const envPath = resolve(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return undefined;
  }
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?DATABENTO_API_KEY\s*=\s*(.*)\s*$/u);
    if (match === null) {
      continue;
    }
    const value = unquoteEnvValue(match[1]);
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function utcDateFromTimestamp(value: string): string | undefined {
  const trimmed = value.trim();
  const isoDate = trimmed.match(/^(\d{4}-\d{2}-\d{2})/u);
  if (isoDate !== null) {
    return isoDate[1];
  }
  if (/^\d+$/u.test(trimmed)) {
    const milliseconds = Number(BigInt(trimmed) / 1_000_000n);
    return new Date(milliseconds).toISOString().slice(0, 10);
  }
  return undefined;
}

function extractOption(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

function hasOption(args: string[], name: string): boolean {
  const prefix = `${name}=`;
  return args.some((arg) => arg === name || arg.startsWith(prefix));
}

function removeOptions(args: string[], names: Set<string>): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const matchedName = [...names].find((name) => arg === name || arg.startsWith(`${name}=`));
    if (matchedName === undefined) {
      filtered.push(arg);
      continue;
    }
    if (arg === matchedName) {
      index += 1;
    }
  }
  return filtered;
}

function replaceOptions(args: string[], replacements: Record<string, string>): string[] {
  const withoutReplaced = removeOptions(args, new Set(Object.keys(replacements)));
  const replaced: string[] = [...withoutReplaced];
  for (const [name, value] of Object.entries(replacements)) {
    replaced.push(name, value);
  }
  return replaced;
}

function parseJson(stdout: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}

process.exitCode = main();
