import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { FaviconBundleResult, InputFile } from '../../core/shared/types';
import { api } from '../api';
import { toLocalFileUrl } from '../local-file-url';

type FaviconDestination = 'sibling' | 'custom';

interface FaviconCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type CropHandle = 'move' | 'nw' | 'ne' | 'se' | 'sw';

const DEFAULT_CROP_RECT: FaviconCropRect = { x: 0, y: 0, width: 100, height: 100 };
const MIN_CROP_SIZE = 10;
const DESTINATION_OPTIONS: Array<{ value: FaviconDestination; label: string }> = [
  { value: 'sibling', label: 'Sibling folder' },
  { value: 'custom', label: 'Select folder' },
];

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function parentPath(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return separatorIndex > 0 ? filePath.slice(0, separatorIndex) : '';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function defaultSquareCrop(source: Pick<InputFile, 'width' | 'height'>): FaviconCropRect {
  const sourceWidth = source.width || 1;
  const sourceHeight = source.height || 1;
  const aspectRatio = sourceWidth / sourceHeight;
  if (aspectRatio >= 1) {
    const width = (100 / aspectRatio);
    return { x: (100 - width) / 2, y: 0, width, height: 100 };
  }
  const height = 100 * aspectRatio;
  return { x: 0, y: (100 - height) / 2, width: 100, height };
}

interface QuickFaviconPageProps {
  onError: (message: string) => void;
}

export function QuickFaviconPage({ onError }: QuickFaviconPageProps) {
  const [source, setSource] = useState<InputFile | null>(null);
  const [destination, setDestination] = useState<FaviconDestination>('sibling');
  const [destinationMenuOpen, setDestinationMenuOpen] = useState(false);
  const [folderName, setFolderName] = useState('favicon-package');
  const [outputDirectory, setOutputDirectory] = useState('');
  const [crop, setCrop] = useState<FaviconCropRect>(DEFAULT_CROP_RECT);
  const [isPageDragOver, setIsPageDragOver] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<FaviconBundleResult | null>(null);
  const dragCounterRef = useRef(0);
  const destinationMenuRef = useRef<HTMLDivElement | null>(null);
  const cropInteractionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    crop: FaviconCropRect;
    canvas: DOMRect;
    handle: CropHandle;
    captureTarget: HTMLElement;
  } | null>(null);

  const selectPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const scan = await api.scanInputs(paths);
      const first = scan.files[0];
      if (!first) {
        throw new Error(scan.skipped[0]?.message || 'No supported image was found.');
      }
      setSource(first);
      setCrop(defaultSquareCrop(first));
      setResult(null);
    } catch (error) {
      onError(`Could not use that image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [onError]);

  const chooseSource = useCallback(async () => {
    try {
      await selectPaths(await api.chooseFiles());
    } catch (error) {
      onError(`Could not choose an image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [onError, selectPaths]);

  const chooseOutputDirectory = useCallback(async () => {
    try {
      const folder = await api.chooseFolder();
      if (folder) {
        setOutputDirectory(folder);
        setDestination('custom');
        setResult(null);
      }
    } catch (error) {
      onError(`Could not choose an output folder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [onError]);

  const selectDestination = useCallback(async (nextDestination: FaviconDestination) => {
    setDestinationMenuOpen(false);
    if (nextDestination === 'custom') {
      await chooseOutputDirectory();
      return;
    }
    setDestination('sibling');
    setResult(null);
  }, [chooseOutputDirectory]);

  const generate = useCallback(async () => {
    const destinationDirectory = destination === 'sibling'
      ? parentPath(source?.sourcePath || '')
      : outputDirectory;
    if (!source || !destinationDirectory || generating) return;
    setGenerating(true);
    setResult(null);
    try {
      const generated = await api.generateFaviconBundle({
        sourcePath: source.sourcePath,
        outputDirectory: destinationDirectory,
        folderName,
        crop,
      });
      setResult(generated);
      try {
        await api.openFolder(generated.outputDirectory);
      } catch (error) {
        onError(`Icon bundle created, but could not open its folder: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      onError(`Could not generate the icon bundle: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setGenerating(false);
    }
  }, [crop, destination, folderName, generating, onError, outputDirectory, source]);

  const beginCropInteraction = useCallback((event: React.PointerEvent<HTMLElement>, handle: CropHandle) => {
    const canvas = event.currentTarget.closest<HTMLElement>('.favicon-crop-canvas');
    if (!canvas) return;
    cropInteractionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      crop,
      canvas: canvas.getBoundingClientRect(),
      handle,
      captureTarget: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [crop]);

  const startCropMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    beginCropInteraction(event, 'move');
  }, [beginCropInteraction]);

  const startCropResize = useCallback((event: React.PointerEvent<HTMLButtonElement>, handle: CropHandle) => {
    event.stopPropagation();
    beginCropInteraction(event, handle);
  }, [beginCropInteraction]);

  const moveCrop = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = cropInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const sourceAspectRatio = (source?.width || 1) / (source?.height || 1);
    const deltaX = ((event.clientX - interaction.startX) / interaction.canvas.width) * 100;
    const deltaY = ((event.clientY - interaction.startY) / interaction.canvas.height) * 100;
    const original = interaction.crop;
    const originalRight = original.x + original.width;
    const originalBottom = original.y + original.height;

    if (interaction.handle === 'move') {
      setCrop({
        ...original,
        x: clamp(original.x + deltaX, 0, 100 - original.width),
        y: clamp(original.y + deltaY, 0, 100 - original.height),
      });
      return;
    }

    let right = originalRight;
    let bottom = originalBottom;
    const deltaXAsHeight = deltaX * sourceAspectRatio;
    let size = original.height;
    let maxSize = 100;
    if (interaction.handle === 'nw') {
      size -= (deltaXAsHeight + deltaY) / 2;
      maxSize = Math.min(originalRight * sourceAspectRatio, originalBottom);
    } else if (interaction.handle === 'ne') {
      size += (deltaXAsHeight - deltaY) / 2;
      maxSize = Math.min((100 - original.x) * sourceAspectRatio, originalBottom);
    } else if (interaction.handle === 'se') {
      size += (deltaXAsHeight + deltaY) / 2;
      maxSize = Math.min((100 - original.x) * sourceAspectRatio, 100 - original.y);
    } else if (interaction.handle === 'sw') {
      size += (-deltaXAsHeight + deltaY) / 2;
      maxSize = Math.min(originalRight * sourceAspectRatio, 100 - original.y);
    }
    const minimumSquareSize = Math.min(MIN_CROP_SIZE, 100, 100 * sourceAspectRatio);
    size = clamp(size, minimumSquareSize, maxSize);
    const cropWidth = size / sourceAspectRatio;
    if (interaction.handle === 'nw') {
      right = originalRight;
      bottom = originalBottom;
      setCrop({ x: right - cropWidth, y: bottom - size, width: cropWidth, height: size });
    } else if (interaction.handle === 'ne') {
      bottom = originalBottom;
      setCrop({ x: original.x, y: bottom - size, width: cropWidth, height: size });
    } else if (interaction.handle === 'se') {
      setCrop({ x: original.x, y: original.y, width: cropWidth, height: size });
    } else {
      right = originalRight;
      setCrop({ x: right - cropWidth, y: original.y, width: cropWidth, height: size });
    }
  }, [source?.height, source?.width]);

  const endCropInteraction = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = cropInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    if (interaction.captureTarget.hasPointerCapture(event.pointerId)) {
      interaction.captureTarget.releasePointerCapture(event.pointerId);
    }
    cropInteractionRef.current = null;
  }, []);

  useEffect(() => {
    const hasDraggedFiles = (event: DragEvent): boolean => (
      Array.from(event.dataTransfer?.types || []).includes('Files')
    );
    const resetDragState = () => {
      dragCounterRef.current = 0;
      setIsPageDragOver(false);
    };
    const handleDragEnter = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current++;
      setIsPageDragOver(true);
    };
    const handleDragOver = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setIsPageDragOver(true);
    };
    const handleDragLeave = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current--;
      const leftWindow = (
        event.clientX <= 0
        || event.clientY <= 0
        || event.clientX >= window.innerWidth
        || event.clientY >= window.innerHeight
      );
      if (dragCounterRef.current <= 0 || leftWindow) resetDragState();
    };
    const handleDrop = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      resetDragState();
      const paths = Array.from(event.dataTransfer?.files || [])
        .map((file) => api.getPathForFile(file))
        .filter(Boolean);
      void selectPaths(paths);
    };

    window.addEventListener('dragenter', handleDragEnter, true);
    window.addEventListener('dragover', handleDragOver, true);
    window.addEventListener('dragleave', handleDragLeave, true);
    window.addEventListener('drop', handleDrop, true);
    window.addEventListener('blur', resetDragState);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter, true);
      window.removeEventListener('dragover', handleDragOver, true);
      window.removeEventListener('dragleave', handleDragLeave, true);
      window.removeEventListener('drop', handleDrop, true);
      window.removeEventListener('blur', resetDragState);
    };
  }, [selectPaths]);

  useEffect(() => {
    if (!destinationMenuOpen) return undefined;

    const closeMenu = (event: PointerEvent) => {
      if (!destinationMenuRef.current?.contains(event.target as Node)) {
        setDestinationMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDestinationMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [destinationMenuOpen]);

  const canCrop = Boolean(source?.width && source.height);
  const needsCustomDirectory = destination === 'custom' && !outputDirectory;
  const selectedDestination = DESTINATION_OPTIONS.find((option) => option.value === destination)!;
  const cropCanvasWidth = canCrop
    ? Math.min(420, (300 * (source?.width || 1)) / (source?.height || 1))
    : 0;

  return (
    <main className="favicon-page">
      {isPageDragOver && (
        <div className="app-drop-overlay" aria-hidden="true">
          <div className="app-drop-overlay-box">Drop image to use it as your favicon source</div>
        </div>
      )}

      <header className="favicon-hero">
        <h1>Quick Favicon</h1>
        <p>Generate a complete favicon and app icon package from one image.</p>
      </header>

      <div className="favicon-workspace">
        <section className="favicon-source-card">
          <div
            className={`favicon-drop-zone${isPageDragOver ? ' drag-over' : ''}${source ? ' has-source' : ''}`}
            role={source ? undefined : 'button'}
            tabIndex={source ? undefined : 0}
            onClick={source ? undefined : () => void chooseSource()}
            onKeyDown={source ? undefined : (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void chooseSource();
              }
            }}
          >
            {source ? (
              <>
                {canCrop ? (
                  <div
                    className="favicon-crop-canvas checkerboard"
                    style={{
                      width: `${cropCanvasWidth}px`,
                      aspectRatio: `${source.width} / ${source.height}`,
                    }}
                    onPointerMove={moveCrop}
                    onPointerUp={endCropInteraction}
                    onPointerCancel={endCropInteraction}
                  >
                    <img src={toLocalFileUrl(source.sourcePath)} alt="Crop the selected icon source" />
                    <div
                      className="favicon-crop-box"
                      style={{
                        left: `${crop.x}%`,
                        top: `${crop.y}%`,
                        width: `${crop.width}%`,
                        height: `${crop.height}%`,
                      }}
                      onPointerDown={startCropMove}
                    >
                      {(['nw', 'ne', 'se', 'sw'] as const).map((handle) => (
                        <button
                          key={handle}
                          type="button"
                          className={`favicon-crop-handle favicon-crop-handle-${handle}`}
                          aria-label={`Resize crop from the ${handle} corner`}
                          onPointerDown={(event) => startCropResize(event, handle)}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="favicon-preview checkerboard">
                    <img src={toLocalFileUrl(source.sourcePath)} alt="Selected icon source" />
                  </div>
                )}
                <div className="favicon-source-meta">
                  <strong>{baseName(source.sourcePath)}</strong>
                  <span>{source.width || '?'} × {source.height || '?'} px</span>
                </div>
                {canCrop && (
                  <div className="favicon-crop-actions">
                    <span>Drag the square crop area or its corners to adjust it.</span>
                    <button type="button" className="btn btn-secondary" onClick={() => setCrop(defaultSquareCrop(source || {}))}>
                      Reset crop
                    </button>
                  </div>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => void chooseSource()}>
                  Replace image
                </button>
              </>
            ) : (
              <>
                <div>
                  <strong>Drop a logo or app icon here</strong>
                  <span>Use a simple square image, ideally 1024 × 1024 or larger.</span>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={(event) => {
                    event.stopPropagation();
                    void chooseSource();
                  }}
                >
                  Choose image
                </button>
              </>
            )}
          </div>
        </section>

        <aside className="favicon-settings-card">
          <div className="favicon-card-heading">
            <span>Export destination</span>
          </div>

          <div className="favicon-field">
            <span>Destination</span>
            <div
              ref={destinationMenuRef}
              className={`favicon-destination-menu${destinationMenuOpen ? ' is-open' : ''}`}
            >
              <button
                type="button"
                className="favicon-destination-trigger"
                aria-haspopup="listbox"
                aria-expanded={destinationMenuOpen}
                onClick={() => setDestinationMenuOpen((open) => !open)}
              >
                <span>{selectedDestination.label}</span>
                <span className="favicon-destination-caret" aria-hidden="true" />
              </button>
              {destinationMenuOpen && (
                <div className="favicon-destination-options" role="listbox" aria-label="Export destination">
                  {DESTINATION_OPTIONS.map((option) => {
                    const active = option.value === destination;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`favicon-destination-option${active ? ' active' : ''}`}
                        onClick={() => void selectDestination(option.value)}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {destination === 'custom' && (
            <div className="favicon-field">
              <span>Selected folder</span>
              <button type="button" className="favicon-path-picker" onClick={() => void chooseOutputDirectory()}>
                <span>{outputDirectory || 'Choose a folder'}</span>
                <strong>Browse</strong>
              </button>
            </div>
          )}

          <label className="favicon-field">
            <span>Folder name</span>
            <input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="favicon-package" />
          </label>

          <button
            type="button"
            className="btn btn-primary btn-lg favicon-generate-button"
            disabled={!source || needsCustomDirectory || generating}
            onClick={() => void generate()}
          >
            {generating ? 'Generating icon sizes…' : 'Crop & generate icon bundle'}
          </button>
        </aside>
      </div>

      {result && (
        <section className="favicon-result-card" aria-live="polite">
          <div className="favicon-result-heading">
            <div>
              <span className="favicon-success-mark">✓</span>
              <div><strong>Icon bundle ready</strong><span>{result.outputDirectory}</span></div>
            </div>
          </div>
          <div className="favicon-file-grid">
            {result.files.map((file) => (
              <div key={file.fileName} className="favicon-file-row">
                <strong>{file.fileName}</strong>
                <span>{file.size || file.purpose}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
