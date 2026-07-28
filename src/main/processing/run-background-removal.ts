import { app, BrowserWindow } from 'electron';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  BackgroundRemovalJobRequest,
  BackgroundRemovalJobResult,
  BackgroundRemovalProgressUpdate,
  BackgroundRemoverStatus,
  InputFile,
  ProcessedFileResult,
} from '../../core/shared/types';
import { Channels } from '../../shared/channels';

interface ActiveBackgroundRemovalJob {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
}

interface PythonRunnerEvent {
  type: string;
  message?: string;
  sourcePath?: string;
  displayName?: string;
  index?: number;
  total?: number;
  result?: ProcessedFileResult;
  results?: ProcessedFileResult[];
}

interface BackgroundRemoverLaunch {
  commandPath: string;
  args: string[];
  cwd: string;
  modelPath: string;
  mode: 'bundled' | 'development';
  pythonPath?: string;
}

interface BackgroundRemoverInspection {
  launch: BackgroundRemoverLaunch | null;
  status: BackgroundRemoverStatus;
}

const HF_CREDENTIAL_ENV_KEYS = [
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'HUGGINGFACEHUB_API_TOKEN',
] as const;

let activeJob: ActiveBackgroundRemovalJob | null = null;

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function directoryExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function getBundledRuntimePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'background-removal-runtime')
    : path.join(process.cwd(), 'build', 'background-removal-runtime');
}

function getBundledExecutablePath(runtimePath: string): string {
  return path.join(
    runtimePath,
    process.platform === 'win32' ? 'background_remove_batch.exe' : 'background_remove_batch',
  );
}

function isCompleteModelDirectory(modelPath: string): boolean {
  return directoryExists(modelPath)
    && fileExists(path.join(modelPath, 'config.json'))
    && fileExists(path.join(modelPath, 'model.safetensors'))
    && fileExists(path.join(modelPath, 'birefnet.py'))
    && fileExists(path.join(modelPath, 'BiRefNet_config.py'));
}

function getDevelopmentRunnerPath(): string {
  return path.join(process.cwd(), 'src', 'main', 'background-removal', 'background_remove_batch.py');
}

function getDevelopmentModelCandidates(): string[] {
  return [
    process.env.IMAGE_PUMA_BACKGROUND_MODEL_DIR || '',
    path.join(process.cwd(), 'build', 'background-removal-model'),
  ].filter(Boolean);
}

function parsePythonVersion(raw: string): { major: number; minor: number; patch: number } | null {
  const match = raw.trim().match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
  };
}

function isSupportedPythonVersion(raw: string): boolean {
  const version = parsePythonVersion(raw);
  if (!version) return false;
  if (version.major > 3) return true;
  return version.major === 3 && version.minor >= 10;
}

function pythonCandidates(): string[] {
  return [
    process.env.BACKGROUND_REMOVER_PYTHON || '',
    path.join(process.cwd(), '.background-removal-build', 'venv', 'bin', 'python'),
    path.join(process.cwd(), '.background-removal-build', 'venv', 'Scripts', 'python.exe'),
    'python3.12',
    'python3.11',
    'python3.10',
    'python3',
  ].filter(Boolean);
}

function checkPythonDependencies(pythonPath: string): { ok: boolean; detail: string } {
  const requiredModules = [
    'numpy',
    'torch',
    'torchvision',
    'PIL',
    'kornia',
    'timm',
    'transformers',
  ];
  const check = spawnSync(
    pythonPath,
    [
      '-c',
      [
        'import importlib.util',
        `mods=${JSON.stringify(requiredModules)}`,
        'missing=[m for m in mods if importlib.util.find_spec(m) is None]',
        'print(",".join(missing))',
        'raise SystemExit(1 if missing else 0)',
      ].join('; '),
    ],
    {
      encoding: 'utf-8',
      timeout: 5000,
    },
  );

  if (check.error) {
    return {
      ok: false,
      detail: `${pythonPath}: dependency check failed (${check.error.message})`,
    };
  }

  const missing = check.stdout.trim();
  if (check.status !== 0 || missing.length > 0) {
    return {
      ok: false,
      detail: `${pythonPath}: missing ${missing || 'background remover dependencies'}`,
    };
  }

  return {
    ok: true,
    detail: `${pythonPath}: background remover dependencies found`,
  };
}

function resolvePython(): { pythonPath: string | null; details: string[] } {
  const details: string[] = [];

  for (const candidate of pythonCandidates()) {
    const check = spawnSync(
      candidate,
      ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'],
      {
        encoding: 'utf-8',
        timeout: 3000,
      },
    );

    if (check.error || check.status !== 0) {
      details.push(`${candidate}: unavailable`);
      continue;
    }

    const version = check.stdout.trim();
    if (!isSupportedPythonVersion(version)) {
      details.push(`${candidate}: Python ${version}, needs 3.10+`);
      continue;
    }

    details.push(`${candidate}: Python ${version}`);
    const dependencyCheck = checkPythonDependencies(candidate);
    details.push(dependencyCheck.detail);
    if (!dependencyCheck.ok) {
      continue;
    }
    return { pythonPath: candidate, details };
  }

  return { pythonPath: null, details };
}

function inspectBackgroundRemover(): BackgroundRemoverInspection {
  const runtimePath = getBundledRuntimePath();
  const bundledExecutablePath = getBundledExecutablePath(runtimePath);
  const bundledModelPath = path.join(runtimePath, 'model');
  const details: string[] = [
    `Runtime: ${runtimePath}`,
    `Executable: ${bundledExecutablePath}`,
    `Model: ${bundledModelPath}`,
  ];

  if (fileExists(bundledExecutablePath) && isCompleteModelDirectory(bundledModelPath)) {
    const launch: BackgroundRemoverLaunch = {
      commandPath: bundledExecutablePath,
      args: [],
      cwd: runtimePath,
      modelPath: bundledModelPath,
      mode: 'bundled',
    };
    return {
      launch,
      status: {
        available: true,
        runtimePath,
        modelPath: bundledModelPath,
        runnerPath: bundledExecutablePath,
        message: 'Bundled background remover is ready to run offline.',
        details,
      },
    };
  }

  if (app.isPackaged) {
    if (!fileExists(bundledExecutablePath)) {
      details.push('Bundled executable is missing.');
    }
    if (!isCompleteModelDirectory(bundledModelPath)) {
      details.push('Bundled RMBG-2.0 model files are missing or incomplete.');
    }
    return {
      launch: null,
      status: {
        available: false,
        runtimePath,
        modelPath: bundledModelPath,
        runnerPath: bundledExecutablePath,
        message: 'This app build is incomplete: the bundled background remover runtime is missing.',
        details,
      },
    };
  }

  const runnerPath = getDevelopmentRunnerPath();
  details.push(`Development runner: ${runnerPath}`);
  if (!fileExists(runnerPath)) {
    return {
      launch: null,
      status: {
        available: false,
        runtimePath,
        runnerPath,
        message: 'Background removal development runner was not found.',
        details,
      },
    };
  }

  const modelPath = getDevelopmentModelCandidates().find(isCompleteModelDirectory) || null;
  details.push(`Development model candidates: ${getDevelopmentModelCandidates().join(', ') || '(none)'}`);
  if (!modelPath) {
    return {
      launch: null,
      status: {
        available: false,
        runtimePath,
        runnerPath,
        message: 'Build the bundled background remover before using this tab.',
        details,
      },
    };
  }

  const python = resolvePython();
  details.push(...python.details);

  if (!python.pythonPath) {
    return {
      launch: null,
      status: {
        available: false,
        runtimePath,
        modelPath,
        runnerPath,
        message: 'Build the bundled background remover, or provide its Python build environment for development.',
        details,
      },
    };
  }

  const launch: BackgroundRemoverLaunch = {
    commandPath: python.pythonPath,
    args: [runnerPath],
    cwd: path.dirname(runnerPath),
    modelPath,
    mode: 'development',
    pythonPath: python.pythonPath,
  };
  return {
    launch,
    status: {
      available: true,
      runtimePath,
      modelPath,
      repoPath: launch.cwd,
      pythonPath: python.pythonPath,
      runnerPath,
      message: 'Background remover development runtime is ready.',
      details,
    },
  };
}

export function getBackgroundRemoverStatus(): BackgroundRemoverStatus {
  return inspectBackgroundRemover().status;
}

export function cancelBackgroundRemoval(): void {
  if (!activeJob) return;
  activeJob.cancelled = true;
  activeJob.child.kill('SIGTERM');
}

function emitProgress(window: BrowserWindow | null, progress: BackgroundRemovalProgressUpdate): void {
  if (!window || window.isDestroyed()) return;

  const progressFraction = progress.totalCount > 0
    ? progress.completedCount / progress.totalCount
    : -1;
  window.setProgressBar(
    progress.status === 'completed' || progress.status === 'cancelled' ? -1 : progressFraction,
  );
  if (progress.status === 'starting') {
    window.setTitle('Image Puma - Loading background remover');
  } else if (progress.status === 'running') {
    window.setTitle(`Image Puma - Removing backgrounds ${progress.completedCount}/${progress.totalCount}`);
  } else if (progress.status === 'stopping') {
    window.setTitle(`Image Puma - Stopping background removal ${progress.completedCount}/${progress.totalCount}`);
  }
  window.webContents.send(Channels.BACKGROUND_REMOVAL_PROGRESS, progress);
}

function createCancelledResult(file: InputFile): ProcessedFileResult {
  const now = new Date().toISOString();
  return {
    sourcePath: file.sourcePath,
    outputPath: '',
    originalSize: file.fileSize,
    outputSize: 0,
    success: false,
    skipped: true,
    cancelled: true,
    error: 'Cancelled',
    startedAt: now,
    completedAt: now,
  };
}

function summarizeResults(results: ProcessedFileResult[], cancelled: boolean): BackgroundRemovalJobResult {
  let totalOriginalBytes = 0;
  let totalOutputBytes = 0;
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let cancelledCount = 0;
  const outputFolders = new Set<string>();

  for (const result of results) {
    totalOriginalBytes += result.originalSize;
    totalOutputBytes += result.outputSize;
    if (result.success) {
      successCount++;
    } else if (result.skipped) {
      skippedCount++;
      if (result.cancelled) cancelledCount++;
    } else {
      failureCount++;
    }

    for (const output of result.generatedOutputs || []) {
      outputFolders.add(path.dirname(output.outputPath));
    }
  }

  return {
    results,
    totalOriginalBytes,
    totalOutputBytes,
    successCount,
    failureCount,
    skippedCount,
    cancelledCount,
    outputFolders: Array.from(outputFolders),
    cancelled,
  };
}

function appendMissingCancelledResults(
  files: InputFile[],
  results: ProcessedFileResult[],
): ProcessedFileResult[] {
  const completedSources = new Set(results.map((result) => result.sourcePath));
  return [
    ...results,
    ...files
      .filter((file) => !completedSources.has(file.sourcePath))
      .map(createCancelledResult),
  ];
}

function parseJsonLine(line: string): PythonRunnerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as PythonRunnerEvent;
  } catch {
    return {
      type: 'log',
      message: trimmed,
    };
  }
}

export async function runBackgroundRemoval(
  request: BackgroundRemovalJobRequest,
  window: BrowserWindow | null,
): Promise<BackgroundRemovalJobResult> {
  if (activeJob) {
    throw new Error('A background removal job is already running.');
  }
  if (request.files.length === 0) {
    throw new Error('Add images before running background removal.');
  }
  if (
    request.settings.destination === 'custom'
    && request.settings.customPath.trim().length === 0
  ) {
    throw new Error('Choose a custom output folder before running background removal.');
  }

  const inspection = inspectBackgroundRemover();
  if (!inspection.launch) {
    throw new Error(inspection.status.message);
  }

  const launch = inspection.launch;
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HF_HUB_OFFLINE: '1',
    IMAGE_PUMA_BACKGROUND_MODEL_DIR: launch.modelPath,
    PYTORCH_ENABLE_MPS_FALLBACK: '1',
    PYTHONUNBUFFERED: '1',
    TRANSFORMERS_OFFLINE: '1',
  };
  for (const key of HF_CREDENTIAL_ENV_KEYS) {
    delete childEnvironment[key];
  }

  const child = spawn(launch.commandPath, launch.args, {
    cwd: launch.cwd,
    env: childEnvironment,
  });

  activeJob = {
    child,
    cancelled: false,
  };

  const results: ProcessedFileResult[] = [];
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let fatalMessage = '';

  emitProgress(window, {
    completedCount: 0,
    totalCount: request.files.length,
    currentFile: 'Loading RMBG-2.0 model',
    status: 'starting',
  });

  child.stdin.end(JSON.stringify(request));

  return new Promise<BackgroundRemovalJobResult>((resolve, reject) => {
    const handleEvent = (event: PythonRunnerEvent) => {
      if (event.type === 'fatal-error') {
        fatalMessage = event.message || 'Background removal failed.';
        return;
      }

      if (event.type === 'model-loading' || event.type === 'ready') {
        emitProgress(window, {
          completedCount: results.length,
          totalCount: request.files.length,
          currentFile: event.message || 'Preparing background remover',
          status: activeJob?.cancelled ? 'stopping' : 'starting',
        });
        return;
      }

      if (event.type === 'file-started') {
        emitProgress(window, {
          completedCount: results.length,
          totalCount: request.files.length,
          currentFile: event.displayName || event.sourcePath || 'Processing image',
          startedCount: typeof event.index === 'number' ? event.index + 1 : undefined,
          activeFiles: event.sourcePath ? [event.sourcePath] : undefined,
          status: activeJob?.cancelled ? 'stopping' : 'running',
        });
        return;
      }

      if (event.type === 'file-completed' && event.result) {
        results.push(event.result);
        emitProgress(window, {
          completedCount: results.length,
          totalCount: request.files.length,
          currentFile: event.displayName || event.sourcePath || 'Processed image',
          result: event.result,
          status: activeJob?.cancelled ? 'stopping' : 'running',
        });
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const event = parseJsonLine(line);
        if (event) handleEvent(event);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf-8');
      if (stderrBuffer.length > 6000) {
        stderrBuffer = stderrBuffer.slice(-6000);
      }
    });

    child.on('error', (error) => {
      activeJob = null;
      if (window && !window.isDestroyed()) {
        window.setProgressBar(-1);
        window.setTitle('Image Puma');
      }
      reject(error);
    });

    child.on('close', (code, signal) => {
      const wasCancelled = Boolean(activeJob?.cancelled || signal);
      activeJob = null;

      const remainingLine = parseJsonLine(stdoutBuffer);
      if (remainingLine) handleEvent(remainingLine);

      if (window && !window.isDestroyed()) {
        window.setProgressBar(-1);
        window.setTitle('Image Puma');
      }

      if (wasCancelled) {
        const cancelledResults = appendMissingCancelledResults(request.files, results);
        const summary = summarizeResults(cancelledResults, true);
        emitProgress(window, {
          completedCount: summary.results.length,
          totalCount: request.files.length,
          currentFile: 'Background removal cancelled',
          status: 'cancelled',
        });
        resolve(summary);
        return;
      }

      if (code !== 0) {
        const message = fatalMessage
          || stderrBuffer.trim()
          || `Background remover exited with code ${code}.`;
        reject(new Error(message));
        return;
      }

      const summary = summarizeResults(results, false);
      emitProgress(window, {
        completedCount: summary.results.length,
        totalCount: request.files.length,
        currentFile: 'Background removal complete',
        status: 'completed',
      });
      resolve(summary);
    });
  });
}
