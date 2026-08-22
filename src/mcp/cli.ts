#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createImagePumaMcpService, type ImagePumaMcpServiceOptions } from './service';
import { InMemoryMcpPlanStore } from './plan-store';
import { serveImagePumaMcpStdio } from './server';
import { formatDoctorReport, runMcpDoctor } from './doctor';

interface CliConfig {
  command: 'serve' | 'doctor' | 'config';
  transport: 'stdio';
  allowedDirs: string[];
  presetFilePath?: string;
  planTtlMs?: number;
  maxPlans?: number;
  limits: ImagePumaMcpServiceOptions['limits'];
  json?: boolean;
  packageSpec?: string;
  serverName?: string;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  setExitCode?: (code: number) => void;
}

function usage(): string {
  return [
    'Usage:',
    '  image-puma mcp serve --transport stdio --allow-dir /absolute/folder',
    '  image-puma-mcp serve --allow-dir /absolute/folder',
    '  image-puma mcp doctor --allow-dir /absolute/folder',
    '  image-puma mcp config --allow-dir /absolute/folder',
    '',
    'Commands:',
    '  serve                    Start the stdio MCP server.',
    '  doctor                   Check local runtime dependencies and allowed roots.',
    '  config                   Print a Claude Desktop mcpServers JSON block.',
    '',
    'Options:',
    '  --allow-dir <dir>          Allowed image/input/output root. Repeatable.',
    '  --transport stdio         MCP transport. Only stdio is supported.',
    '  --presets-file <path>     User preset JSON file.',
    '  --plan-ttl-ms <number>    Stored plan TTL in milliseconds.',
    '  --max-plans <number>      Maximum stored plans.',
    '  --max-files <number>      Maximum accepted files per plan.',
    '  --max-total-bytes <n>     Maximum total input bytes per plan.',
    '  --max-megapixels <n>      Maximum megapixels per file.',
    '  --processing-timeout-seconds <n>  Maximum Sharp processing seconds per image.',
    '  --json                    Print machine-readable doctor output.',
    '  --package <spec>          Package spec for config output. Default: image-puma@<version>.',
    '  --server-name <name>      Server key for config output. Default: image-puma.',
  ].join('\n');
}

function readValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
  const inlinePrefix = `${option}=`;
  const current = args[index];
  if (current.startsWith(inlinePrefix)) {
    return { value: current.slice(inlinePrefix.length), nextIndex: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function readAllowDirValues(args: string[], index: number): { values: string[]; nextIndex: number } {
  const option = '--allow-dir';
  const inlinePrefix = `${option}=`;
  const current = args[index];
  if (current.startsWith(inlinePrefix)) {
    const value = current.slice(inlinePrefix.length);
    if (!value) throw new Error(`${option} requires a value.`);
    return { values: [value], nextIndex: index };
  }

  const values: string[] = [];
  let nextIndex = index + 1;
  while (nextIndex < args.length && !args[nextIndex].startsWith('--')) {
    values.push(args[nextIndex]);
    nextIndex += 1;
  }
  if (values.length === 0) {
    throw new Error(`${option} requires a value.`);
  }
  return { values, nextIndex: nextIndex - 1 };
}

/**
 * Claude Desktop substitutes `${user_config.*}` values into server args without
 * expanding the `${HOME}`-style variables used by manifest directory defaults,
 * so the literal string `${HOME}/Pictures` can arrive as an allowed root.
 * Expand the documented MCPB path variables and a leading `~` here so the
 * server starts no matter which side performs the expansion.
 */
export function expandPathVariables(value: string): string {
  const home = os.homedir();
  const replacements: Record<string, string> = {
    '${HOME}': home,
    '${DESKTOP}': path.join(home, 'Desktop'),
    '${DOCUMENTS}': path.join(home, 'Documents'),
    '${DOWNLOADS}': path.join(home, 'Downloads'),
  };
  let expanded = value;
  let replaced = false;
  for (const [token, replacement] of Object.entries(replacements)) {
    if (!expanded.includes(token)) continue;
    expanded = expanded.split(token).join(replacement);
    replaced = true;
  }
  if (expanded === '~') return home;
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    return path.join(home, expanded.slice(2));
  }
  // MCPB defaults like `${HOME}/Pictures` keep a POSIX slash after the home
  // path; normalize so Windows allowed roots are real drive-letter paths.
  return replaced ? path.normalize(expanded) : expanded;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number.`);
  }
  return Math.round(parsed);
}

function splitAllowedDirsEnv(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const value = raw.trim();

  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed.map((item) => item.trim()).filter(Boolean);
      }
    } catch {
      // Fall through to delimiter parsing.
    }
  }

  const delimiters = [path.delimiter, '\n', ','];
  const delimiter = delimiters.find((item) => value.includes(item));
  if (!delimiter) return [value];
  return value.split(delimiter).map((item) => item.trim()).filter(Boolean);
}

function readPackageVersion(): string {
  const candidates = [
    path.resolve(__dirname, '../../package.json'),
    path.resolve(__dirname, '../../../package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version;
    } catch {
      // Try the next candidate.
    }
  }

  return '1.0.0';
}

function normalizeConfigAllowedDir(dir: string): string {
  if (dir.trim().startsWith('~')) {
    throw new Error('Config output needs absolute paths. A leading "~" is not expanded by mcpServers JSON.');
  }
  return path.resolve(dir);
}

export function generateMcpServersConfig(options: {
  allowedDirs: string[];
  packageSpec?: string;
  serverName?: string;
}): Record<string, unknown> {
  if (options.allowedDirs.length === 0) {
    throw new Error('mcp config needs at least one --allow-dir.');
  }

  const allowedDirs = options.allowedDirs.map(normalizeConfigAllowedDir);
  const packageSpec = options.packageSpec || `image-puma@${readPackageVersion()}`;
  const serverName = options.serverName || 'image-puma';
  const args = [
    '-y',
    packageSpec,
    'mcp',
    'serve',
    '--transport',
    'stdio',
    ...allowedDirs.flatMap((dir) => ['--allow-dir', dir]),
  ];

  return {
    mcpServers: {
      [serverName]: {
        command: 'npx',
        args,
      },
    },
  };
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  const args = [...argv];
  if (args[0] === 'mcp') args.shift();
  if (args[0] === '--help' || args[0] === '-h') {
    throw new Error(usage());
  }

  let command: CliConfig['command'] = 'serve';
  if (args[0] === 'serve' || args[0] === 'doctor' || args[0] === 'config') {
    command = args.shift() as CliConfig['command'];
  }

  const allowedDirs = splitAllowedDirsEnv(env.IMAGE_PUMA_ALLOW_DIRS);

  const config: CliConfig = {
    command,
    transport: 'stdio',
    allowedDirs,
    limits: {},
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--allow-dir' || arg.startsWith('--allow-dir=')) {
      const { values, nextIndex } = readAllowDirValues(args, index);
      config.allowedDirs.push(...values);
      index = nextIndex;
    } else if (arg === '--transport' || arg.startsWith('--transport=')) {
      const { value, nextIndex } = readValue(args, index, '--transport');
      if (value !== 'stdio') throw new Error('Only --transport stdio is supported.');
      config.transport = value;
      index = nextIndex;
    } else if (arg === '--presets-file' || arg.startsWith('--presets-file=')) {
      const { value, nextIndex } = readValue(args, index, '--presets-file');
      config.presetFilePath = value;
      index = nextIndex;
    } else if (arg === '--plan-ttl-ms' || arg.startsWith('--plan-ttl-ms=')) {
      const { value, nextIndex } = readValue(args, index, '--plan-ttl-ms');
      config.planTtlMs = parsePositiveInteger(value, '--plan-ttl-ms');
      index = nextIndex;
    } else if (arg === '--max-plans' || arg.startsWith('--max-plans=')) {
      const { value, nextIndex } = readValue(args, index, '--max-plans');
      config.maxPlans = parsePositiveInteger(value, '--max-plans');
      index = nextIndex;
    } else if (arg === '--max-files' || arg.startsWith('--max-files=')) {
      const { value, nextIndex } = readValue(args, index, '--max-files');
      config.limits = { ...config.limits, maxFiles: parsePositiveInteger(value, '--max-files') };
      index = nextIndex;
    } else if (arg === '--max-total-bytes' || arg.startsWith('--max-total-bytes=')) {
      const { value, nextIndex } = readValue(args, index, '--max-total-bytes');
      config.limits = { ...config.limits, maxTotalInputBytes: parsePositiveInteger(value, '--max-total-bytes') };
      index = nextIndex;
    } else if (arg === '--max-megapixels' || arg.startsWith('--max-megapixels=')) {
      const { value, nextIndex } = readValue(args, index, '--max-megapixels');
      config.limits = { ...config.limits, maxMegapixelsPerFile: parsePositiveInteger(value, '--max-megapixels') };
      index = nextIndex;
    } else if (arg === '--processing-timeout-seconds' || arg.startsWith('--processing-timeout-seconds=')) {
      const { value, nextIndex } = readValue(args, index, '--processing-timeout-seconds');
      config.limits = {
        ...config.limits,
        processingTimeoutSeconds: parsePositiveInteger(value, '--processing-timeout-seconds'),
      };
      index = nextIndex;
    } else if (arg === '--json') {
      config.json = true;
    } else if (arg === '--package' || arg.startsWith('--package=')) {
      const { value, nextIndex } = readValue(args, index, '--package');
      config.packageSpec = value;
      index = nextIndex;
    } else if (arg === '--server-name' || arg.startsWith('--server-name=')) {
      const { value, nextIndex } = readValue(args, index, '--server-name');
      config.serverName = value;
      index = nextIndex;
    } else if (arg.trim().length > 0) {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  config.allowedDirs = config.allowedDirs.map(expandPathVariables);
  if (config.presetFilePath) config.presetFilePath = expandPathVariables(config.presetFilePath);

  return config;
}

export async function runCli(
  argv = process.argv.slice(2),
  env = process.env,
  io: CliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  },
): Promise<void> {
  const config = parseCliArgs(argv, env);
  if (config.command === 'config') {
    const mcpConfig = generateMcpServersConfig({
      allowedDirs: config.allowedDirs,
      packageSpec: config.packageSpec,
      serverName: config.serverName,
    });
    io.stdout.write(`${JSON.stringify(mcpConfig, null, 2)}\n`);
    return;
  }

  if (config.command === 'doctor') {
    const report = await runMcpDoctor({
      allowedDirs: config.allowedDirs,
      presetFilePath: config.presetFilePath,
    });
    io.stdout.write(`${formatDoctorReport(report, { json: Boolean(config.json) })}\n`);
    if (!report.ok) io.setExitCode?.(1);
    return;
  }

  const service = await createImagePumaMcpService({
    allowedDirs: config.allowedDirs,
    includeDefaultDirs: true,
    presetFilePath: config.presetFilePath,
    limits: config.limits,
    planStore: new InMemoryMcpPlanStore({
      ttlMs: config.planTtlMs,
      maxEntries: config.maxPlans,
    }),
  });

  await serveImagePumaMcpStdio(service);
}

if (require.main === module) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
