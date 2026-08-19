import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { runExiftoolCommand } from '../core/processing/metadata-cleaning';
import type { UserPresetRepository } from '../core/presets/user-presets';
import { createImagePumaMcpService } from './service';
import { resolveAllowedRoots } from './path-policy';

const nodeRequire = createRequire(__filename);
const cleanupOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
const windowsCleanupScript = [
  "const fs = require('fs/promises');",
  'const target = process.argv[1];',
  `fs.rm(target, ${JSON.stringify(cleanupOptions)}).catch(() => undefined);`,
].join('');

function cleanupBestEffort(target: string): void {
  if (process.platform === 'win32') {
    try {
      const cleanupProcess = spawn(process.execPath, ['-e', windowsCleanupScript, target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      cleanupProcess.unref();
    } catch {
      // Best-effort: failure to start cleanup shouldn't block the doctor report.
    }
    return;
  }

  fs.rm(target, cleanupOptions).catch(() => {
    // Best-effort: cleanup failure shouldn't block the doctor report.
  });
}

export type DoctorCheckStatus = 'pass' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  details?: unknown;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  allowedDirs?: string[];
  presetFilePath?: string;
}

const MIN_NODE_VERSION = {
  major: 20,
  minor: 3,
  patch: 0,
};

const emptyPresetRepository: UserPresetRepository = {
  loadUserPresets: () => [],
  saveUserPreset: () => [],
  deleteUserPreset: () => [],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareNodeVersion(actual: string): number {
  const [major = 0, minor = 0, patch = 0] = actual.split('.').map((part) => Number(part));
  if (major !== MIN_NODE_VERSION.major) return major - MIN_NODE_VERSION.major;
  if (minor !== MIN_NODE_VERSION.minor) return minor - MIN_NODE_VERSION.minor;
  return patch - MIN_NODE_VERSION.patch;
}

async function checkNodeVersion(): Promise<DoctorCheck> {
  const actual = process.versions.node;
  if (compareNodeVersion(actual) >= 0) {
    return {
      name: 'node-version',
      status: 'pass',
      message: `Node ${actual} satisfies >=20.3.0.`,
    };
  }

  return {
    name: 'node-version',
    status: 'fail',
    message: `Node ${actual} is too old. Image Puma MCP requires Node >=20.3.0.`,
  };
}

async function checkSharp(): Promise<DoctorCheck> {
  try {
    await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    }).png().toBuffer();

    return {
      name: 'sharp',
      status: 'pass',
      message: `Sharp loaded (sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}).`,
    };
  } catch (error) {
    return {
      name: 'sharp',
      status: 'fail',
      message: `Sharp failed to load or process a probe image: ${errorMessage(error)}`,
    };
  }
}

async function checkExiftool(): Promise<DoctorCheck> {
  try {
    const result = await runExiftoolCommand(['-ver']);
    return {
      name: 'exiftool',
      status: 'pass',
      message: `ExifTool resolved and ran (${result.stdout.trim() || 'version unavailable'}).`,
    };
  } catch (error) {
    return {
      name: 'exiftool',
      status: 'fail',
      message: `ExifTool could not run: ${errorMessage(error)}`,
    };
  }
}

async function checkAllowedRoots(allowedDirs: string[] = []): Promise<DoctorCheck> {
  if (allowedDirs.length === 0) {
    return {
      name: 'allowed-roots',
      status: 'fail',
      message: 'No allowed roots configured. Pass at least one --allow-dir absolute folder.',
    };
  }

  try {
    const roots = await resolveAllowedRoots(allowedDirs);
    return {
      name: 'allowed-roots',
      status: 'pass',
      message: `${roots.length} allowed root${roots.length === 1 ? '' : 's'} resolved.`,
      details: roots,
    };
  } catch (error) {
    return {
      name: 'allowed-roots',
      status: 'fail',
      message: errorMessage(error),
    };
  }
}

async function checkWriteProbe(allowedDirs: string[] = []): Promise<DoctorCheck> {
  if (allowedDirs.length === 0) {
    return {
      name: 'write-permission',
      status: 'fail',
      message: 'Write probe needs at least one --allow-dir.',
    };
  }

  try {
    const roots = await resolveAllowedRoots(allowedDirs);
    for (const root of roots) {
      const probeDir = path.join(root.realPath, `.image-puma-doctor-${process.pid}-${Date.now()}`);
      await fs.mkdir(probeDir, { recursive: false });
      await fs.writeFile(path.join(probeDir, 'probe.txt'), 'ok');
      cleanupBestEffort(probeDir);
    }

    return {
      name: 'write-permission',
      status: 'pass',
      message: 'Allowed roots accepted a temporary write probe.',
    };
  } catch (error) {
    return {
      name: 'write-permission',
      status: 'fail',
      message: `Allowed root write probe failed: ${errorMessage(error)}`,
    };
  }
}

async function withNetworkTrap(fn: () => Promise<void>): Promise<string[]> {
  const attempts: string[] = [];
  const originalFetch = globalThis.fetch;
  const httpAny = nodeRequire('http') as {
    request: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
  };
  const httpsAny = nodeRequire('https') as {
    request: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
  };
  const originalHttpRequest = httpAny.request;
  const originalHttpGet = httpAny.get;
  const originalHttpsRequest = httpsAny.request;
  const originalHttpsGet = httpsAny.get;
  const fail = (label: string) => {
    attempts.push(label);
    throw new Error(`Network access attempted through ${label}`);
  };

  globalThis.fetch = (async () => fail('fetch')) as typeof fetch;
  httpAny.request = () => fail('http.request');
  httpAny.get = () => fail('http.get');
  httpsAny.request = () => fail('https.request');
  httpsAny.get = () => fail('https.get');

  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    httpAny.request = originalHttpRequest;
    httpAny.get = originalHttpGet;
    httpsAny.request = originalHttpsRequest;
    httpsAny.get = originalHttpsGet;
  }

  return attempts;
}

async function writeProbeImage(inputPath: string): Promise<void> {
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 80, g: 120, b: 170 },
    },
  }).jpeg().toFile(inputPath);
}

async function checkRuntimePlanRunNoNetwork(): Promise<DoctorCheck> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-mcp-doctor-'));
  try {
    const inputPath = path.join(tmpRoot, 'source.jpg');
    const outputDir = path.join(tmpRoot, 'out');
    await fs.mkdir(outputDir);
    await writeProbeImage(inputPath);

    const attempts = await withNetworkTrap(async () => {
      const service = await createImagePumaMcpService({
        allowedDirs: [tmpRoot],
        presetRepository: emptyPresetRepository,
      });
      const plan = await service.plan({
        inputs: [inputPath],
        outputDir,
        customSettings: {
          output: { format: 'webp' },
          naming: { suffix: '-doctor' },
        },
      });
      await service.run({
        planId: plan.planId,
        confirmed: true,
        acceptWarnings: true,
      });
    });

    if (attempts.length > 0) {
      return {
        name: 'runtime-no-network',
        status: 'fail',
        message: `Runtime probe attempted network access: ${attempts.join(', ')}`,
      };
    }

    return {
      name: 'runtime-no-network',
      status: 'pass',
      message: 'Plan/run probe completed without fetch/http/https network calls.',
    };
  } catch (error) {
    return {
      name: 'runtime-no-network',
      status: 'fail',
      message: `Runtime plan/run probe failed: ${errorMessage(error)}`,
    };
  } finally {
    cleanupBestEffort(tmpRoot);
  }
}

export async function runMcpDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkNodeVersion(),
    checkSharp(),
    checkExiftool(),
    checkAllowedRoots(options.allowedDirs),
    checkWriteProbe(options.allowedDirs),
    checkRuntimePlanRunNoNetwork(),
  ]);

  return {
    ok: checks.every((check) => check.status === 'pass'),
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport, options: { json?: boolean } = {}): string {
  if (options.json) return JSON.stringify(report, null, 2);

  const lines = [
    `Image Puma MCP doctor: ${report.ok ? 'ok' : 'failed'}`,
    ...report.checks.map((check) => {
      const marker = check.status === 'pass' ? 'PASS' : 'FAIL';
      return `${marker} ${check.name}: ${check.message}`;
    }),
  ];
  return lines.join('\n');
}
