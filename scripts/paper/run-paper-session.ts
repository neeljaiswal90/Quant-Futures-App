import {
  PaperTradingSession,
  resolvePaperTradingSessionConfig,
} from '../../apps/strategy_runtime/src/paper-trading/index.js';

const config = resolvePaperTradingSessionConfig();
const session = new PaperTradingSession({ config });

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await session.stop();
  process.stdout.write(`${JSON.stringify(session.getDiagnostics())}\n`);
}

process.once('SIGINT', () => {
  void stop().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void stop().finally(() => process.exit(0));
});

await session.start();
process.stdout.write(
  `QFA paper session started with adapter=${config.adapter_kind}; real Rithmic adapter not wired until QFA-612-PAPER-01b.\n`,
);
await new Promise((resolve) => setTimeout(resolve, config.duration_ms));
await stop();

