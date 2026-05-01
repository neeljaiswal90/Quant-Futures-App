import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

export interface ReadOnlyImportFinding {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly specifier?: string;
}

export interface ReadOnlyImportGuardOptions {
  readonly repoRoot: string;
  readonly roots: readonly string[];
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage']);

const ALLOWED_RUNTIME_PREFIXES = [
  'apps/strategy_runtime/src/contracts/',
  'apps/strategy_runtime/src/operator/formatter.ts',
  'apps/strategy_runtime/src/features/availability-mask.ts',
  'apps/strategy_runtime/src/transport/journal-jsonl-transport.ts',
];

const BLOCKED_RUNTIME_FRAGMENTS = [
  'apps/strategy_runtime/src/execution/',
  'apps/strategy_runtime/src/risk/risk-manager',
  'apps/strategy_runtime/src/risk/account-risk-arbiter',
  'apps/strategy_runtime/src/management/position-manager',
  'apps/strategy_runtime/src/orchestration/event-bus',
  'apps/strategy_runtime/src/orchestration/runner',
  'apps/strategy_runtime/src/config/',
  'apps/strategy_runtime/src/strategy-config/write',
];

const SOURCE_FORBIDDEN_PATTERNS = [
  {
    reason: 'console source must not create JournalEventEnvelope records',
    pattern: new RegExp(`\\b${['create', 'JournalEventEnvelope'].join('')}\\b`),
  },
  {
    reason: 'console source must not emit runtime events',
    pattern: new RegExp(`\\b${['pub', 'lish', '(?:Order|Runtime)?'].join('')}\\b`),
  },
];

export function runReadOnlyImportGuard(
  options: ReadOnlyImportGuardOptions,
): readonly ReadOnlyImportFinding[] {
  const repoRoot = resolve(options.repoRoot);
  const roots = options.roots.map((root) => resolve(repoRoot, root));
  const findings: ReadOnlyImportFinding[] = [];
  const visited = new Set<string>();

  for (const root of roots) {
    if (!existsSync(root)) {
      findings.push({
        file: toDisplayPath(repoRoot, root),
        line: 1,
        reason: 'scan root does not exist',
      });
      continue;
    }

    for (const file of collectCodeFiles(root)) {
      visitFile(repoRoot, file, visited, findings);
    }
  }

  return findings.sort((left, right) => {
    const pathComparison = left.file.localeCompare(right.file);
    return pathComparison === 0 ? left.line - right.line : pathComparison;
  });
}

function visitFile(
  repoRoot: string,
  file: string,
  visited: Set<string>,
  findings: ReadOnlyImportFinding[],
): void {
  const absoluteFile = resolve(file);
  if (visited.has(absoluteFile)) {
    return;
  }
  visited.add(absoluteFile);

  const contents = readFileSync(absoluteFile, 'utf8');
  const lines = contents.split(/\r?\n/);
  const displayFile = toDisplayPath(repoRoot, absoluteFile);
  const enforceSourcePatterns = !displayFile.startsWith('apps/strategy_runtime/src/');

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (enforceSourcePatterns) {
      for (const forbidden of SOURCE_FORBIDDEN_PATTERNS) {
        if (forbidden.pattern.test(line)) {
          findings.push({
            file: displayFile,
            line: lineNumber,
            reason: forbidden.reason,
          });
        }
      }
    }

    for (const specifier of extractEcmaScriptSpecifiers(line)) {
      const resolved = resolveImportSpecifier(repoRoot, absoluteFile, specifier);
      if (resolved === undefined) {
        continue;
      }

      const displayPath = toDisplayPath(repoRoot, resolved);
      const runtimeFinding = runtimeImportFinding(displayPath);
      if (runtimeFinding !== undefined) {
        findings.push({
          file: toDisplayPath(repoRoot, absoluteFile),
          line: lineNumber,
          reason: runtimeFinding,
          specifier,
        });
      }

      if (isLocalTransitiveCandidate(repoRoot, resolved)) {
        visitFile(repoRoot, resolved, visited, findings);
      }
    }
  });
}

function collectCodeFiles(root: string): readonly string[] {
  const files: string[] = [];

  function walk(directory: string): void {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          walk(entryPath);
        }
        continue;
      }
      if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
        files.push(entryPath);
      }
    }
  }

  walk(root);
  return files;
}

function extractEcmaScriptSpecifiers(line: string): readonly string[] {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return [];
  }

  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  return patterns.flatMap((pattern) => [...line.matchAll(pattern)].map((match) => match[1]!));
}

function resolveImportSpecifier(
  repoRoot: string,
  importer: string,
  specifier: string,
): string | undefined {
  if (specifier.startsWith('.')) {
    return resolveExistingModule(resolve(dirname(importer), specifier));
  }

  if (specifier.startsWith('apps/strategy_runtime/')) {
    return resolveExistingModule(resolve(repoRoot, specifier));
  }

  return undefined;
}

function resolveExistingModule(basePath: string): string | undefined {
  const extension = extname(basePath);
  const sourceBase =
    extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs'
      ? basePath.slice(0, -extension.length)
      : basePath;
  const candidates = [
    basePath,
    `${sourceBase}.ts`,
    `${sourceBase}.tsx`,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    resolve(basePath, 'index.ts'),
    resolve(basePath, 'index.tsx'),
    resolve(basePath, 'index.js'),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

function runtimeImportFinding(displayPath: string): string | undefined {
  const normalized = displayPath.replaceAll('\\', '/');
  if (!normalized.startsWith('apps/strategy_runtime/src/')) {
    return undefined;
  }

  if (BLOCKED_RUNTIME_FRAGMENTS.some((fragment) => normalized.startsWith(fragment))) {
    return 'console import reaches mutation-capable runtime module';
  }

  if (!ALLOWED_RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return 'console runtime import is outside the read-only allowlist';
  }

  return undefined;
}

function isLocalTransitiveCandidate(repoRoot: string, file: string): boolean {
  const displayPath = toDisplayPath(repoRoot, file);
  return (
    displayPath.startsWith('apps/operator_console/') ||
    displayPath.startsWith('apps/strategy_runtime/src/')
  );
}

function toDisplayPath(repoRoot: string, file: string): string {
  return relative(repoRoot, file).replaceAll('\\', '/');
}
