import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import type { AppPreset } from '../src/core/shared/types';
import { defaultPresets } from '../src/core/presets/default-presets';
import type { UserPresetRepository } from '../src/core/presets/user-presets';
import { InMemoryMcpPlanStore } from '../src/mcp/plan-store';
import { createImagePumaMcpService } from '../src/mcp/service';
import { applyCustomSettings } from '../src/mcp/settings-schema';
import { ImagePumaMcpError } from '../src/mcp/types';

const emptyPresetRepository: UserPresetRepository = {
  loadUserPresets: () => [],
  saveUserPreset: () => [],
  deleteUserPreset: () => [],
};

function clonePreset(preset: AppPreset): AppPreset {
  return {
    ...preset,
    output: { ...preset.output },
    resize: {
      ...preset.resize,
      responsiveWidths: Array.isArray(preset.resize.responsiveWidths)
        ? [...preset.resize.responsiveWidths]
        : [],
    },
    crop: { ...preset.crop },
    transform: { ...preset.transform },
    metadata: { ...preset.metadata },
    naming: { ...preset.naming },
    export: { ...preset.export },
    backgroundRemoval: preset.backgroundRemoval ? { ...preset.backgroundRemoval } : undefined,
  };
}

async function writeInputImage(tmpRoot: string, name = 'source.jpg'): Promise<string> {
  const inputPath = path.join(tmpRoot, name);
  await sharp({
    create: {
      width: 64,
      height: 40,
      channels: 3,
      background: { r: 80, g: 120, b: 170 },
    },
  }).jpeg().toFile(inputPath);
  return inputPath;
}

async function withTempRoot<T>(prefix: string, fn: (tmpRoot: string) => Promise<T>): Promise<T> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(tmpRoot);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

test('MCP service plans and runs an authoritative stored plan', async () => {
  await withTempRoot('image-puma-mcp-run-', async (tmpRoot) => {
    const inputPath = await writeInputImage(tmpRoot);
    const outputDir = path.join(tmpRoot, 'out');
    await fs.mkdir(outputDir);

    const service = await createImagePumaMcpService({
      allowedDirs: [tmpRoot],
      presetRepository: emptyPresetRepository,
    });

    const plan = await service.plan({
      inputs: [inputPath],
      presetId: 'default',
      outputDir,
      customSettings: {
        output: { format: 'webp', webpQuality: 75 },
        naming: { suffix: '-mcp' },
      },
    });

    assert.equal(plan.errors.length, 0);
    assert.equal(plan.requiresConfirmation, true);
    assert.equal(plan.acceptedFiles.length, 1);
    assert.equal(plan.plannedOutputs.length, 1);
    assert.equal(await fs.realpath(path.dirname(plan.plannedOutputs[0].outputPath)), await fs.realpath(outputDir));

    const progress: string[] = [];
    const run = await service.run({
      planId: plan.planId,
      confirmed: true,
      acceptWarnings: true,
    }, {
      onProgress: (update) => {
        progress.push(`${update.completedCount}/${update.totalCount}`);
      },
    });

    assert.equal(run.result.successCount, 1);
    assert.equal(run.result.failureCount, 0);
    assert.ok(progress.length > 0);
    await fs.access(run.result.results[0].outputPath);
    assert.equal(path.extname(run.result.results[0].outputPath), '.webp');
  });
});

test('MCP service generates a complete favicon and app-icon bundle inside an allowed root', async () => {
  await withTempRoot('image-puma-mcp-favicon-', async (tmpRoot) => {
    const inputPath = await writeInputImage(tmpRoot, 'logo.jpg');
    const outputDir = path.join(tmpRoot, 'public');
    await fs.mkdir(outputDir);
    const service = await createImagePumaMcpService({
      allowedDirs: [tmpRoot],
      presetRepository: emptyPresetRepository,
    });

    const result = await service.generateFavicon({
      sourcePath: inputPath,
      outputDir,
      confirmed: true,
    });

    assert.equal(result.files.length, 7);
    assert.equal(path.dirname(result.outputDirectory), await fs.realpath(outputDir));
    await fs.access(path.join(result.outputDirectory, 'favicon.ico'));
    await fs.access(path.join(result.outputDirectory, 'app-icon.icns'));
    await fs.access(path.join(result.outputDirectory, 'app-icon.ico'));
  });
});

test('MCP custom settings reject unknown keys and clamp numeric ranges', () => {
  const preset = clonePreset(defaultPresets[0]);
  const clamped = applyCustomSettings(preset, {
    output: { jpegQuality: 1000 },
    resize: { width: -10 },
  });
  assert.equal(clamped.output.jpegQuality, 100);
  assert.equal(clamped.resize.width, 1);

  assert.throws(
    () => applyCustomSettings(preset, { output: { madeUp: true } }),
    (error) => error instanceof ImagePumaMcpError && error.code === 'SETTINGS_INVALID',
  );
});

test('MCP custom settings match published schema constraints', () => {
  const preset = clonePreset(defaultPresets[0]);
  const assertSettingsInvalid = (customSettings: unknown, expectedPath: string): void => {
    assert.throws(
      () => applyCustomSettings(preset, customSettings),
      (error) => (
        error instanceof ImagePumaMcpError
        && error.code === 'SETTINGS_INVALID'
        && Array.isArray((error.details as { errors?: unknown[] } | undefined)?.errors)
        && ((error.details as { errors: string[] }).errors.some((message) => message.includes(expectedPath)))
      ),
    );
  };

  assertSettingsInvalid({ output: { jpegQuality: 88.5 } }, 'output.jpegQuality');
  assertSettingsInvalid({ resize: { responsiveWidths: [320.5] } }, 'resize.responsiveWidths[0]');
  assertSettingsInvalid({ resize: { responsiveWidths: Array.from({ length: 25 }, (_, index) => index + 1) } }, 'resize.responsiveWidths');
  assertSettingsInvalid({ naming: { suffix: 'x'.repeat(121) } }, 'naming.suffix');
  assertSettingsInvalid({ export: { siblingFolderName: '' } }, 'export.siblingFolderName');
});

test('MCP plan enforces allowed roots and rejects explicit symlink inputs', async () => {
  await withTempRoot('image-puma-mcp-paths-', async (tmpRoot) => {
    const inputPath = await writeInputImage(tmpRoot);
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-puma-mcp-outside-'));
    const symlinkPath = path.join(tmpRoot, 'linked.jpg');
    await fs.symlink(inputPath, symlinkPath);

    try {
      const service = await createImagePumaMcpService({
        allowedDirs: [tmpRoot],
        presetRepository: emptyPresetRepository,
      });

      await assert.rejects(
        service.plan({ inputs: [inputPath], outputDir: outsideRoot }),
        (error) => error instanceof ImagePumaMcpError && error.code === 'PATH_NOT_ALLOWED',
      );
      await assert.rejects(
        service.plan({ inputs: [symlinkPath] }),
        (error) => error instanceof ImagePumaMcpError && error.code === 'PATH_NOT_ALLOWED',
      );
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test('MCP run returns typed errors for expired and stale plans', async () => {
  await withTempRoot('image-puma-mcp-expire-', async (tmpRoot) => {
    const inputPath = await writeInputImage(tmpRoot);
    const outputDir = path.join(tmpRoot, 'out');
    await fs.mkdir(outputDir);
    let now = 1_000;
    const planStore = new InMemoryMcpPlanStore({
      ttlMs: 100,
      now: () => now,
    });
    const service = await createImagePumaMcpService({
      allowedDirs: [tmpRoot],
      presetRepository: emptyPresetRepository,
      planStore,
    });

    const plan = await service.plan({
      inputs: [inputPath],
      outputDir,
      customSettings: { output: { format: 'webp' } },
    });
    now += 101;

    await assert.rejects(
      service.run({ planId: plan.planId, confirmed: true, acceptWarnings: true }),
      (error) => error instanceof ImagePumaMcpError && error.code === 'PLAN_EXPIRED',
    );

    const freshPlan = await service.plan({
      inputs: [inputPath],
      outputDir,
      customSettings: { output: { format: 'webp', webpQuality: 70 }, naming: { suffix: '-fresh' } },
    });
    await fs.appendFile(inputPath, Buffer.from([0]));

    await assert.rejects(
      service.run({ planId: freshPlan.planId, confirmed: true, acceptWarnings: true }),
      (error) => error instanceof ImagePumaMcpError && error.code === 'PLAN_STALE',
    );
  });
});

test('MCP run rejects tampered stored plan output paths and variant settings', async () => {
  await withTempRoot('image-puma-mcp-tamper-', async (tmpRoot) => {
    const inputPath = await writeInputImage(tmpRoot);
    const outputDir = path.join(tmpRoot, 'out');
    await fs.mkdir(outputDir);
    const service = await createImagePumaMcpService({
      allowedDirs: [tmpRoot],
      presetRepository: emptyPresetRepository,
    });

    const forgedPathPlan = await service.plan({
      inputs: [inputPath],
      outputDir,
      customSettings: { output: { format: 'webp' }, naming: { suffix: '-forged-path' } },
    });
    const forgedStoredPlan = service.planStore.get(forgedPathPlan.planId);
    forgedStoredPlan.plan.entries[0].variants[0].outputPath = path.join(tmpRoot, 'forged-output.webp');

    await assert.rejects(
      service.run({ planId: forgedPathPlan.planId, confirmed: true, acceptWarnings: true }),
      (error) => error instanceof ImagePumaMcpError && error.code === 'PLAN_STALE',
    );

    const swappedPresetPlan = await service.plan({
      inputs: [inputPath],
      outputDir,
      customSettings: { output: { format: 'webp' }, naming: { suffix: '-swapped-preset' } },
    });
    const swappedStoredPlan = service.planStore.get(swappedPresetPlan.planId);
    swappedStoredPlan.plan.entries[0].variants[0].preset.output.format = 'png';

    await assert.rejects(
      service.run({ planId: swappedPresetPlan.planId, confirmed: true, acceptWarnings: true }),
      (error) => error instanceof ImagePumaMcpError && error.code === 'PLAN_STALE',
    );
  });
});

test('MCP plan rejects configured resource limits with structured errors', async () => {
  await withTempRoot('image-puma-mcp-limits-', async (tmpRoot) => {
    const firstInputPath = await writeInputImage(tmpRoot, 'first.jpg');
    const secondInputPath = await writeInputImage(tmpRoot, 'second.jpg');
    const outputDir = path.join(tmpRoot, 'out');
    await fs.mkdir(outputDir);

    const maxFilesService = await createImagePumaMcpService({
      allowedDirs: [tmpRoot],
      presetRepository: emptyPresetRepository,
      limits: { maxFiles: 1 },
    });
    await assert.rejects(
      maxFilesService.plan({ inputs: [firstInputPath, secondInputPath], outputDir }),
      (error) => (
        error instanceof ImagePumaMcpError
        && error.code === 'INPUT_LIMIT_EXCEEDED'
        && (error.details as { maxFiles?: number } | undefined)?.maxFiles === 1
      ),
    );

    const maxBytesService = await createImagePumaMcpService({
      allowedDirs: [tmpRoot],
      presetRepository: emptyPresetRepository,
      limits: { maxTotalInputBytes: 1 },
    });
    await assert.rejects(
      maxBytesService.plan({ inputs: [firstInputPath], outputDir }),
      (error) => (
        error instanceof ImagePumaMcpError
        && error.code === 'INPUT_LIMIT_EXCEEDED'
        && (error.details as { maxTotalInputBytes?: number } | undefined)?.maxTotalInputBytes === 1
      ),
    );

    const maxMegapixelsService = await createImagePumaMcpService({
      allowedDirs: [tmpRoot],
      presetRepository: emptyPresetRepository,
      limits: { maxMegapixelsPerFile: 0.001 },
    });
    await assert.rejects(
      maxMegapixelsService.plan({ inputs: [firstInputPath], outputDir }),
      (error) => (
        error instanceof ImagePumaMcpError
        && error.code === 'INPUT_LIMIT_EXCEEDED'
        && (error.details as { maxMegapixelsPerFile?: number } | undefined)?.maxMegapixelsPerFile === 0.001
      ),
    );
  });
});

test('MCP plan honors cancellation before storing a runnable plan', async () => {
  await withTempRoot('image-puma-mcp-plan-cancel-', async (tmpRoot) => {
    const inputPath = await writeInputImage(tmpRoot);
    const outputDir = path.join(tmpRoot, 'out');
    await fs.mkdir(outputDir);
    const service = await createImagePumaMcpService({
      allowedDirs: [tmpRoot],
      presetRepository: emptyPresetRepository,
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      service.plan({ inputs: [inputPath], outputDir }, { signal: controller.signal }),
      (error) => error instanceof ImagePumaMcpError && error.code === 'PLAN_CANCELLED',
    );
  });
});

test('MCP list and describe capability-gate background removal presets', async () => {
  const backgroundPreset = clonePreset(defaultPresets[0]);
  backgroundPreset.id = 'user-bg';
  backgroundPreset.name = 'User Background';
  backgroundPreset.backgroundRemoval = { enabled: true };

  const service = await createImagePumaMcpService({
    allowedDirs: [process.cwd()],
    presetRepository: {
      ...emptyPresetRepository,
      loadUserPresets: () => [backgroundPreset],
    },
  });

  const listed = service.listPresets();
  assert.equal(listed.presets.some((preset) => preset.id === 'user-bg'), false);
  assert.equal(listed.unavailablePresets.some((preset) => preset.id === 'user-bg'), true);
  assert.throws(
    () => service.describePreset({ presetId: 'user-bg' }),
    (error) => error instanceof ImagePumaMcpError && error.code === 'BACKGROUND_REMOVAL_UNAVAILABLE',
  );
});

test('MCP plans force overwrite off unless allowOverwrite is set at plan time', async () => {
  await withTempRoot('image-puma-mcp-overwrite-', async (tmpRoot) => {
    const inputPath = await writeInputImage(tmpRoot);
    const service = await createImagePumaMcpService({
      allowedDirs: [tmpRoot],
      presetRepository: emptyPresetRepository,
    });

    const plan = await service.plan({
      inputs: [inputPath],
      customSettings: {
        export: { overwrite: true },
        output: { format: 'keep-original' },
      },
    });

    assert.equal(plan.effectiveSettings.export.overwrite, false);
    assert.ok(plan.warnings.some((warning) => warning.code === 'headless-overwrite-disabled'));
    assert.notEqual(path.resolve(plan.plannedOutputs[0].outputPath), path.resolve(inputPath));
  });
});
