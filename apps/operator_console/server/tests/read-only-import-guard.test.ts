import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReadOnlyImportGuard } from '../src/safety/read-only-import-guard.js';

const repoRoot = findRepoRoot(process.cwd());
const tempDirs: string[] = [];

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (manifest.name === 'quant-futures-app') {
        return current;
      }
    } catch {
      // Keep walking.
    }

    const parent = resolve(current, '..');
    if (parent === current) {
      throw new Error('Unable to find quant-futures-app repo root');
    }
    current = parent;
  }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'operator-console-guard-'));
  tempDirs.push(root);
  return root;
}

function writeFixture(path: string, contents: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

function run(root: string) {
  return runReadOnlyImportGuard({ repoRoot: root, roots: ['console'] });
}

describe('operator console read-only import guard', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('passes the real console scaffold', () => {
    const findings = runReadOnlyImportGuard({
      repoRoot,
      roots: ['apps/operator_console/server/src', 'apps/operator_console/web/src'],
    });

    expect(findings).toEqual([]);
  });

  it('allows contract and availability-mask imports', () => {
    const root = tempRoot();
    writeFixture(
      join(root, 'console.ts'),
      [
        "import type { RuntimeEventType } from 'apps/strategy_runtime/src/contracts/events/index.js';",
        "import { FEATURE_AVAILABILITY_MASK } from 'apps/strategy_runtime/src/features/availability-mask.js';",
        'void FEATURE_AVAILABILITY_MASK;',
      ].join('\n'),
    );
    writeFixture(
      join(root, 'apps', 'strategy_runtime', 'src', 'contracts', 'events', 'index.ts'),
      'export type RuntimeEventType = "CONN";\n',
    );
    writeFixture(
      join(root, 'apps', 'strategy_runtime', 'src', 'features', 'availability-mask.ts'),
      'export const FEATURE_AVAILABILITY_MASK = {};\n',
    );

    const findings = runReadOnlyImportGuard({ repoRoot: root, roots: ['.'] });

    expect(findings).toEqual([]);
  });

  it('blocks direct mutation-capable runtime imports', () => {
    const root = tempRoot();
    writeFixture(
      join(root, 'bad.ts'),
      "import { SimulatedExecutionAdapter } from 'apps/strategy_runtime/src/execution/simulated-execution.js';\n",
    );
    writeFixture(
      join(root, 'apps', 'strategy_runtime', 'src', 'execution', 'simulated-execution.ts'),
      'export const SimulatedExecutionAdapter = {};\n',
    );

    const findings = runReadOnlyImportGuard({ repoRoot: root, roots: ['.'] });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain('mutation-capable');
  });

  it('blocks transitive relative imports into mutation-capable modules', () => {
    const root = tempRoot();
    const consoleRoot = join(root, 'console');
    const runtimeRoot = join(root, 'apps', 'strategy_runtime', 'src', 'orchestration');
    writeFixture(join(consoleRoot, 'entry.ts'), "import './bridge.js';\n");
    writeFixture(
      join(consoleRoot, 'bridge.ts'),
      "import { eventBus } from '../apps/strategy_runtime/src/orchestration/event-bus.js';\n",
    );
    writeFixture(join(runtimeRoot, 'event-bus.ts'), 'export const eventBus = {};\n');

    const findings = run(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.specifier).toContain('event-bus');
  });

  it('blocks envelope creation even without an import', () => {
    const root = tempRoot();
    writeFixture(join(root, 'bad.ts'), 'const x = createJournalEventEnvelope;\nvoid x;\n');

    const findings = runReadOnlyImportGuard({ repoRoot: root, roots: ['.'] });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain('must not create JournalEventEnvelope');
  });
});
