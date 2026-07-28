import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { AppPreset, InputFile, InputScanProgress, InputScanResult } from '../../core/shared/types';
import { api } from '../api';
import { toLocalFileUrl } from '../local-file-url';
import { ModalDialog } from './ModalDialog';
import { PresetPickerModal } from './PresetPickerModal';

interface DropZoneProps {
  files?: InputFile[];
  thumbnails?: Record<string, string>;
  presets?: AppPreset[];
  activePreset?: AppPreset | null;
  onPresetChange?: (preset: AppPreset) => void;
  onDeletePreset?: (preset: AppPreset) => Promise<void>;
  onFilesImported: (result: InputScanResult) => void;
  onError: (message: string) => void;
  onContinue?: () => void;
  onRemoveFile?: (sourcePath: string) => void;
  onClearFiles?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createScanId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function DropZone({
  files = [],
  thumbnails = {},
  presets = [],
  activePreset = null,
  onPresetChange,
  onDeletePreset,
  onFilesImported,
  onError,
  onContinue,
  onRemoveFile,
  onClearFiles,
}: DropZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<InputScanProgress | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [presetDeleteTarget, setPresetDeleteTarget] = useState<AppPreset | null>(null);
  const [presetDeleteError, setPresetDeleteError] = useState<string | null>(null);
  const dragCounter = useRef(0);
  const activeScanIdRef = useRef<string | null>(null);
  const cancelledScanIdsRef = useRef<Set<string>>(new Set());
  const hasFiles = files.length > 0;
  const totalSize = files.reduce((total, file) => total + file.fileSize, 0);

  useEffect(() => api.onScanProgress((progress) => {
    if (progress.scanId !== activeScanIdRef.current) return;
    setScanProgress(progress);
  }), []);

  const scanPaths = useCallback(async (
    paths: string[],
    mode: 'scan' | 'drop',
    errorPrefix: string,
  ) => {
    if (paths.length === 0) return;

    const scanId = createScanId(mode);
    activeScanIdRef.current = scanId;
    cancelledScanIdsRef.current.delete(scanId);
    setScanNotice(null);
    setScanProgress({
      scanId,
      checkedCount: 0,
      acceptedCount: 0,
      skippedCount: 0,
      done: false,
      cancelled: false,
    });
    setLoading(true);

    try {
      const result = mode === 'drop'
        ? await api.dropFiles(paths, scanId)
        : await api.scanInputs(paths, scanId);
      if (result.cancelled || cancelledScanIdsRef.current.has(scanId)) {
        setScanNotice('Import cancelled. No files from that scan were added.');
        return;
      }
      onFilesImported(result);
    } catch (err) {
      if (!cancelledScanIdsRef.current.has(scanId)) {
        const message = err instanceof Error ? err.message : String(err);
        onError(`${errorPrefix}: ${message}`);
      }
    } finally {
      if (activeScanIdRef.current === scanId) {
        activeScanIdRef.current = null;
      }
      cancelledScanIdsRef.current.delete(scanId);
      setLoading(false);
      setScanProgress(null);
    }
  }, [onError, onFilesImported]);

  const cancelScan = useCallback(() => {
    const scanId = activeScanIdRef.current;
    if (!scanId) return;
    cancelledScanIdsRef.current.add(scanId);
    activeScanIdRef.current = null;
    setLoading(false);
    setScanNotice('Import cancelled. No files from that scan were added.');
    void api.cancelScan(scanId);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const paths: string[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        paths.push(api.getPathForFile(e.dataTransfer.files[i]));
      }

      await scanPaths(paths, 'drop', 'Could not import dropped files');
    },
    [scanPaths],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    setDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleChooseFiles = useCallback(async () => {
    try {
      const paths = await api.chooseFiles();
      await scanPaths(paths, 'scan', 'Could not choose files');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(`Could not choose files: ${message}`);
    }
  }, [onError, scanPaths]);

  const handleChooseFolder = useCallback(async () => {
    try {
      const folder = await api.chooseFolder();
      if (folder) {
        await scanPaths([folder], 'scan', 'Could not choose folder');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(`Could not choose folder: ${message}`);
    }
  }, [onError, scanPaths]);

  const selectPreset = useCallback((preset: AppPreset) => {
    onPresetChange?.(preset);
    setPresetMenuOpen(false);
  }, [onPresetChange]);

  const requestPresetDelete = useCallback((preset: AppPreset) => {
    if (!onDeletePreset || !preset.id.startsWith('user-')) return;
    setPresetDeleteTarget(preset);
    setPresetDeleteError(null);
    setPresetMenuOpen(false);
  }, [onDeletePreset]);

  const confirmPresetDelete = useCallback(async () => {
    if (!presetDeleteTarget || !onDeletePreset) return;

    try {
      await onDeletePreset(presetDeleteTarget);
      setPresetDeleteTarget(null);
      setPresetDeleteError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPresetDeleteError(`Could not delete preset: ${message}`);
    }
  }, [onDeletePreset, presetDeleteTarget]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (event.shiftKey) {
          void handleChooseFolder();
        } else {
          void handleChooseFiles();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleChooseFiles, handleChooseFolder]);

  return (
    <div
      className={`dropzone-page ${dragOver ? 'drag-over' : ''} ${hasFiles ? 'has-imported-files' : ''}`}
      onDrop={handleDrop}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {hasFiles && (
        <section className="import-review-panel">
          <div className="import-review-header">
            <div>
              <div className="section-label">Current Batch</div>
              <div className="import-review-title">
                {files.length} image{files.length !== 1 ? 's' : ''}
              </div>
              <div className="text-xs text-secondary">{formatSize(totalSize)} selected for processing</div>
            </div>
            <div className="import-review-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClearFiles}>
                Clear
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={onContinue}>
                Recipe
              </button>
            </div>
          </div>

          <div className="import-file-list">
            {files.map((file) => (
              <div className="import-file-row" key={file.sourcePath}>
                <img
                  src={thumbnails[file.sourcePath] || toLocalFileUrl(file.sourcePath)}
                  alt=""
                  className="import-file-thumb"
                />
                <div className="import-file-meta">
                  <div className="import-file-name">{file.fileName}{file.extension}</div>
                  <div className="text-xs text-tertiary">{file.relativePath || file.sourcePath}</div>
                </div>
                <div className="import-file-size">{formatSize(file.fileSize)}</div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onRemoveFile?.(file.sourcePath)}
                  aria-label={`Remove ${file.fileName}${file.extension}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className={`dropzone ${dragOver ? 'drag-over' : ''} ${hasFiles ? 'compact' : ''}`}>
        {loading ? (
          <div className="scan-status">
            <div className="spinner" />
            <div className="text-secondary">Scanning files...</div>
            {scanProgress && (
              <div className="scan-status-meta">
                {scanProgress.checkedCount} checked
                {' · '}
                {scanProgress.acceptedCount} images
                {' · '}
                {scanProgress.skippedCount} skipped
              </div>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelScan}>
              Cancel Import
            </button>
          </div>
        ) : (
          <>
            <div className="dropzone-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{color: 'var(--color-text-secondary)'}}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </div>
            {activePreset && (
              <div className="dropzone-recipe">
                <span>Current recipe</span>
                {presets.length > 0 && onPresetChange ? (
                  <div className="preset-menu dropzone-preset-menu">
                    <button
                      type="button"
                      className="preset-menu-trigger dropzone-preset-trigger"
                      aria-haspopup="listbox"
                      aria-expanded={presetMenuOpen}
                      aria-label="Current recipe"
                      onClick={() => setPresetMenuOpen((open) => !open)}
                    >
                      <span>{activePreset.name}</span>
                      <span className="preset-menu-caret" aria-hidden="true" />
                    </button>
                    <PresetPickerModal
                      open={presetMenuOpen}
                      presets={presets}
                      activePresetId={activePreset.id}
                      onSelect={selectPreset}
                      onDelete={onDeletePreset ? requestPresetDelete : undefined}
                      onClose={() => setPresetMenuOpen(false)}
                    />
                  </div>
                ) : (
                  <strong>{activePreset.name}</strong>
                )}
                <small>{activePreset.description}</small>
              </div>
            )}
            <div className="dropzone-title">{hasFiles ? 'Add more images' : 'Drop images here'}</div>
            <div className="dropzone-desc">
              Drag and drop images or folders onto this area.
              Supports JPEG, PNG, WebP, AVIF, TIFF, and HEIC.
            </div>
            <div className="dropzone-divider"><span>or</span></div>
            <div className="dropzone-actions">
              <button className="btn btn-primary" onClick={handleChooseFolder}>
                Open Folder
              </button>
              <button className="btn btn-secondary" onClick={handleChooseFiles}>
                Select Files
              </button>
            </div>
            <div className="dropzone-hint">
              <span className="kbd">⌘O</span> files
              {' '}
              <span className="kbd">⇧⌘O</span> folder
            </div>

            {scanNotice && (
              <div className="scan-notice text-sm text-secondary">{scanNotice}</div>
            )}
          </>
        )}
      </div>
      <ModalDialog
        open={Boolean(presetDeleteTarget)}
        title="Delete preset?"
        description={presetDeleteTarget
          ? `Delete "${presetDeleteTarget.name}"? This cannot be undone.`
          : undefined}
        error={presetDeleteError}
        confirmLabel="Delete Preset"
        confirmVariant="danger"
        autoFocusConfirm
        onConfirm={confirmPresetDelete}
        onCancel={() => {
          setPresetDeleteTarget(null);
          setPresetDeleteError(null);
        }}
      />
    </div>
  );
}
