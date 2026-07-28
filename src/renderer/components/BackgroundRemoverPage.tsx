import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BackgroundRemovalJobResult,
  BackgroundRemovalOutputFormat,
  BackgroundRemovalProgressUpdate,
  BackgroundRemovalSettings,
  BackgroundRemoverStatus,
  InputFile,
  InputScanProgress,
  InputScanResult,
  ProcessedFileResult,
} from '../../core/shared/types';
import { api } from '../api';
import { toLocalFileUrl } from '../local-file-url';
import { BackgroundRemovalModelInfoButton } from './BackgroundRemovalModelInfoButton';
import { SliderNumberInput } from './SliderNumberInput';

interface BackgroundRemoverPageProps {
  files: InputFile[];
  thumbnails: Record<string, string>;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  onFilesImported: (result: InputScanResult) => void;
  onRemoveFile: (sourcePath: string) => void;
  onClearFiles: () => void;
  onSwitchToPrep: () => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
  onProcessingChange?: (isProcessing: boolean) => void;
}

type SourceStatus = 'active' | 'pending' | 'done' | 'failed' | 'skipped' | 'cancelled';

const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  active: 'Processing',
  pending: 'Ready',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

const DEFAULT_OUTPUT_FOLDER_NAME = 'background-removed';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDimensions(file: InputFile): string {
  if (!file.width || !file.height) return 'Unknown size';
  return `${file.width}x${file.height}`;
}

function getBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function getParentFolder(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return index >= 0 ? filePath.slice(0, index) : '';
}

function getSiblingOutputFolder(sourcePath: string, folderName: string): string {
  const parentFolder = getParentFolder(sourcePath);
  if (!parentFolder) return '';
  const separator = parentFolder.includes('\\') ? '\\' : '/';
  return `${parentFolder}${separator}${folderName.trim() || DEFAULT_OUTPUT_FOLDER_NAME}`;
}

function createScanId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseOptionalDimension(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed);
}

function resultStatus(result: ProcessedFileResult | undefined): SourceStatus | null {
  if (!result) return null;
  if (result.cancelled) return 'cancelled';
  if (result.skipped) return 'skipped';
  return result.success ? 'done' : 'failed';
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M5 7h14" />
      <path d="M9 7V5h6v2" />
      <path d="M7 7l1 13h8l1-13" />
    </svg>
  );
}

function SourceThumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed) {
    return (
      <span className="source-file-placeholder thumbnail-failed" data-tooltip="Thumbnail unavailable">
        <span>Preview unavailable</span>
      </span>
    );
  }

  return (
    <img src={src} alt="" onError={() => setFailed(true)} />
  );
}

function BackgroundResultCard({
  result,
  source,
  thumbnail,
  onSelect,
}: {
  result: ProcessedFileResult;
  source: InputFile | undefined;
  thumbnail: string | undefined;
  onSelect: () => void;
}) {
  const firstOutput = result.generatedOutputs?.[0];
  const outputSource = firstOutput ? toLocalFileUrl(firstOutput.outputPath) : '';

  return (
    <button
      type="button"
      className={`background-result-card ${result.success ? '' : 'failed'}`}
      onClick={onSelect}
    >
      <span className="background-result-thumb-row">
        <span className="background-before-thumb">
          {source && <SourceThumbnail src={thumbnail || toLocalFileUrl(source.sourcePath)} />}
        </span>
        <span className="background-after-thumb preview-checkerboard">
          {result.success && outputSource ? (
            <img src={outputSource} alt="" />
          ) : (
            <span>{result.cancelled ? 'Cancelled' : 'Failed'}</span>
          )}
        </span>
      </span>
      <span className="background-result-meta">
        <strong>{source ? `${source.fileName}${source.extension}` : getBaseName(result.sourcePath)}</strong>
        <span>
          {result.success
            ? `${result.generatedOutputs?.length || 1} output${(result.generatedOutputs?.length || 1) === 1 ? '' : 's'} · ${formatSize(result.outputSize)}`
            : result.error || 'Background removal failed'}
        </span>
      </span>
    </button>
  );
}

export function BackgroundRemoverPage({
  files,
  thumbnails,
  selectedIndex,
  setSelectedIndex,
  onFilesImported,
  onRemoveFile,
  onClearFiles,
  onSwitchToPrep,
  onError,
  onSuccess,
  onProcessingChange,
}: BackgroundRemoverPageProps) {
  const [status, setStatus] = useState<BackgroundRemoverStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [sourceDragOver, setSourceDragOver] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceScanProgress, setSourceScanProgress] = useState<InputScanProgress | null>(null);
  const [sourceScanNotice, setSourceScanNotice] = useState<string | null>(null);
  const [destination, setDestination] = useState<BackgroundRemovalSettings['destination']>('sibling');
  const [customPath, setCustomPath] = useState('');
  const [outputFolderName, setOutputFolderName] = useState(DEFAULT_OUTPUT_FOLDER_NAME);
  const [outputFormat, setOutputFormat] = useState<BackgroundRemovalOutputFormat>('png');
  const [maxWidth, setMaxWidth] = useState('');
  const [maxHeight, setMaxHeight] = useState('');
  const [webpQuality, setWebpQuality] = useState(92);
  const [overwrite, setOverwrite] = useState(false);
  const [progress, setProgress] = useState<BackgroundRemovalProgressUpdate | null>(null);
  const [result, setResult] = useState<BackgroundRemovalJobResult | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const activeSourceScanIdRef = useRef<string | null>(null);
  const cancelledSourceScanIdsRef = useRef<Set<string>>(new Set());
  const sourceDragCounterRef = useRef(0);

  const selectedFile = files[Math.min(selectedIndex, Math.max(0, files.length - 1))] || null;
  const resultsBySourcePath = useMemo(() => (
    Object.fromEntries((result?.results || []).map((item) => [item.sourcePath, item]))
  ), [result]);
  const activeSourcePaths = useMemo(() => new Set(progress?.activeFiles || []), [progress]);
  const successfulOutputs = useMemo(() => (
    (result?.results || []).flatMap((item) => item.generatedOutputs?.map((output) => output.outputPath) || [])
  ), [result]);
  const showInFolderTarget = useMemo(() => (
    result?.outputFolders[0]
    || successfulOutputs.map(getParentFolder).find(Boolean)
    || (destination === 'custom' ? customPath.trim() : '')
    || (files[0] ? getSiblingOutputFolder(files[0].sourcePath, outputFolderName) : '')
    || ''
  ), [customPath, destination, files, outputFolderName, result, successfulOutputs]);
  const totalSourceSize = files.reduce((total, file) => total + file.fileSize, 0);
  const completedCount = progress?.completedCount || result?.results.length || 0;
  const progressPercent = files.length > 0
    ? Math.round((completedCount / files.length) * 100)
    : 0;
  const needsCustomFolder = destination === 'custom' && customPath.trim().length === 0;
  const canRun = files.length > 0
    && !isProcessing
    && Boolean(status?.available)
    && !needsCustomFolder;

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      setStatus(await api.checkBackgroundRemover());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({
        available: false,
        message: `Could not check background remover: ${message}`,
        details: [],
      });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => api.onScanProgress((scanProgress) => {
    if (scanProgress.scanId !== activeSourceScanIdRef.current) return;
    setSourceScanProgress(scanProgress);
  }), []);

  useEffect(() => api.onBackgroundRemovalProgress((nextProgress) => {
    setProgress(nextProgress);
    if (nextProgress.status === 'stopping') {
      setIsStopping(true);
    }
  }), []);

  useEffect(() => {
    onProcessingChange?.(isProcessing);
  }, [isProcessing, onProcessingChange]);

  const importPaths = useCallback(async (
    paths: string[],
    errorPrefix: string,
    mode: 'scan' | 'drop' = 'scan',
  ) => {
    if (paths.length === 0) return;

    const scanId = createScanId(`background-${mode}`);
    activeSourceScanIdRef.current = scanId;
    cancelledSourceScanIdsRef.current.delete(scanId);
    setSourceScanNotice(null);
    setSourceScanProgress({
      scanId,
      checkedCount: 0,
      acceptedCount: 0,
      skippedCount: 0,
      done: false,
      cancelled: false,
    });
    setSourceLoading(true);

    try {
      const scanResult = mode === 'drop'
        ? await api.dropFiles(paths, scanId)
        : await api.scanInputs(paths, scanId);
      if (scanResult.cancelled || cancelledSourceScanIdsRef.current.has(scanId)) {
        setSourceScanNotice('Import cancelled. No files from that scan were added.');
        return;
      }
      onFilesImported(scanResult);
    } catch (err) {
      if (!cancelledSourceScanIdsRef.current.has(scanId)) {
        const message = err instanceof Error ? err.message : String(err);
        onError(`${errorPrefix}: ${message}`);
      }
    } finally {
      if (activeSourceScanIdRef.current === scanId) {
        activeSourceScanIdRef.current = null;
      }
      cancelledSourceScanIdsRef.current.delete(scanId);
      setSourceLoading(false);
      setSourceScanProgress(null);
    }
  }, [onError, onFilesImported]);

  const cancelSourceScan = useCallback(() => {
    const scanId = activeSourceScanIdRef.current;
    if (!scanId) return;
    cancelledSourceScanIdsRef.current.add(scanId);
    activeSourceScanIdRef.current = null;
    setSourceLoading(false);
    setSourceScanNotice('Import cancelled. No files from that scan were added.');
    void api.cancelScan(scanId);
  }, []);

  const chooseSourceInputs = useCallback(async () => {
    try {
      const paths = await api.chooseSources();
      await importPaths(paths, 'Could not choose sources');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(`Could not choose sources: ${message}`);
    }
  }, [importPaths, onError]);

  const chooseOutputFolder = useCallback(async () => {
    try {
      const folder = await api.chooseFolder();
      if (folder) {
        setCustomPath(folder);
        setDestination('custom');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(`Could not choose output folder: ${message}`);
    }
  }, [onError]);

  const handleSourceDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    sourceDragCounterRef.current = 0;
    setSourceDragOver(false);
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => api.getPathForFile(file))
      .filter(Boolean);
    void importPaths(paths, 'Could not import dropped sources', 'drop');
  }, [importPaths]);

  const handleSourceDragEnter = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    sourceDragCounterRef.current++;
    setSourceDragOver(true);
  }, []);

  const handleSourceDragOver = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setSourceDragOver(true);
  }, []);

  const handleSourceDragLeave = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    sourceDragCounterRef.current--;
    if (sourceDragCounterRef.current <= 0) {
      sourceDragCounterRef.current = 0;
      setSourceDragOver(false);
    }
  }, []);

  const buildSettings = useCallback((): BackgroundRemovalSettings => ({
    destination,
    customPath,
    outputFolderName: outputFolderName.trim() || DEFAULT_OUTPUT_FOLDER_NAME,
    outputFormat,
    maxWidth: parseOptionalDimension(maxWidth),
    maxHeight: parseOptionalDimension(maxHeight),
    webpQuality,
    overwrite,
  }), [
    customPath,
    destination,
    maxHeight,
    maxWidth,
    outputFolderName,
    outputFormat,
    overwrite,
    webpQuality,
  ]);

  const runBackgroundRemoval = useCallback(async () => {
    if (!canRun) {
      if (files.length === 0) {
        onError('Add images before running background removal.');
      } else if (!status?.available) {
        onError(status?.message || 'Background remover is not ready.');
      } else if (needsCustomFolder) {
        onError('Choose a custom output folder before running background removal.');
      }
      return;
    }

    setResult(null);
    setProgress(null);
    setIsProcessing(true);
    setIsStopping(false);

    try {
      const nextResult = await api.runBackgroundRemoval({
        files,
        settings: buildSettings(),
      });
      setResult(nextResult);
      if (nextResult.cancelled) {
        onSuccess('Background removal cancelled.');
      } else if (nextResult.failureCount > 0) {
        onError(`Background removal finished with ${nextResult.failureCount} failed image${nextResult.failureCount === 1 ? '' : 's'}.`);
      } else {
        onSuccess(`Removed backgrounds from ${nextResult.successCount} image${nextResult.successCount === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(`Background removal failed: ${message}`);
      void refreshStatus();
    } finally {
      setIsProcessing(false);
      setIsStopping(false);
    }
  }, [
    buildSettings,
    canRun,
    files,
    needsCustomFolder,
    onError,
    onSuccess,
    refreshStatus,
    status,
  ]);

  const cancelBackgroundRemoval = useCallback(async () => {
    setIsStopping(true);
    try {
      await api.cancelBackgroundRemoval();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(`Could not cancel background removal: ${message}`);
    }
  }, [onError]);

  const openOutputFolder = useCallback(async () => {
    if (!showInFolderTarget) {
      onError('Add an image or choose an output folder first.');
      return;
    }

    const openResult = await api.openFolder(showInFolderTarget);
    if (openResult) {
      onError(`Could not open output folder: ${openResult}`);
    }
  }, [onError, showInFolderTarget]);

  const useOutputsInPrep = useCallback(async () => {
    if (successfulOutputs.length === 0) {
      onError('No successful background-removed outputs to use.');
      return;
    }

    try {
      const scanResult = await api.scanInputs(successfulOutputs);
      onFilesImported(scanResult);
      onSwitchToPrep();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(`Could not use outputs in Image Puma: ${message}`);
    }
  }, [onError, onFilesImported, onSwitchToPrep, successfulOutputs]);

  const sourceRows = files.map((file, index) => {
    const completedStatus = resultStatus(resultsBySourcePath[file.sourcePath]);
    const statusValue = activeSourcePaths.has(file.sourcePath)
      ? 'active'
      : completedStatus || 'pending';
    return { file, index, status: statusValue };
  });

  return (
    <div
      className={`background-remover-workbench ${sourceDragOver ? 'source-drag-over' : ''}`}
      onDrop={handleSourceDrop}
      onDragEnter={handleSourceDragEnter}
      onDragOver={handleSourceDragOver}
      onDragLeave={handleSourceDragLeave}
    >
      <aside className="source-tray">
        <div className="source-tray-header">
          <div>
            <div className="section-label">Background Sources</div>
            <div className="source-tray-title">
              {files.length} image{files.length !== 1 ? 's' : ''}
            </div>
            <div className="text-xs text-secondary">{formatSize(totalSourceSize)} selected</div>
          </div>
          {files.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClearFiles} disabled={isProcessing}>
              Clear
            </button>
          )}
        </div>

        <div className={`source-add-zone source-add-zone-compact ${sourceDragOver ? 'drag-over' : ''}`}>
          {sourceLoading ? (
            <div className="source-scan-status">
              <div className="spinner spinner-sm" />
              <span>Scanning sources...</span>
              {sourceScanProgress && (
                <small>
                  {sourceScanProgress.checkedCount} checked
                  {' · '}
                  {sourceScanProgress.acceptedCount} images
                  {' · '}
                  {sourceScanProgress.skippedCount} skipped
                </small>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={cancelSourceScan}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="source-add-picker"
              onClick={() => void chooseSourceInputs()}
              disabled={isProcessing}
            >
              Click or drop files or folders
            </button>
          )}
          {sourceScanNotice && (
            <div className="source-import-summary">{sourceScanNotice}</div>
          )}
        </div>

        {selectedFile && (
          <div className="selected-source-detail">
            <span>{formatSize(selectedFile.fileSize)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDimensions(selectedFile)}</span>
          </div>
        )}

        <div className="source-list">
          {sourceRows.map(({ file, index, status: rowStatus }) => {
            const isSelectedSource = index === selectedIndex;
            return (
              <div
                key={file.sourcePath}
                className={`source-file-row ${isSelectedSource ? 'active' : ''}`}
              >
                <button
                  type="button"
                  className="source-file-select"
                  onClick={() => setSelectedIndex(index)}
                >
                  <SourceThumbnail src={thumbnails[file.sourcePath] || toLocalFileUrl(file.sourcePath)} />
                  <span className="source-file-meta">
                    <span className="source-file-name">{file.fileName}{file.extension}</span>
                    <span className="source-file-detail">
                      {isSelectedSource ? `${formatSize(file.fileSize)} · ${formatDimensions(file)}` : ''}
                      {rowStatus !== 'pending' && (
                        <>
                          {isSelectedSource ? ' · ' : ''}
                          <span className={`status-text status-${rowStatus}`}>{SOURCE_STATUS_LABELS[rowStatus]}</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="source-remove-button"
                  onClick={() => onRemoveFile(file.sourcePath)}
                  disabled={isProcessing}
                  aria-label={`Remove ${file.fileName}${file.extension}`}
                >
                  <TrashIcon />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      <main className="background-stage">
        {isProcessing && (
          <div className="workflow-banner workflow-banner-info">
            <span>
              {progress?.currentFile || 'Preparing background remover'}
              {' · '}
              {completedCount}/{files.length}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void cancelBackgroundRemoval()}
              disabled={isStopping}
            >
              {isStopping ? 'Stopping...' : 'Cancel'}
            </button>
          </div>
        )}

        {!isProcessing && result && (
          <div className={`workflow-banner ${result.failureCount > 0 ? 'workflow-banner-warning' : 'workflow-banner-info'}`}>
            <span>
              {result.successCount} cutout{result.successCount === 1 ? '' : 's'}
              {result.failureCount > 0 ? ` · ${result.failureCount} failed` : ''}
              {result.cancelledCount > 0 ? ` · ${result.cancelledCount} cancelled` : ''}
              {' · '}
              {formatSize(result.totalOutputBytes)} output
            </span>
            <div className="background-banner-actions">
              {successfulOutputs.length > 0 && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void openOutputFolder()}>
                  Open Output
                </button>
              )}
              {successfulOutputs.length > 0 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void useOutputsInPrep()}>
                  Use in Prep
                </button>
              )}
            </div>
          </div>
        )}

        <div className="background-stage-content">
          {result ? (
            <div className="background-results-grid">
              {result.results.map((item) => (
                <BackgroundResultCard
                  key={item.sourcePath}
                  result={item}
                  source={files.find((file) => file.sourcePath === item.sourcePath)}
                  thumbnail={thumbnails[item.sourcePath]}
                  onSelect={() => {
                    const nextIndex = files.findIndex((file) => file.sourcePath === item.sourcePath);
                    if (nextIndex >= 0) setSelectedIndex(nextIndex);
                  }}
                />
              ))}
            </div>
          ) : selectedFile ? (
            <div className="background-selected-preview">
              <div className="background-preview-frame preview-checkerboard">
                <img
                  src={thumbnails[selectedFile.sourcePath] || toLocalFileUrl(selectedFile.sourcePath)}
                  alt=""
                />
              </div>
              <div className="background-preview-caption">
                <strong>{selectedFile.fileName}{selectedFile.extension}</strong>
                <span>{formatSize(selectedFile.fileSize)} · {formatDimensions(selectedFile)}</span>
              </div>
            </div>
          ) : (
            <div className="background-empty-state">
              <div className="dropzone-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-secondary)' }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </div>
              <div className="dropzone-title">Drop images here</div>
              <div className="dropzone-desc">Transparent cutouts are written as duplicate output files.</div>
              <button type="button" className="btn btn-primary" onClick={() => void chooseSourceInputs()}>
                Select Images
              </button>
            </div>
          )}
        </div>
      </main>

      <aside className="background-inspector">
        <div className="preview-inspector-header">
          <div className="inspector-title-row">
            <div>
              <div className="section-label background-model-section-label">
                <span>Background Removal</span>
                <BackgroundRemovalModelInfoButton />
              </div>
              <div className="background-inspector-title">
                {statusLoading
                  ? 'Checking setup'
                  : status?.available
                    ? 'RMBG-2.0 batch cutouts'
                    : 'Setup needed'}
              </div>
            </div>
          </div>
        </div>

        <div className="background-inspector-content">
          {!statusLoading && status && !status.available && (
            <div className="background-setup-panel">
              <strong>{status.message}</strong>
              <div className="text-xs text-secondary">
                Official desktop builds include the complete offline runtime and model. Rebuild the app if these files are missing.
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshStatus()}>
                Refresh
              </button>
              {status.details.length > 0 && (
                <details>
                  <summary>Setup details</summary>
                  <pre>{status.details.join('\n')}</pre>
                </details>
              )}
            </div>
          )}

          {statusLoading && (
            <div className="background-setup-panel">
              <div className="spinner spinner-sm" />
              <strong>Checking background remover setup</strong>
            </div>
          )}

          <section className="settings-section">
            <div className="section-label">Output</div>
            <div className="inspector-segment background-destination-segment">
              <button
                type="button"
                className={destination === 'sibling' ? 'active' : ''}
                disabled={isProcessing}
                onClick={() => setDestination('sibling')}
              >
                Sibling Folder
              </button>
              <button
                type="button"
                className={destination === 'custom' ? 'active' : ''}
                disabled={isProcessing}
                onClick={() => setDestination('custom')}
              >
                Custom
              </button>
            </div>

            {destination === 'sibling' ? (
              <label className="background-field">
                <span>Folder Name</span>
                <input
                  type="text"
                  value={outputFolderName}
                  disabled={isProcessing}
                  onChange={(event) => setOutputFolderName(event.target.value)}
                />
              </label>
            ) : (
              <div className="background-field">
                <span>Folder</span>
                <button
                  type="button"
                  className={`btn ${customPath ? 'btn-secondary' : 'btn-primary'} btn-sm`}
                  disabled={isProcessing}
                  onClick={() => void chooseOutputFolder()}
                >
                  {customPath ? 'Change Folder' : 'Choose Folder'}
                </button>
                {customPath && <small>{customPath}</small>}
              </div>
            )}

            <div className="background-field">
              <span>Format</span>
              <div className="inspector-segment background-format-segment">
                {(['png', 'webp', 'both'] as BackgroundRemovalOutputFormat[]).map((format) => (
                  <button
                    key={format}
                    type="button"
                    className={outputFormat === format ? 'active' : ''}
                    disabled={isProcessing}
                    onClick={() => setOutputFormat(format)}
                  >
                    {format === 'both' ? 'Both' : format.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {(outputFormat === 'webp' || outputFormat === 'both') && (
              <div className="background-field">
                <span>WebP Quality</span>
                <div className="setting-control">
                  <SliderNumberInput
                    ariaLabel="WebP quality"
                    min={1}
                    max={100}
                    value={webpQuality}
                    disabled={isProcessing}
                    onChange={setWebpQuality}
                  />
                </div>
              </div>
            )}
          </section>

          <section className="settings-section">
            <div className="section-label">Size</div>
            <div className="background-size-grid">
              <label className="background-field">
                <span>Max Width</span>
                <input
                  type="number"
                  min="1"
                  inputMode="numeric"
                  value={maxWidth}
                  disabled={isProcessing}
                  placeholder="Auto"
                  onChange={(event) => setMaxWidth(event.target.value)}
                />
              </label>
              <label className="background-field">
                <span>Max Height</span>
                <input
                  type="number"
                  min="1"
                  inputMode="numeric"
                  value={maxHeight}
                  disabled={isProcessing}
                  placeholder="Auto"
                  onChange={(event) => setMaxHeight(event.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="settings-section">
            <div className="section-label">Write Policy</div>
            <label
              className="setting-row background-toggle-row"
              data-tooltip="Replaces existing background-removed files instead of creating numbered copies."
              data-tooltip-placement="left"
              data-tooltip-width="300"
            >
              <span className="setting-label">Overwrite</span>
              <button
                type="button"
                className={`toggle ${overwrite ? 'on' : ''}`}
                disabled={isProcessing}
                aria-pressed={overwrite}
                onClick={() => setOverwrite((value) => !value)}
              />
              <span className="text-xs text-secondary">
                {overwrite ? 'Existing output files may be replaced.' : 'Duplicate names get numbered.'}
              </span>
            </label>
          </section>

          <div className={`workbench-run-bar inspector-run-bar ${needsCustomFolder ? 'needs-attention' : ''}`}>
            <div className="run-bar-summary">
              <div className="section-label">Cutout Job</div>
              <div className="run-bar-title">
                {files.length} image{files.length !== 1 ? 's' : ''} to {destination === 'custom' ? 'custom folder' : outputFolderName || DEFAULT_OUTPUT_FOLDER_NAME}
              </div>
              <div className="text-xs text-secondary">
                {outputFormat.toUpperCase()}
                {' · '}
                {maxWidth.trim() || maxHeight.trim()
                  ? `Max ${maxWidth.trim() || 'auto'}x${maxHeight.trim() || 'auto'}`
                  : 'Original dimensions'}
              </div>
              {needsCustomFolder && (
                <div className="run-bar-warning">Choose a custom output folder before processing.</div>
              )}
              {!statusLoading && status && !status.available && (
                <div className="run-bar-warning">{status.message}</div>
              )}
              {isProcessing && (
                <>
                  <div className="batch-progress-bar compact background-progress-bar">
                    <div className="batch-progress-fill" style={{ width: `${progressPercent}%` }} />
                  </div>
                  <div className="text-xs text-secondary">{progress?.currentFile || 'Preparing background remover'}</div>
                </>
              )}
            </div>
            <div className="run-bar-actions background-run-actions">
              <button
                type="button"
                className="btn btn-primary btn-run-batch"
                disabled={!canRun}
                onClick={() => void runBackgroundRemoval()}
              >
                {isProcessing ? 'Removing...' : `Remove Backgrounds (${files.length})`}
              </button>
              <button
                type="button"
                className="background-folder-link"
                onClick={() => void openOutputFolder()}
              >
                show in folder
              </button>
              {isProcessing && (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={isStopping}
                  onClick={() => void cancelBackgroundRemoval()}
                >
                  {isStopping ? 'Stopping...' : 'Cancel'}
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
