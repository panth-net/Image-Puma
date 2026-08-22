import { z } from 'zod';

/**
 * Output schemas for every Image Puma tool.
 *
 * MCP 2025-11-25 lets a server describe its structured results so clients can
 * validate them instead of guessing at the shape. The SDK checks a successful
 * result's `structuredContent` against these, so they stay deliberately
 * permissive for deeply nested payloads (presets, per-file results) and precise
 * for the fields callers actually branch on.
 */

const looseObject = z.record(z.string(), z.unknown());

const planIssueSchema = z.object({
  level: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  sourcePath: z.string().optional(),
});

const fileSummarySchema = z.object({
  sourcePath: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  format: z.string().optional(),
});

const plannedOutputSchema = z.object({
  sourcePath: z.string(),
  outputPath: z.string(),
  format: z.string(),
  collision: z.enum(['none', 'renamed', 'overwrite']),
});

const jobSummarySchema = z.object({
  presetId: z.string(),
  format: z.string(),
  quality: z.number().optional(),
  pngCompression: z.number().optional(),
  lossless: z.boolean(),
  resize: z.string().describe('none, or a short resize like "fit-box 1920x1920".'),
});

const skippedInputSchema = z.object({
  path: z.string(),
  reason: z.string(),
  message: z.string(),
});

const presetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  builtIn: z.boolean(),
});

export const planOutputSchema = {
  planId: z.string().describe('Handle to pass to image_puma_run after the user confirms.'),
  expiresAt: z.string().describe('ISO timestamp after which the plan can no longer be run.'),
  job: jobSummarySchema.describe('Format, quality, lossless, and resize the run would apply.'),
  acceptedFiles: z.array(fileSummarySchema),
  skippedFiles: z.array(skippedInputSchema),
  plannedOutputs: z.array(plannedOutputSchema).describe('Every file the run would write.'),
  warnings: z.array(planIssueSchema),
  errors: z.array(planIssueSchema).describe('Non-empty means the plan cannot be run as-is.'),
  requiresConfirmation: z.boolean(),
};

export const runOutputSchema = {
  planId: z.string(),
  result: z
    .object({
      results: z.array(z.object({
        outputPath: z.string(),
        success: z.boolean(),
        originalSize: z.number(),
        outputSize: z.number(),
        error: z.string().optional(),
      })),
      totalOriginalBytes: z.number(),
      totalOutputBytes: z.number(),
      totalSavedBytes: z.number(),
      successCount: z.number(),
      failureCount: z.number(),
      skippedCount: z.number(),
      cancelledCount: z.number(),
    })
    .describe('Per-file outcomes plus batch byte and count totals.'),
  outputFolders: z.array(z.string()).describe('Directories the run wrote into.'),
};

export const listPresetsOutputSchema = {
  presets: z.array(presetSummarySchema),
  unavailablePresets: z.array(
    presetSummarySchema.extend({
      unavailableReason: z.string(),
    }),
  ).describe('Presets the desktop app offers that this MCP server cannot run.'),
};

export const describePresetOutputSchema = {
  preset: looseObject.describe('Exact preset settings, matching the settings schema.'),
  builtIn: z.boolean(),
};

export const settingsSchemaOutputSchema = {
  schema: looseObject.describe('JSON Schema for the customSettings accepted by image_puma_plan.'),
};

export const faviconOutputSchema = {
  sourcePath: z.string(),
  outputDirectory: z.string(),
  files: z.array(
    z.object({
      fileName: z.string(),
      outputPath: z.string(),
      purpose: z.string(),
      size: z.string().optional(),
    }),
  ),
};
