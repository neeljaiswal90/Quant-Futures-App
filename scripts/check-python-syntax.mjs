#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_ROOTS = ['services', 'research', 'scripts'];
const PYTHON = process.env.PYTHON ?? 'python';

function usage() {
  return [
    'Usage: node scripts/check-python-syntax.mjs [--root <path> ...]',
    '',
    'Runs python -m compileall over active Python roots when they exist.',
    'Missing default roots are skipped with a warning; explicit roots are strict.',
  ].join('\n');
}

function parseArgs(argv) {
  const roots = [];
  let explicitRoots = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { help: true, roots, explicitRoots };
    }
    if (arg === '--root') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--root requires a path');
      }
      roots.push(next);
      explicitRoots = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help: false, roots, explicitRoots };
}

function hasPythonFile(root) {
  const entries = readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__' || entry.name.startsWith('.')) {
        continue;
      }
      if (hasPythonFile(entryPath)) {
        return true;
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.py')) {
      return true;
    }
  }

  return false;
}

function resolveRoots(parsed) {
  const requestedRoots = parsed.roots.length > 0 ? parsed.roots : DEFAULT_ROOTS;
  const roots = [];

  for (const root of requestedRoots) {
    const absoluteRoot = resolve(root);
    if (existsSync(absoluteRoot)) {
      roots.push(root);
    } else if (parsed.explicitRoots) {
      throw new Error(`Python syntax root does not exist: ${root}`);
    } else {
      console.warn(`Skipping default Python syntax root (not present): ${root}`);
    }
  }

  return roots;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return 0;
  }

  const roots = resolveRoots(parsed).filter((root) => {
    if (hasPythonFile(resolve(root))) {
      return true;
    }
    console.warn(`Skipping Python syntax root (no .py files): ${root}`);
    return false;
  });

  if (roots.length === 0) {
    console.warn('No active Python syntax roots present; skipping compileall.');
    return 0;
  }

  const result = spawnSync(PYTHON, ['-m', 'compileall', '-q', ...roots], {
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    return result.status ?? 1;
  }

  console.log(`Python syntax check passed (${roots.length} roots scanned).`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
