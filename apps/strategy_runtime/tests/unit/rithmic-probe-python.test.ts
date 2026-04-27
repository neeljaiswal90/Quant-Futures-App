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

  it('omits optional sequence when Rithmic does not provide one', () => {
    const stdout = runPython(`
class EmptyMessage:
    pass

record = mod.make_probe_record(
    probe_id="probe-1",
    symbol="MNQM6",
    exchange="CME",
    stream="L1_QUOTE",
    template_id=151,
    payload_kind="BestBidOffer",
    message=EmptyMessage(),
    raw=False,
    raw_buffer=b"",
)
print(json.dumps({"has_sequence": "sequence" in record, "timestamp_source": record["timestamp_source"]}))
`);
    const payload = JSON.parse(stdout) as {
      readonly has_sequence: boolean;
      readonly timestamp_source: string;
    };

    expect(payload).toEqual({
      has_sequence: false,
      timestamp_source: 'unavailable',
    });
  });

  it('normalizes LAST_TRADE parity payload fields only when requested', () => {
    const stdout = runPython(`
class LastTrade:
    source_ssboe = 1700000000
    source_nsecs = 123456789
    trade_price = 27369.25
    trade_size = 3
    aggressor = 1
    exchange_order_id = "ord-1"
    sequence_number = 42

minimal = mod.make_probe_record(
    probe_id="probe-1",
    symbol="MNQM6",
    exchange="CME",
    stream="LAST_TRADE",
    template_id=150,
    payload_kind="LastTrade",
    message=LastTrade(),
    raw=False,
    raw_buffer=b"",
)
rich = mod.make_probe_record(
    probe_id="probe-1",
    symbol="MNQM6",
    exchange="CME",
    stream="LAST_TRADE",
    template_id=150,
    payload_kind="LastTrade",
    message=LastTrade(),
    raw=False,
    raw_buffer=b"",
    parity_payload=True,
)
print(json.dumps({
    "minimal_has_price": "price" in minimal,
    "rich_price": rich.get("price"),
    "rich_size": rich.get("size"),
    "rich_aggressor": rich.get("aggressor"),
    "rich_side": rich.get("side"),
    "rich_order_id": rich.get("exchange_order_id"),
    "sequence": rich.get("sequence"),
    "exchange_ts_type": type(rich.get("exchange_event_ts_ns")).__name__,
}))
`);
    const payload = JSON.parse(stdout) as {
      readonly minimal_has_price: boolean;
      readonly rich_price: number;
      readonly rich_size: number;
      readonly rich_aggressor: string;
      readonly rich_side: string;
      readonly rich_order_id: string;
      readonly sequence: string;
      readonly exchange_ts_type: string;
    };

    expect(payload).toEqual({
      minimal_has_price: false,
      rich_price: 27369.25,
      rich_size: 3,
      rich_aggressor: 'buy',
      rich_side: 'buy',
      rich_order_id: 'ord-1',
      sequence: '42',
      exchange_ts_type: 'str',
    });
  });

  it('normalizes L1_QUOTE parity payload fields', () => {
    const stdout = runPython(`
class BestBidOffer:
    ssboe = 1700000000
    usecs = 250
    bid_price = 27369.0
    ask_price = 27369.25
    bid_size = 5
    ask_size = 2
    bid_orders = 4
    ask_orders = 1

record = mod.make_probe_record(
    probe_id="probe-1",
    symbol="MNQM6",
    exchange="CME",
    stream="L1_QUOTE",
    template_id=151,
    payload_kind="BestBidOffer",
    message=BestBidOffer(),
    raw=False,
    raw_buffer=b"",
    parity_payload=True,
)
print(json.dumps({
    "bid_px": record.get("bid_px"),
    "ask_px": record.get("ask_px"),
    "bid_sz": record.get("bid_sz"),
    "ask_sz": record.get("ask_sz"),
    "bid_orders": record.get("bid_orders"),
    "ask_orders": record.get("ask_orders"),
    "exchange_event_ts_ns": record.get("exchange_event_ts_ns"),
}))
`);
    const payload = JSON.parse(stdout) as {
      readonly bid_px: number;
      readonly ask_px: number;
      readonly bid_sz: number;
      readonly ask_sz: number;
      readonly bid_orders: number;
      readonly ask_orders: number;
      readonly exchange_event_ts_ns: string;
    };

    expect(payload).toEqual({
      bid_px: 27369,
      ask_px: 27369.25,
      bid_sz: 5,
      ask_sz: 2,
      bid_orders: 4,
      ask_orders: 1,
      exchange_event_ts_ns: '1700000000000250000',
    });
  });

  it('normalizes MBP10 parity payload levels', () => {
    const stdout = runPython(`
class OrderBook:
    ssboe = 1700000000
    usecs = 250
    bid_price = [27369.0, 27368.75]
    bid_size = [5, 4]
    bid_orders = [4, 3]
    ask_price = [27369.25, 27369.5]
    ask_size = [2, 6]
    ask_orders = [1, 5]

record = mod.make_probe_record(
    probe_id="probe-1",
    symbol="MNQM6",
    exchange="CME",
    stream="MBP10",
    template_id=156,
    payload_kind="OrderBook",
    message=OrderBook(),
    raw=False,
    raw_buffer=b"",
    parity_payload=True,
)
print(json.dumps({"bids": record.get("bids"), "asks": record.get("asks")}))
`);
    const payload = JSON.parse(stdout) as {
      readonly bids: readonly { readonly level: number; readonly px: number; readonly sz: number; readonly order_count: number }[];
      readonly asks: readonly { readonly level: number; readonly px: number; readonly sz: number; readonly order_count: number }[];
    };

    expect(payload.bids).toEqual([
      { level: 0, px: 27369, sz: 5, order_count: 4 },
      { level: 1, px: 27368.75, sz: 4, order_count: 3 },
    ]);
    expect(payload.asks).toEqual([
      { level: 0, px: 27369.25, sz: 2, order_count: 1 },
      { level: 1, px: 27369.5, sz: 6, order_count: 5 },
    ]);
  });

  it('normalizes MBO parity payload order updates', () => {
    const stdout = runPython(`
class DepthByOrder:
    source_ssboe = 1700000000
    source_usecs = 500
    sequence_number = 987654321
    update_type = [1, 2]
    transaction_type = [1, 2]
    depth_price = [27369.0, 27369.25]
    depth_size = [5, 1]
    exchange_order_id = ["bid-1", "ask-1"]
    depth_order_priority = [100, 200]

record = mod.make_probe_record(
    probe_id="probe-1",
    symbol="MNQM6",
    exchange="CME",
    stream="MBO",
    template_id=160,
    payload_kind="DepthByOrder",
    message=DepthByOrder(),
    raw=False,
    raw_buffer=b"",
    parity_payload=True,
)
print(json.dumps({
    "sequence": record.get("sequence"),
    "action": record.get("action"),
    "side": record.get("side"),
    "price": record.get("price"),
    "size": record.get("size"),
    "order_id": record.get("order_id"),
    "priority": record.get("priority"),
    "orders": record.get("orders"),
}))
`);
    const payload = JSON.parse(stdout) as {
      readonly sequence: string;
      readonly action: string;
      readonly side: string;
      readonly price: number;
      readonly size: number;
      readonly order_id: string;
      readonly priority: string;
      readonly orders: readonly Record<string, unknown>[];
    };

    expect(payload.sequence).toBe('987654321');
    expect(payload.action).toBe('new');
    expect(payload.side).toBe('buy');
    expect(payload.price).toBe(27369);
    expect(payload.size).toBe(5);
    expect(payload.order_id).toBe('bid-1');
    expect(payload.priority).toBe('100');
    expect(payload.orders).toEqual([
      {
        index: 0,
        action: 'new',
        side: 'buy',
        price: 27369,
        size: 5,
        order_id: 'bid-1',
        priority: '100',
      },
      {
        index: 1,
        action: 'change',
        side: 'sell',
        price: 27369.25,
        size: 1,
        order_id: 'ask-1',
        priority: '200',
      },
    ]);
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

  it('defaults parity payload capture off and enables it only by flag', () => {
    const stdout = runPython(`
import sys
sys.argv = ["capture-rithmic-probe.py"]
default_args = mod.parse_args()
sys.argv = ["capture-rithmic-probe.py", "--parity-payload"]
enabled_args = mod.parse_args()
print(json.dumps({
    "default_parity_payload": default_args.parity_payload,
    "enabled_parity_payload": enabled_args.parity_payload,
}))
`);
    const payload = JSON.parse(stdout) as {
      readonly default_parity_payload: boolean;
      readonly enabled_parity_payload: boolean;
    };

    expect(payload).toEqual({
      default_parity_payload: false,
      enabled_parity_payload: true,
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
