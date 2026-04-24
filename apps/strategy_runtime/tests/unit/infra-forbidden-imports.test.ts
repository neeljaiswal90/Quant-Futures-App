import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());
const guardScript = resolve(repoRoot, 'scripts/check-forbidden-imports.mjs');
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
});
