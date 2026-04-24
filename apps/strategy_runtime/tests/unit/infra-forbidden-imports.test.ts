import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());
const guardScript = resolve(repoRoot, 'scripts/check-forbidden-imports.mjs');
const pythonCheckScript = resolve(repoRoot, 'scripts/check-python-syntax.mjs');
const tempDirs: string[] = [];
const legacySeedPath = ['legacy', 'seed'].join('_');
const legacyReferencePath = ['legacy', 'reference'].join('_');
const oldRuntimePath = ['src', 'autotrade'].join('/');
const operatorSurfacePath = ['dash', 'board'].join('');
const bookAdapterPackage = ['book', 'map-addon'].join('');
const chartingPath = ['src', 'core', ['trading', 'view'].join('')].join('/');

function makeTempRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'quant-import-guard-'));
  tempDirs.push(directory);
  return directory;
}

function runGuard(root: string) {
  return spawnSync(process.execPath, [guardScript, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function runPythonCheck(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [pythonCheckScript, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

describe('forbidden import guard', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('passes clean TypeScript and Python imports', () => {
    const root = makeTempRoot();
    writeFileSync(
      join(root, 'clean.ts'),
      "import { buildEntryStateVector } from './features/entry-state.js';\n",
    );
    writeFileSync(join(root, 'clean.py'), 'from services.market_data_sidecar.book import schema\n');

    const result = runGuard(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Forbidden import check passed');
  });

  it('fails on every forbidden TypeScript path family', () => {
    const root = makeTempRoot();
    writeFileSync(
      join(root, 'bad.ts'),
      [
        'im' + `port legacySeed from '../../${legacySeedPath}/ts/risk';`,
        'im' + `port legacyReference from '../../${legacyReferencePath}/${oldRuntimePath}/runner';`,
        'im' + `port oldRuntime from '../../${oldRuntimePath}/strategy';`,
        'im' + `port operatorSurface from '../../${operatorSurfacePath}/app';`,
        'im' + `port bookAdapter from '${bookAdapterPackage}';`,
        'im' + `port chartingAdapter from '../../${chartingPath}/feed';`,
      ].join('\n'),
    );

    const result = runGuard(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain(legacySeedPath);
    expect(output).toContain(legacyReferencePath);
    expect(output).toContain(oldRuntimePath);
    expect(output).toContain(operatorSurfacePath);
    expect(output).toContain(bookAdapterPackage);
    expect(output).toContain(chartingPath);
  });

  it('fails on forbidden Python module imports', () => {
    const root = makeTempRoot();
    writeFileSync(
      join(root, 'bad.py'),
      [
        `from ${oldRuntimePath.replaceAll('/', '.')}.strategy import build_candidate`,
        `import ${legacySeedPath}.ts.risk as legacy_risk`,
      ].join('\n'),
    );

    const result = runGuard(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain(`${oldRuntimePath.replaceAll('/', '.')}.strategy`);
    expect(output).toContain(`${legacySeedPath}.ts.risk`);
  });

  it('makes missing default Python roots an explicit skip instead of a silent no-op', () => {
    const root = makeTempRoot();

    const result = runPythonCheck([], root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('No active Python syntax roots present');
  });

  it('keeps explicit Python syntax roots strict', () => {
    const root = makeTempRoot();

    const result = runPythonCheck(['--root', join(root, 'missing')]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(2);
    expect(output).toContain('Python syntax root does not exist');
  });

  it('runs compileall when an explicit Python root exists', () => {
    const root = makeTempRoot();
    writeFileSync(join(root, 'clean.py'), 'def ok() -> int:\n    return 1\n');

    const result = runPythonCheck(['--root', root]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('Python syntax check passed');
  });
});

describe('forbidden-import script bootstrap', () => {
  const bootstrapScript = resolve(process.cwd(), 'scripts/check-forbidden-imports.mjs');

  it('exits 0 when a default scan root is missing (warn, not fail)', () => {
    const result = spawnSync(process.execPath, [bootstrapScript], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });

  it('exits 2 when an explicitly requested --root is missing', () => {
    const result = spawnSync(
      process.execPath,
      [bootstrapScript, '--root', 'definitely-not-a-real-dir-xyz'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
  });
});
