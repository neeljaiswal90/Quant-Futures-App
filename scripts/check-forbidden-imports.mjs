#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

const DEFAULT_ROOTS = ['apps', 'services', 'research'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'legacy_reference',
  'legacy_seed',
  'node_modules',
]);

const FORBIDDEN_TARGETS = [
  { id: 'legacy_seed', fragments: ['legacy_seed'] },
  { id: 'legacy_reference', fragments: ['legacy_reference'] },
  { id: 'src/autotrade', fragments: ['src/autotrade'] },
  { id: 'dashboard', fragments: ['dashboard'] },
  { id: 'bookmap-addon', fragments: ['bookmap-addon', 'bookmap_addon', 'bookmap', '@bookmap'] },
  { id: 'src/core/tradingview', fragments: ['src/core/tradingview', 'tradingview', '@tradingview'] },
];

function usage() {
  return [
    'Usage: node scripts/check-forbidden-imports.mjs [--root <path> ...]',
    '',
    'Scans active TypeScript, JavaScript, and Python files for imports from legacy',
    'or vendor UI/runtime paths that are forbidden in Quant-futures-app V1.',
  ].join('\n');
}

function parseArgs(argv) {
  const roots = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { help: true, roots };
    }
    if (arg === '--root') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--root requires a path');
      }
      roots.push(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help: false, roots };
}

function toDisplayPath(filePath) {
  return relative(process.cwd(), filePath).replaceAll('\\', '/');
}

function collectCodeFiles(root) {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot)) {
    throw new Error(`Scan root does not exist: ${root}`);
  }

  const files = [];

  function walk(directory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
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

  walk(absoluteRoot);
  return files;
}

function normalizeSpecifier(specifier) {
  const lower = specifier.toLowerCase().replaceAll('\\', '/');
  const moduleLike = lower.replaceAll('.', '/').replaceAll(/\/+/g, '/');
  return [lower, moduleLike];
}

function hasFragment(normalizedSpecifier, fragment) {
  if (fragment.includes('/')) {
    return normalizedSpecifier.includes(fragment);
  }

  return normalizedSpecifier
    .split('/')
    .filter(Boolean)
    .some((segment) => segment === fragment);
}

function matchForbiddenTarget(specifier) {
  const normalizedForms = normalizeSpecifier(specifier);

  for (const target of FORBIDDEN_TARGETS) {
    for (const normalized of normalizedForms) {
      if (target.fragments.some((fragment) => hasFragment(normalized, fragment))) {
        return target.id;
      }
    }
  }

  return null;
}

function extractEcmaScriptSpecifiers(line) {
  const trimmed = line.trim();
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*')
  ) {
    return [];
  }

  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  return patterns.flatMap((pattern) =>
    [...line.matchAll(pattern)].map((match) => match[1]),
  );
}

function extractPythonSpecifiers(line) {
  const code = line.split('#', 1)[0].trim();
  if (!code) {
    return [];
  }

  const fromMatch = code.match(/^from\s+([.\w]+)\s+import\b/);
  if (fromMatch) {
    return [fromMatch[1]];
  }

  const importMatch = code.match(/^import\s+(.+)$/);
  if (!importMatch) {
    return [];
  }

  return importMatch[1]
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/i)[0])
    .filter(Boolean);
}

function extractSpecifiers(filePath, line) {
  return extname(filePath) === '.py'
    ? extractPythonSpecifiers(line)
    : extractEcmaScriptSpecifiers(line);
}

function scanFile(filePath) {
  const contents = readFileSync(filePath, 'utf8');
  const findings = [];

  contents.split(/\r?\n/).forEach((line, index) => {
    for (const specifier of extractSpecifiers(filePath, line)) {
      const target = matchForbiddenTarget(specifier);
      if (target) {
        findings.push({
          filePath,
          line: index + 1,
          specifier,
          target,
        });
      }
    }
  });

  return findings;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return 0;
  }

  const roots = parsed.roots.length > 0 ? parsed.roots : DEFAULT_ROOTS;
  const files = roots.flatMap((root) => collectCodeFiles(root));
  const findings = files.flatMap((file) => scanFile(file));

  findings.sort((a, b) => {
    const pathComparison = toDisplayPath(a.filePath).localeCompare(toDisplayPath(b.filePath));
    if (pathComparison !== 0) {
      return pathComparison;
    }
    return a.line - b.line;
  });

  if (findings.length > 0) {
    console.error('Forbidden active imports found:');
    for (const finding of findings) {
      console.error(
        `${toDisplayPath(finding.filePath)}:${finding.line} ` +
          `[${finding.target}] ${finding.specifier}`,
      );
    }
    return 1;
  }

  console.log(`Forbidden import check passed (${files.length} files scanned).`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
