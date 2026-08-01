import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import Ajv2020 from 'ajv/dist/2020';
import {
  MODERN_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  UNSUPPORTED_PROTOCOL_VERSION_ERROR,
} from '../src/mcp/protocol-2026';
import { IMAGE_PUMA_TOOL_NAMES } from '../src/mcp/server';

/**
 * Conformance checks for the MCP 2026-07-28 revision, following the minimal
 * checklist in the spec's upgrade guidance. These pin the dual-era contract:
 * legacy `initialize` clients keep working while modern clients get a stateless,
 * self-describing server.
 */

const JSON_SCHEMA_2020_12_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Minimal raw JSON-RPC driver. The SDK client always performs the `initialize`
 * handshake, which is exactly the behaviour these tests need to bypass.
 */
class RawServer {
  private buffer = '';
  private readonly messages: JsonRpcMessage[] = [];
  private readonly waiters: Array<{
    id: number | string;
    resolve: (message: JsonRpcMessage) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
  }

  static start(allowDir: string): RawServer {
    const child = spawn(process.execPath, [
      path.resolve(__dirname, '../src/mcp/cli.js'),
      'mcp',
      'serve',
      '--allow-dir',
      allowDir,
      '--presets-file',
      path.join(allowDir, 'presets.json'),
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    return new RawServer(child);
  }

  send(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async call(message: JsonRpcMessage & { id: number | string }): Promise<JsonRpcMessage> {
    this.send(message);
    return this.waitForId(message.id);
  }

  waitForId(id: number | string): Promise<JsonRpcMessage> {
    const existing = this.messages.find((message) => message.id === id);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for response ${id}`)), 10_000);
      this.waiters.push({ id, resolve, timer });
    });
  }

  /** Responses to ids the server should never answer, e.g. notifications. */
  answeredIds(): Array<number | string> {
    return this.messages.map((message) => message.id).filter((id): id is number | string => id !== undefined);
  }

  stop(): void {
    for (const waiter of this.waiters.splice(0)) clearTimeout(waiter.timer);
    this.child.kill('SIGTERM');
  }

  private consume(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonRpcMessage;
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.id !== message.id) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }
}

async function withServer(run: (server: RawServer) => Promise<void>): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-2026-'));
  const server = RawServer.start(tmpRoot);
  try {
    await run(server);
  } finally {
    server.stop();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function initialize(server: RawServer, protocolVersion: string, id = 1): Promise<JsonRpcMessage> {
  return server.call({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'conformance-test', version: '1.0.0' },
    },
  });
}

test('initialize echoes every supported legacy version', async () => {
  const legacyVersions = SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version !== MODERN_PROTOCOL_VERSION);
  assert.ok(legacyVersions.length > 0);

  for (const version of legacyVersions) {
    await withServer(async (server) => {
      const response = await initialize(server, version);
      assert.equal(response.result?.protocolVersion, version, `initialize did not echo ${version}`);
    });
  }
});

test('initialize falls back to the latest legacy version, never a modern one', async () => {
  // Handshake-era clients disconnect on an initialize response carrying a
  // version they cannot speak, so the fallback must stay legacy.
  const latestLegacy = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version !== MODERN_PROTOCOL_VERSION);

  for (const requested of ['1900-01-01', MODERN_PROTOCOL_VERSION]) {
    await withServer(async (server) => {
      const response = await initialize(server, requested);
      const negotiated = response.result?.protocolVersion;
      assert.equal(negotiated, latestLegacy);
      assert.notEqual(negotiated, MODERN_PROTOCOL_VERSION);
    });
  }
});

test('server/discover advertises versions newest-first with cache metadata', async () => {
  await withServer(async (server) => {
    const response = await server.call({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
    const result = response.result;
    assert.ok(result, `server/discover failed: ${JSON.stringify(response.error)}`);

    assert.equal(result.resultType, 'complete');
    assert.deepEqual(result.supportedVersions, [...SUPPORTED_PROTOCOL_VERSIONS]);
    assert.equal((result.supportedVersions as string[])[0], MODERN_PROTOCOL_VERSION);
    assert.ok(result.capabilities);
    assert.equal(typeof result.ttlMs, 'number');
    assert.equal(result.cacheScope, 'private');

    const serverInfo = (result._meta as Record<string, { name?: string; version?: string }>)
      ?.['io.modelcontextprotocol/serverInfo'];
    assert.equal(serverInfo?.name, 'image-puma');
    assert.equal(typeof serverInfo?.version, 'string');
  });
});

test('every request is served without a prior initialize', async () => {
  await withServer(async (server) => {
    const tools = await server.call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal((tools.result?.tools as unknown[])?.length, IMAGE_PUMA_TOOL_NAMES.length);

    const prompts = await server.call({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} });
    assert.ok(prompts.result?.prompts);

    const call = await server.call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'image_puma_list_presets', arguments: {} },
    });
    assert.ok(call.result?.structuredContent);
  });
});

test('list results are cacheable and deterministically ordered', async () => {
  await withServer(async (server) => {
    const first = await server.call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const second = await server.call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    for (const result of [first.result, second.result]) {
      assert.equal(typeof result?.ttlMs, 'number');
      assert.equal(result?.cacheScope, 'private');
    }

    const order = (first.result?.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.deepEqual(order, [...IMAGE_PUMA_TOOL_NAMES]);
    assert.deepEqual((second.result?.tools as Array<{ name: string }>).map((tool) => tool.name), order);

    const prompts = await server.call({ jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} });
    assert.equal(typeof prompts.result?.ttlMs, 'number');
    assert.equal(prompts.result?.cacheScope, 'private');
  });
});

test('an unsupported per-request protocol version is rejected with -32022', async () => {
  await withServer(async (server) => {
    const response = await server.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } },
    });

    assert.equal(response.error?.code, UNSUPPORTED_PROTOCOL_VERSION_ERROR);
    const data = response.error?.data as { supported?: string[]; requested?: string };
    assert.deepEqual(data.supported, [...SUPPORTED_PROTOCOL_VERSIONS]);
    assert.equal(data.requested, '1900-01-01');

    // A supported version on the same connection is still served normally.
    const modern = await server.call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION } },
    });
    assert.ok(modern.result?.tools);
  });
});

test('requests without a declared protocol version keep legacy semantics', async () => {
  await withServer(async (server) => {
    const response = await server.call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.ok(response.result, 'a version-less legacy request must not be rejected');
  });
});

test('protocol faults use the spec-assigned JSON-RPC codes', async () => {
  await withServer(async (server) => {
    const unknownMethod = await server.call({ jsonrpc: '2.0', id: 1, method: 'no/such/method', params: {} });
    assert.equal(unknownMethod.error?.code, -32601);

    const unknownTool = await server.call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'image_puma_not_a_tool', arguments: {} },
    });
    assert.equal(unknownTool.error?.code, -32602);

    const missingName = await server.call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} });
    assert.equal(missingName.error?.code, -32602);

    const unknownPrompt = await server.call({
      jsonrpc: '2.0',
      id: 4,
      method: 'prompts/get',
      params: { name: 'not-a-prompt' },
    });
    assert.equal(unknownPrompt.error?.code, -32602);
  });
});

test('tool execution failures stay isError results rather than JSON-RPC errors', async () => {
  // SEP-1303: a tool that runs and fails reports through `isError` so the model
  // can self-correct. Only protocol-level faults become JSON-RPC errors.
  await withServer(async (server) => {
    const response = await server.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'image_puma_describe_preset', arguments: { presetId: 'definitely-not-a-preset' } },
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result?.isError, true);
    assert.equal(response.result?.resultType, 'complete');
  });
});

test('every result carries resultType complete and identifies the server', async () => {
  await withServer(async (server) => {
    const responses = await Promise.all([
      initialize(server, '2025-11-25', 1),
      server.call({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      server.call({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      server.call({ jsonrpc: '2.0', id: 4, method: 'prompts/list', params: {} }),
      server.call({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'image_puma_settings_schema', arguments: {} },
      }),
      server.call({
        jsonrpc: '2.0',
        id: 6,
        method: 'prompts/get',
        params: { name: 'image-puma', arguments: {} },
      }),
    ]);

    for (const response of responses) {
      assert.ok(response.result, `request ${response.id} failed: ${JSON.stringify(response.error)}`);
      assert.equal(response.result?.resultType, 'complete', `request ${response.id} is missing resultType`);
      const serverInfo = (response.result?._meta as Record<string, { name?: string }>)
        ?.['io.modelcontextprotocol/serverInfo'];
      assert.equal(serverInfo?.name, 'image-puma', `request ${response.id} is missing serverInfo`);
    }
  });
});

test('tool-owned _meta survives alongside the injected serverInfo', async () => {
  await withServer(async (server) => {
    const response = await server.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'image_puma_describe_preset', arguments: { presetId: 'nope' } },
    });

    const meta = response.result?._meta as Record<string, unknown>;
    assert.ok(meta['io.github.panth-net/Image-Puma'], 'server error payload was overwritten');
    assert.ok(meta['io.modelcontextprotocol/serverInfo']);
  });
});

test('every tool schema is strict JSON Schema 2020-12 with an object root', async () => {
  await withServer(async (server) => {
    const response = await server.call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = response.result?.tools as Array<Record<string, unknown>>;
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });

    for (const tool of tools) {
      for (const key of ['inputSchema', 'outputSchema']) {
        const schema = tool[key] as Record<string, unknown> | undefined;
        if (!schema) continue;
        const label = `${String(tool.name)}.${key}`;

        assert.equal(schema.$schema, JSON_SCHEMA_2020_12_DIALECT, `${label} declares the wrong dialect`);
        assert.equal(schema.type, 'object', `${label} is not an object at the top level`);
        assert.equal(ajv.validateSchema(schema), true, `${label} failed the 2020-12 metaschema: ${ajv.errorsText()}`);
        assert.doesNotThrow(() => ajv.compile(schema), `${label} failed strict compilation`);
      }
    }
  });
});

test('notifications are accepted and never answered', async () => {
  await withServer(async (server) => {
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } });
    server.send({ jsonrpc: '2.0', method: 'notifications/not_a_real_notification', params: {} });

    // A later request proves the server survived them and answered only this id.
    await server.call({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    assert.deepEqual(server.answeredIds(), [7]);
  });
});

test('the server never initiates requests to the client', async () => {
  // Server-initiated requests are replaced by MRTR in the modern revision. This
  // server only reads client roots, which it skips when no `roots` capability
  // was declared — the permanent state for a modern stateless client.
  await withServer(async (server) => {
    await server.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'image_puma_plan',
        arguments: { inputs: ['/definitely/not/allowed.png'] },
        _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION },
      },
    });

    const inbound = server.answeredIds();
    assert.deepEqual(inbound, [1], 'server sent an unexpected request or notification to the client');
  });
});
