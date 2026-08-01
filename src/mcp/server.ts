import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, Icon } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import type { BatchProgressUpdate, InputScanProgress } from '../core/shared/types';
import {
  ImagePumaMcpError,
  type McpFaviconInput,
  type McpPlanInput,
  type McpRunInput,
} from './types';
import {
  describePresetOutputSchema,
  faviconOutputSchema,
  listPresetsOutputSchema,
  planOutputSchema,
  runOutputSchema,
  settingsSchemaOutputSchema,
} from './output-schemas';
import type { ImagePumaMcpService } from './service';
import { ModernProtocolTransport } from './protocol-2026';

const HOMEPAGE_URL = 'https://github.com/panth-net/Image-Puma';

const SERVER_NAME = 'image-puma';
const SERVER_VERSION = '1.1.0';

/**
 * Registration order, which is also the order `tools/list` returns. It is
 * deliberately workflow-ordered rather than alphabetical — plan before run
 * reads better to a model — and stable across calls, which is what the
 * 2026-07-28 deterministic-ordering guidance asks for.
 */
export const IMAGE_PUMA_TOOL_NAMES = [
  'image_puma_plan',
  'image_puma_run',
  'image_puma_list_presets',
  'image_puma_describe_preset',
  'image_puma_settings_schema',
  'image_puma_generate_favicon',
] as const;

const SERVER_INSTRUCTIONS = [
  'Image Puma plans and runs local image compression batches.',
  'Always call image_puma_plan before image_puma_run.',
  'Never call image_puma_run until the user has reviewed the plan and confirmed it.',
].join(' ');

const planInputSchema = {
  inputs: z.array(z.string()).min(1),
  presetId: z.string().optional(),
  customSettings: z.record(z.string(), z.unknown()).optional(),
  outputDir: z.string().optional(),
  recursive: z.boolean().optional(),
  allowOverwrite: z.boolean().optional(),
};

const runInputSchema = {
  planId: z.string().min(1),
  confirmed: z.literal(true),
  acceptWarnings: z.boolean().optional(),
};

const describePresetInputSchema = {
  presetId: z.string().min(1),
};

const faviconInputSchema = {
  sourcePath: z.string().min(1),
  outputDir: z.string().min(1),
  folderName: z.string().max(120).optional(),
  confirmed: z.literal(true),
};

function toolResult(structuredContent: Record<string, unknown>, text: string): CallToolResult {
  return {
    structuredContent,
    content: [{ type: 'text', text }],
  };
}

/**
 * Tool execution errors are reported with `isError` so the model can self-correct
 * (SEP-1303) rather than as JSON-RPC protocol errors.
 *
 * The machine-readable payload rides in `_meta`, not `structuredContent`:
 * `structuredContent` is the contract described by a tool's `outputSchema`, and
 * clients validate it whenever it is present — including on error results — so
 * an error-shaped object there would fail validation against the success schema.
 */
function toolError(error: unknown): CallToolResult {
  const mcpError = error instanceof ImagePumaMcpError
    ? error
    : new ImagePumaMcpError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));

  return {
    isError: true,
    _meta: {
      'io.github.panth-net/Image-Puma': {
        error: {
          code: mcpError.code,
          message: mcpError.message,
          details: mcpError.details,
        },
      },
    },
    content: [{ type: 'text', text: `${mcpError.code}: ${mcpError.message}` }],
  };
}

function progressText(progress: BatchProgressUpdate): string {
  const count = `${progress.completedCount}/${progress.totalCount}`;
  if (progress.currentFile) return `${count} ${progress.currentFile}`;
  return count;
}

async function reportProgress(
  progress: BatchProgressUpdate,
  extra: Parameters<Parameters<McpServer['registerTool']>[2]>[1],
): Promise<void> {
  if (extra._meta?.progressToken === undefined) return;
  await extra.sendNotification({
    method: 'notifications/progress',
    params: {
      progressToken: extra._meta.progressToken,
      progress: progress.completedCount,
      total: progress.totalCount,
      message: progressText(progress),
    },
  });
}

async function reportPlanProgress(
  progress: InputScanProgress,
  extra: Parameters<Parameters<McpServer['registerTool']>[2]>[1],
): Promise<void> {
  if (extra._meta?.progressToken === undefined) return;
  await extra.sendNotification({
    method: 'notifications/progress',
    params: {
      progressToken: extra._meta.progressToken,
      progress: progress.checkedCount,
      message: progress.currentPath
        ? `Planning: ${progress.currentPath}`
        : `Planning: ${progress.acceptedCount} accepted, ${progress.skippedCount} skipped`,
    },
  });
}

async function getClientRootDirs(server: McpServer): Promise<string[]> {
  if (!server.server.getClientCapabilities()?.roots) return [];

  const rootsResult = await server.server.listRoots();
  return rootsResult.roots
    .map((root) => {
      try {
        const url = new URL(root.uri);
        if (url.protocol !== 'file:') return null;
        return fileURLToPath(url);
      } catch {
        return null;
      }
    })
    .filter((root): root is string => Boolean(root));
}

/**
 * Inlines the server icon as a data URI so icon rendering never makes a network
 * request. Returns undefined when the asset is missing rather than failing to
 * start, since the icon is cosmetic.
 */
function loadServerIcons(): Icon[] | undefined {
  const candidates = [
    path.resolve(__dirname, '../../assets/icons/image-puma-48.png'),
    path.resolve(__dirname, '../../../assets/icons/image-puma-48.png'),
  ];

  for (const candidate of candidates) {
    try {
      const base64 = fs.readFileSync(candidate).toString('base64');
      return [{
        src: `data:image/png;base64,${base64}`,
        mimeType: 'image/png',
        sizes: ['48x48'],
      }];
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

export function createImagePumaMcpServer(service: ImagePumaMcpService): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'Image Puma',
      version: SERVER_VERSION,
      description: 'Plans and runs local batch image preparation. Images never leave the machine.',
      websiteUrl: HOMEPAGE_URL,
      icons: loadServerIcons(),
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool('image_puma_plan', {
    title: 'Plan Image Puma Batch',
    description: 'Create a read-only Image Puma batch plan for allowed local image paths.',
    inputSchema: planInputSchema,
    outputSchema: planOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input, extra) => {
    const pendingProgress: Array<Promise<void>> = [];
    try {
      const result = await service.plan(input as McpPlanInput, {
        signal: extra.signal,
        allowedDirs: await getClientRootDirs(server),
        onScanProgress: (progress) => {
          pendingProgress.push(reportPlanProgress(progress, extra).catch((): undefined => undefined));
        },
      });
      await Promise.all(pendingProgress);
      return toolResult(
        result as unknown as Record<string, unknown>,
        `Plan ${result.planId}: ${result.acceptedFiles.length} accepted, ${result.plannedOutputs.length} outputs, ${result.warnings.length} warnings, ${result.errors.length} errors.`,
      );
    } catch (error) {
      await Promise.all(pendingProgress);
      return toolError(error);
    }
  });

  server.registerTool('image_puma_run', {
    title: 'Run Image Puma Plan',
    description: 'Run a previously created Image Puma plan after explicit confirmation.',
    inputSchema: runInputSchema,
    outputSchema: runOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input, extra) => {
    try {
      const result = await service.run(input as McpRunInput, {
        signal: extra.signal,
        onProgress: (progress) => reportProgress(progress, extra).catch((): undefined => undefined),
      });
      return toolResult(
        result as unknown as Record<string, unknown>,
        `Run ${result.planId}: ${result.result.successCount} succeeded, ${result.result.failureCount} failed, ${result.result.skippedCount} skipped.`,
      );
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('image_puma_list_presets', {
    title: 'List Image Puma Presets',
    description: 'List MCP-available built-in and user presets.',
    outputSchema: listPresetsOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
    try {
      const result = service.listPresets();
      return toolResult(
        result as unknown as Record<string, unknown>,
        `Found ${result.presets.length} available presets and ${result.unavailablePresets.length} unavailable presets.`,
      );
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('image_puma_describe_preset', {
    title: 'Describe Image Puma Preset',
    description: 'Return exact settings for one MCP-available preset.',
    inputSchema: describePresetInputSchema,
    outputSchema: describePresetOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    try {
      const result = service.describePreset(input);
      return toolResult(
        result as unknown as Record<string, unknown>,
        `Preset ${result.preset.id}: ${result.preset.name}.`,
      );
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('image_puma_settings_schema', {
    title: 'Image Puma Settings Schema',
    description: 'Return the JSON Schema for custom Image Puma settings accepted by image_puma_plan.',
    outputSchema: settingsSchemaOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
    try {
      const schema = service.settingsSchema();
      return toolResult(
        { schema },
        'Returned the ImagePumaSettings JSON Schema.',
      );
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('image_puma_generate_favicon', {
    title: 'Generate Favicon and App Icon Bundle',
    description: 'Generate browser favicon assets plus ICO, ICNS, and PNG app icons from one local image.',
    inputSchema: faviconInputSchema,
    outputSchema: faviconOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input) => {
    try {
      const result = await service.generateFavicon(input as McpFaviconInput, {
        allowedDirs: await getClientRootDirs(server),
      });
      return toolResult(
        result as unknown as Record<string, unknown>,
        `Generated ${result.files.length} favicon and app-icon files in ${result.outputDirectory}.`,
      );
    } catch (error) {
      return toolError(error);
    }
  });

  registerImagePumaPrompt(server);
  return server;
}

function registerImagePumaPrompt(server: McpServer): void {
  server.registerPrompt('image-puma', {
    title: 'Image Puma',
    description: 'Plan and run a local batch image job: compress, resize, convert, strip metadata, thumbnails, favicons.',
    argsSchema: {
      task: z.string().optional().describe('What to do, including local image paths or folders.'),
    },
  }, (args) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          'Use the Image Puma MCP tools for this local image task.',
          args.task ? `Task: ${args.task}` : 'Ask me which images to process and what result I want.',
          'Create an Image Puma plan only first — call image_puma_plan. Do not run it yet.',
          'Pick a preset with image_puma_list_presets, or use custom settings (schema via image_puma_settings_schema).',
          'Show the returned plan, warnings, and planned output paths. Call image_puma_run only after I explicitly confirm.',
        ].join(' '),
      },
    }],
  }));
}

export async function serveImagePumaMcpStdio(service: ImagePumaMcpService): Promise<void> {
  const server = createImagePumaMcpServer(service);
  await server.connect(createModernStdioTransport());
}

/**
 * Wraps the stdio transport in the 2026-07-28 conformance layer. The SDK still
 * handles `initialize` for legacy clients; the wrapper adds `server/discover`,
 * per-request protocol versioning, and the result fields the modern revision
 * requires. `listChanged` is deliberately absent from the advertised modern
 * capabilities: the tool and prompt lists are fixed, so the server never pushes
 * change notifications.
 */
function createModernStdioTransport(): ModernProtocolTransport {
  return new ModernProtocolTransport(new StdioServerTransport(), {
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: { tools: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
    toolNames: IMAGE_PUMA_TOOL_NAMES,
  });
}
