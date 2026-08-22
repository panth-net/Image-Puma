import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

async function writeInputImage(tmpRoot: string, name = 'stdio-source.jpg'): Promise<string> {
  const inputPath = path.join(tmpRoot, name);
  await sharp({
    create: {
      width: 48,
      height: 32,
      channels: 3,
      background: { r: 120, g: 90, b: 40 },
    },
  }).jpeg().toFile(inputPath);
  return inputPath;
}

async function removeTempDir(dir: string): Promise<void> {
  // Windows Sharp handles keep files locked; awaited fs.rm retries EBUSY and can hang the test process.
  if (process.platform === 'win32') return;
  await fs.rm(dir, { recursive: true, force: true });
}

function structured<T>(result: unknown): T {
  const record = result as { structuredContent?: Record<string, unknown> | undefined };
  assert.ok(record.structuredContent);
  return record.structuredContent as T;
}

/**
 * Error results carry their machine-readable payload in `_meta`, not
 * `structuredContent`, so it never has to satisfy the tool's success outputSchema.
 */
function toolErrorPayload<T = { code: string; message: string; details?: unknown }>(
  result: unknown,
): T {
  const record = result as {
    _meta?: Record<string, { error?: unknown } | undefined>;
    structuredContent?: unknown;
  };
  assert.equal(record.structuredContent, undefined, 'error results must not set structuredContent');
  const payload = record._meta?.['io.github.panth-net/Image-Puma']?.error;
  assert.ok(payload, 'error result is missing its _meta error payload');
  return payload as T;
}

function compiledCliPath(): string {
  return path.resolve(__dirname, '../src/mcp/cli.js');
}

test('MCP stdio server exposes all tools and runs plan to completion', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-mcp-stdio-'));
  const inputPath = await writeInputImage(tmpRoot);
  const outputDir = path.join(tmpRoot, 'out');
  const presetsPath = path.join(tmpRoot, 'presets.json');
  await fs.mkdir(outputDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      compiledCliPath(),
      'mcp',
      'serve',
      '--allow-dir',
      tmpRoot,
      '--presets-file',
      presetsPath,
    ],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'image-puma-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      'image_puma_describe_preset',
      'image_puma_generate_favicon',
      'image_puma_list_presets',
      'image_puma_plan',
      'image_puma_run',
      'image_puma_settings_schema',
    ]);

    const schemaCall = await client.callTool({ name: 'image_puma_settings_schema', arguments: {} });
    const schemaResult = structured<{ schema: { title?: string } }>(schemaCall);
    assert.equal(schemaResult.schema.title, 'ImagePumaSettings');

    const invalidSettingsCall = await client.callTool({
      name: 'image_puma_plan',
      arguments: {
        inputs: [inputPath],
        outputDir,
        customSettings: { output: { jpegQuality: 82.5 } },
      },
    });
    assert.equal(invalidSettingsCall.isError, true);
    const invalidSettings = toolErrorPayload<{ code: string; details?: { errors?: string[] } }>(invalidSettingsCall);
    assert.equal(invalidSettings.code, 'SETTINGS_INVALID');
    assert.ok(invalidSettings.details?.errors?.some((message) => message.includes('output.jpegQuality')));

    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((prompt) => prompt.name).sort();
    assert.deepEqual(promptNames, ['image-puma']);
    const prompt = await client.getPrompt({ name: 'image-puma', arguments: { task: inputPath } });
    const text = prompt.messages
      .map((message) => (message.content.type === 'text' ? message.content.text : ''))
      .join('\n');
    assert.match(text, /image_puma_plan/);
    assert.match(text, /Do not run it/);
    assert.match(text, /explicitly confirm/);
    assert.match(text, /quality/);
    assert.ok(text.includes(inputPath));

    const planProgress: unknown[] = [];
    const planCall = await client.callTool({
      name: 'image_puma_plan',
      arguments: {
        inputs: [inputPath],
        outputDir,
        customSettings: {
          output: { format: 'webp' },
          naming: { suffix: '-stdio' },
        },
      },
    }, undefined, {
      onprogress: (event) => {
        planProgress.push(event);
      },
    });
    assert.equal(planCall.isError, undefined);
    const plan = structured<{
      planId: string;
      plannedOutputs: Array<{ outputPath: string }>;
      errors: unknown[];
    }>(planCall);
    assert.equal(plan.errors.length, 0);
    assert.equal(plan.plannedOutputs.length, 1);
    assert.ok(planProgress.length > 0);

    const progress: unknown[] = [];
    const runCall = await client.callTool({
      name: 'image_puma_run',
      arguments: {
        planId: plan.planId,
        confirmed: true,
        acceptWarnings: true,
      },
    }, undefined, {
      onprogress: (event) => {
        progress.push(event);
      },
    });
    assert.equal(runCall.isError, undefined);
    const run = structured<{
      result: { successCount: number; failureCount: number; results: Array<{ outputPath: string }> };
    }>(runCall);
    assert.equal(run.result.successCount, 1);
    assert.equal(run.result.failureCount, 0);
    assert.ok(progress.length > 0);
    await fs.access(run.result.results[0].outputPath);
  } finally {
    await client.close().catch((): undefined => undefined);
    await removeTempDir(tmpRoot);
  }
});

test('MCP stdio server never asks the client for roots/list', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-mcp-roots-'));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-mcp-roots-outside-'));
  const inputPath = await writeInputImage(tmpRoot);
  const outsidePath = await writeInputImage(outsideRoot);
  const outputDir = path.join(tmpRoot, 'out');
  const presetsPath = path.join(tmpRoot, 'presets.json');
  await fs.mkdir(outputDir);
  let listedRoots = false;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      compiledCliPath(),
      'mcp',
      'serve',
      '--allow-dir',
      tmpRoot,
      '--presets-file',
      presetsPath,
    ],
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'image-puma-roots-client', version: '1.0.0' },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => {
    listedRoots = true;
    return { roots: [{ uri: tmpRoot, name: 'native-root' }] };
  });

  try {
    await client.connect(transport);
    const allowedPlanCall = await client.callTool({
      name: 'image_puma_plan',
      arguments: {
        inputs: [inputPath],
        outputDir,
        customSettings: { output: { format: 'webp' } },
      },
    });
    assert.equal(allowedPlanCall.isError, undefined);
    assert.equal(listedRoots, false, 'roots/list would crash Cursor on Windows drive-letter URIs');

    const blockedPlanCall = await client.callTool({
      name: 'image_puma_plan',
      arguments: {
        inputs: [outsidePath],
        outputDir,
      },
    });
    assert.equal(blockedPlanCall.isError, true);
    const blocked = toolErrorPayload<{ code: string }>(blockedPlanCall);
    assert.equal(blocked.code, 'PATH_NOT_ALLOWED');
  } finally {
    await client.close().catch((): undefined => undefined);
    await removeTempDir(tmpRoot);
    await removeTempDir(outsideRoot);
  }
});

test('MCP stdio server accepts native filesystem paths as inputs', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-mcp-native-paths-'));
  const inputPath = await writeInputImage(tmpRoot, 'ChatGPT Image Aug 20.jpg');
  const outputDir = path.join(tmpRoot, 'out');
  const presetsPath = path.join(tmpRoot, 'presets.json');
  await fs.mkdir(outputDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      compiledCliPath(),
      'mcp',
      'serve',
      '--allow-dir',
      tmpRoot,
      '--presets-file',
      presetsPath,
    ],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'image-puma-native-paths-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const planCall = await client.callTool({
      name: 'image_puma_plan',
      arguments: {
        inputs: [inputPath],
        outputDir,
        quality: 82,
        format: 'webp',
      },
    });
    assert.equal(planCall.isError, undefined, 'native Windows/POSIX paths with spaces must be accepted');
    const plan = structured<{
      plannedOutputs: Array<{ outputPath: string; format: string }>;
      job: { quality?: number; format?: string };
    }>(planCall);
    assert.equal(plan.job.quality, 82);
    assert.equal(plan.job.format, 'webp');
  } finally {
    await client.close().catch((): undefined => undefined);
    await removeTempDir(tmpRoot);
  }
});

test('MCP stdio plan request is cancelable through the SDK signal', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-mcp-cancel-'));
  const outputDir = path.join(tmpRoot, 'out');
  const presetsPath = path.join(tmpRoot, 'presets.json');
  await fs.mkdir(outputDir);
  for (let index = 0; index < 24; index++) {
    await writeInputImage(tmpRoot, `cancel-${index}.jpg`);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      compiledCliPath(),
      'mcp',
      'serve',
      '--allow-dir',
      tmpRoot,
      '--presets-file',
      presetsPath,
    ],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'image-puma-cancel-client', version: '1.0.0' });
  const controller = new AbortController();
  let sawProgress = false;

  try {
    await client.connect(transport);
    await assert.rejects(
      client.callTool({
        name: 'image_puma_plan',
        arguments: {
          inputs: [tmpRoot],
          outputDir,
          recursive: true,
          customSettings: { output: { format: 'webp' } },
        },
      }, undefined, {
        signal: controller.signal,
        onprogress: () => {
          sawProgress = true;
          controller.abort(new Error('test cancellation'));
        },
      }),
      /abort|cancel/i,
    );
    assert.equal(sawProgress, true);
  } finally {
    await client.close().catch((): undefined => undefined);
    await removeTempDir(tmpRoot);
  }
});

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class RawJsonRpcClient {
  private stdoutBuffer = '';
  private readonly messages: JsonRpcMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private parseError: Error | null = null;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    child.on('exit', () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Raw MCP server exited before the expected response.'));
      }
    });
  }

  send(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async waitForId(id: number, label: string): Promise<JsonRpcMessage> {
    return this.waitFor((message) => message.id === id, label);
  }

  assertNoStdoutParseError(): void {
    if (this.parseError) throw this.parseError;
  }

  private waitFor(predicate: (message: JsonRpcMessage) => boolean, label: string): Promise<JsonRpcMessage> {
    if (this.parseError) return Promise.reject(this.parseError);
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for raw MCP response: ${label}`));
      }, 5000);

      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf-8');
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch (error) {
        this.parseError = error instanceof Error
          ? new Error(`Non-JSON stdout from MCP server: ${line}\n${error.message}`)
          : new Error(`Non-JSON stdout from MCP server: ${line}`);
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(this.parseError);
        }
        return;
      }

      assert.equal(message.jsonrpc, '2.0');
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }
}

test('MCP raw stdout carries only JSON-RPC protocol messages during plan and run', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-mcp-raw-'));
  const inputPath = await writeInputImage(tmpRoot);
  const outputDir = path.join(tmpRoot, 'out');
  await fs.mkdir(outputDir);

  const child = spawn(process.execPath, [
    compiledCliPath(),
    'mcp',
    'serve',
    '--allow-dir',
    tmpRoot,
    '--presets-file',
    path.join(tmpRoot, 'presets.json'),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const raw = new RawJsonRpcClient(child);

  try {
    raw.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raw-mcp-test', version: '1.0.0' },
      },
    });
    const init = await raw.waitForId(1, 'initialize');
    assert.ok(init.result);
    raw.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    raw.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = await raw.waitForId(2, 'tools/list');
    assert.ok(tools.result);

    raw.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'image_puma_plan',
        arguments: {
          inputs: [inputPath],
          outputDir,
          customSettings: { output: { format: 'webp' }, naming: { suffix: '-raw' } },
        },
      },
    });
    const planResponse = await raw.waitForId(3, 'image_puma_plan');
    const planResult = planResponse.result as { structuredContent?: { planId?: string } };
    assert.equal(typeof planResult.structuredContent?.planId, 'string');

    raw.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'image_puma_run',
        arguments: {
          planId: planResult.structuredContent?.planId,
          confirmed: true,
          acceptWarnings: true,
        },
      },
    });
    const runResponse = await raw.waitForId(4, 'image_puma_run');
    const runResult = runResponse.result as { structuredContent?: { result?: { successCount?: number } } };
    assert.equal(runResult.structuredContent?.result?.successCount, 1);
    raw.assertNoStdoutParseError();
  } finally {
    child.kill('SIGTERM');
    await removeTempDir(tmpRoot);
  }
});

test('MCP source files do not write stray stdout', async () => {
  const srcDir = path.resolve(__dirname, '../../src/mcp');
  const entries = await fs.readdir(srcDir);
  const sourceFiles = entries.filter((entry) => entry.endsWith('.ts'));

  for (const fileName of sourceFiles) {
    const source = await fs.readFile(path.join(srcDir, fileName), 'utf-8');
    assert.equal(source.includes('console.log'), false, `${fileName} contains console.log`);
    assert.equal(source.includes('process.stdout.write'), false, `${fileName} writes stdout`);
  }
});
