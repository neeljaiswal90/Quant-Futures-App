import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const PROBE_SCRIPT = resolve('scripts/infra/capture-rithmic-probe.py');

const REQUIRED_SAMPLE_PB2 = [
  'base_pb2.py',
  'request_heartbeat_pb2.py',
  'response_heartbeat_pb2.py',
  'request_rithmic_system_info_pb2.py',
  'response_rithmic_system_info_pb2.py',
  'request_login_pb2.py',
  'response_login_pb2.py',
  'request_logout_pb2.py',
  'response_logout_pb2.py',
  'request_market_data_update_pb2.py',
  'response_market_data_update_pb2.py',
  'last_trade_pb2.py',
  'best_bid_offer_pb2.py',
];

const REQUIRED_PROTO_FILES = [
  'request_market_data_update.proto',
  'request_depth_by_order_updates.proto',
  'response_depth_by_order_updates.proto',
  'order_book.proto',
  'depth_by_order.proto',
  'last_trade.proto',
  'best_bid_offer.proto',
];

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function makeFakeSdk(): string {
  const root = makeTempDir('qfa-rprotocol-sdk-');
  const sampleDir = join(root, 'samples', 'samples.py');
  const protoDir = join(root, 'proto');
  const etcDir = join(root, 'etc');

  mkdirSync(sampleDir, { recursive: true });
  mkdirSync(protoDir, { recursive: true });
  mkdirSync(etcDir, { recursive: true });
  writeFileSync(join(sampleDir, 'SampleMD.py'), '# sample placeholder\n', 'utf8');
  writeFileSync(join(etcDir, 'rithmic_ssl_cert_auth_params'), '# cert placeholder\n', 'utf8');

  for (const fileName of REQUIRED_SAMPLE_PB2) {
    writeFileSync(join(sampleDir, fileName), '# generated sample placeholder\n', 'utf8');
  }

  for (const fileName of REQUIRED_PROTO_FILES) {
    writeFileSync(join(protoDir, fileName), 'message Placeholder {}\n', 'utf8');
  }

  return root;
}

function pythonScript(body: string): string {
  return `
import importlib.util
import json
import pathlib
import sys

script_path = pathlib.Path(${JSON.stringify(PROBE_SCRIPT)})
spec = importlib.util.spec_from_file_location("capture_rithmic_probe", script_path)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

${body}
`;
}

function runPython(body: string): string {
  const result = spawnSync(PYTHON, ['-c', pythonScript(body)], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`Python failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return result.stdout.trim();
}

describe('Rithmic probe Python bootstrap helpers', () => {
  it('defaults protobuf runtime to pure Python before pb2 imports', () => {
    const stdout = runPython(`
import os
print(os.environ.get("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"))
`);

    expect(stdout).toBe('python');
  });

  it('constructs an absolute generated protobuf cache directory and creates it', () => {
    const sdk = makeFakeSdk();

    const stdout = runPython(`
paths = mod.resolve_sdk_paths(${JSON.stringify(sdk)})
print(json.dumps({
    "cache_dir": str(paths.cache_dir),
    "exists": paths.cache_dir.exists(),
    "is_absolute": paths.cache_dir.is_absolute(),
}))
`);
    const payload = JSON.parse(stdout) as {
      readonly cache_dir: string;
      readonly exists: boolean;
      readonly is_absolute: boolean;
    };

    expect(payload.exists).toBe(true);
    expect(payload.is_absolute).toBe(true);
    expect(payload.cache_dir.replaceAll('\\', '/')).toMatch(/\/\.cache\/rprotocol_pb2$/);
  });

  it('adds both SDK samples and generated module cache paths to sys.path', () => {
    const sdk = makeFakeSdk();

    const stdout = runPython(`
paths = mod.resolve_sdk_paths(${JSON.stringify(sdk)})
mod.insert_module_paths(paths)
print(json.dumps({
    "sample_path_present": str(paths.sample_py_dir.resolve()) in sys.path,
    "cache_path_present": str(paths.cache_dir.resolve()) in sys.path,
}))
`);
    const payload = JSON.parse(stdout) as {
      readonly sample_path_present: boolean;
      readonly cache_path_present: boolean;
    };

    expect(payload.sample_path_present).toBe(true);
    expect(payload.cache_path_present).toBe(true);
  });

  it('reports actionable context when protoc does not create the expected generated file', () => {
    const sdk = makeFakeSdk();

    const stdout = runPython(`
paths = mod.resolve_sdk_paths(${JSON.stringify(sdk)})

def fake_grpc_tools(proto_dir, cache_dir, proto_file):
    return ["python", "-m", "grpc_tools.protoc", f"-I{proto_dir}", f"--python_out={cache_dir}", str(proto_dir / proto_file)]

def fake_protoc(proto_dir, cache_dir, proto_file):
    return None

mod.compile_proto_with_grpc_tools = fake_grpc_tools
mod.compile_proto_with_protoc = fake_protoc

try:
    mod.ensure_generated_pb2_module("missing_depth_pb2", "depth_by_order.proto", paths)
except mod.ProbeConfigError as exc:
    print(str(exc))
else:
    raise AssertionError("expected ProbeConfigError")
`);

    expect(stdout).toContain('Protobuf generation completed but missing_depth_pb2 was not produced.');
    expect(stdout).toContain('RITHMIC_RPROTOCOL_HOME:');
    expect(stdout).toContain('proto_dir:');
    expect(stdout).toContain('cache_dir:');
    expect(stdout).toContain('protoc command used:');
    expect(stdout).toContain('expected generated file path:');
    expect(stdout).toContain('missing_depth_pb2.py');
  });

  it('parses stream subsets and rejects unsupported stream names', () => {
    const stdout = runPython(`
valid = sorted(mod.parse_streams("last_trade, L1_QUOTE"))
try:
    mod.parse_streams("LAST_TRADE,BOOKMAP")
except Exception as exc:
    invalid = str(exc)
else:
    raise AssertionError("expected invalid stream failure")
print(json.dumps({"valid": valid, "invalid": invalid}))
`);
    const payload = JSON.parse(stdout) as {
      readonly valid: readonly string[];
      readonly invalid: string;
    };

    expect(payload.valid).toEqual(['L1_QUOTE', 'LAST_TRADE']);
    expect(payload.invalid).toContain('BOOKMAP');
    expect(payload.invalid).toContain('Allowed values');
  });

  it('uses confirmed RProtocol template IDs as CLI defaults', () => {
    const stdout = runPython(`
import sys
sys.argv = ["capture-rithmic-probe.py"]
args = mod.parse_args()
print(json.dumps({
    "order_book": args.order_book_template_id,
    "request_depth": args.request_depth_by_order_template_id,
    "response_depth": args.response_depth_by_order_template_id,
    "depth_by_order": args.depth_by_order_template_id,
    "depth_end": args.depth_by_order_end_event_template_id,
}))
`);
    const payload = JSON.parse(stdout) as {
      readonly order_book: number;
      readonly request_depth: number;
      readonly response_depth: number;
      readonly depth_by_order: number;
      readonly depth_end: number;
    };

    expect(payload).toEqual({
      order_book: 156,
      request_depth: 117,
      response_depth: 118,
      depth_by_order: 160,
      depth_end: 161,
    });
  });

  it('lets CLI flags override confirmed RProtocol template IDs', () => {
    const stdout = runPython(`
import sys
sys.argv = [
    "capture-rithmic-probe.py",
    "--order-book-template-id", "956",
    "--request-depth-by-order-template-id", "917",
    "--response-depth-by-order-template-id", "918",
    "--depth-by-order-template-id", "960",
    "--depth-by-order-end-event-template-id", "961",
]
args = mod.parse_args()
print(json.dumps({
    "order_book": args.order_book_template_id,
    "request_depth": args.request_depth_by_order_template_id,
    "response_depth": args.response_depth_by_order_template_id,
    "depth_by_order": args.depth_by_order_template_id,
    "depth_end": args.depth_by_order_end_event_template_id,
}))
`);
    const payload = JSON.parse(stdout) as {
      readonly order_book: number;
      readonly request_depth: number;
      readonly response_depth: number;
      readonly depth_by_order: number;
      readonly depth_end: number;
    };

    expect(payload).toEqual({
      order_book: 956,
      request_depth: 917,
      response_depth: 918,
      depth_by_order: 960,
      depth_end: 961,
    });
  });
});
