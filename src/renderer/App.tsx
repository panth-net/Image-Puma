import React, { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type {
  InputFile,
  AppPreset,
  BatchJobResult,
  BatchProgressUpdate,
  InputScanResult,
  ProcessedFileResult,
} from '../core/shared/types';
import { api } from './api';
import {
  getParentFolder,
  mergeBatchResults,
  buildErrorLog,
} from './batch-utils';
import { normalizeMetadataSettings } from '../core/shared/metadata-settings';
import { recipeFingerprint } from '../core/shared/recipe-helpers';
import { SplashScreen } from './components/SplashScreen';
import { TitleBar } from './components/TitleBar';
import { BatchWorkbenchPage } from './components/BatchWorkbenchPage';
import { BackgroundRemoverPage } from './components/BackgroundRemoverPage';
import { QuickFaviconPage } from './components/QuickFaviconPage';

export type AppPage = 'splash' | 'workbench' | 'background-remover' | 'quick-favicon';

interface RunSnapshot {
  preset: AppPreset;
}

interface ToastItem {
  id: number;
  kind: 'error' | 'success' | 'info';
  message: string;
}

const LOCAL_ACTIVE_PRESET_KEY = 'image-puma.activePresetDraft.v1';
const THUMBNAIL_CONCURRENCY = 4;
/**
 * localStorage.setItem is synchronous. Writing on every recipe keystroke or crop
 * drag frame blocks the renderer, so the draft is written on a trailing debounce.
 */
const LOCAL_PRESET_SAVE_DELAY_MS = 400;
const RETIRED_PRESET_IDS = new Set(['email-attachment', 'product-photo', 'social-landscape']);
const TOOLTIP_MAX_WIDTH = 260;
const TOOLTIP_VIEWPORT_MARGIN = 12;
const TOOLTIP_OFFSET = 8;
const TOOLTIP_MIN_WIDTH = 160;
const TOOLTIP_MAX_ALLOWED_WIDTH = 420;

type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

interface TooltipState {
  text: string;
  left: number;
  top: number;
  placement: TooltipPlacement;
  preferredPlacement: TooltipPlacement;
  maxWidth: number;
  visible: boolean;
}

function getTooltipTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-tooltip]');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseTooltipPlacement(value: string | null): TooltipPlacement {
  if (value === 'top' || value === 'bottom' || value === 'left' || value === 'right') return value;
  return 'top';
}

function parseTooltipWidth(value: string | null): number {
  if (!value) return TOOLTIP_MAX_WIDTH;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return TOOLTIP_MAX_WIDTH;
  return clamp(numericValue, TOOLTIP_MIN_WIDTH, TOOLTIP_MAX_ALLOWED_WIDTH);
}

function getTooltipPlacementOrder(preferredPlacement: TooltipPlacement): TooltipPlacement[] {
  if (preferredPlacement === 'left') return ['left', 'right', 'top', 'bottom'];
  if (preferredPlacement === 'right') return ['right', 'left', 'top', 'bottom'];
  if (preferredPlacement === 'bottom') return ['bottom', 'top', 'right', 'left'];
  return ['top', 'bottom', 'right', 'left'];
}

function tooltipPlacementFits(
  placement: TooltipPlacement,
  targetRect: DOMRect,
  tooltipWidth: number,
  tooltipHeight: number,
): boolean {
  const margin = TOOLTIP_VIEWPORT_MARGIN;
  const offset = TOOLTIP_OFFSET;

  if (placement === 'left') return targetRect.left - offset - tooltipWidth >= margin;
  if (placement === 'right') return targetRect.right + offset + tooltipWidth <= window.innerWidth - margin;
  if (placement === 'top') return targetRect.top - offset - tooltipHeight >= margin;
  return targetRect.bottom + offset + tooltipHeight <= window.innerHeight - margin;
}

function resolveTooltipPosition(
  target: HTMLElement,
  tooltipElement: HTMLElement,
  preferredPlacement: TooltipPlacement,
): Pick<TooltipState, 'left' | 'top' | 'placement'> {
  const targetRect = target.getBoundingClientRect();
  const maxTooltipWidth = Math.max(0, window.innerWidth - (TOOLTIP_VIEWPORT_MARGIN * 2));
  const maxTooltipHeight = Math.max(0, window.innerHeight - (TOOLTIP_VIEWPORT_MARGIN * 2));
  const tooltipWidth = Math.min(tooltipElement.offsetWidth || TOOLTIP_MAX_WIDTH, maxTooltipWidth);
  const tooltipHeight = Math.min(tooltipElement.offsetHeight || 0, maxTooltipHeight);
  const placementOrder = getTooltipPlacementOrder(preferredPlacement);
  const placement = placementOrder.find((candidate) => (
    tooltipPlacementFits(candidate, targetRect, tooltipWidth, tooltipHeight)
  )) || placementOrder[0];
  const maxLeft = Math.max(TOOLTIP_VIEWPORT_MARGIN, window.innerWidth - TOOLTIP_VIEWPORT_MARGIN - tooltipWidth);
  const maxTop = Math.max(TOOLTIP_VIEWPORT_MARGIN, window.innerHeight - TOOLTIP_VIEWPORT_MARGIN - tooltipHeight);
  const centeredLeft = targetRect.left + (targetRect.width / 2) - (tooltipWidth / 2);
  const centeredTop = targetRect.top + (targetRect.height / 2) - (tooltipHeight / 2);

  if (placement === 'left') {
    return {
      placement,
      left: clamp(targetRect.left - TOOLTIP_OFFSET - tooltipWidth, TOOLTIP_VIEWPORT_MARGIN, maxLeft),
      top: clamp(centeredTop, TOOLTIP_VIEWPORT_MARGIN, maxTop),
    };
  }

  if (placement === 'right') {
    return {
      placement,
      left: clamp(targetRect.right + TOOLTIP_OFFSET, TOOLTIP_VIEWPORT_MARGIN, maxLeft),
      top: clamp(centeredTop, TOOLTIP_VIEWPORT_MARGIN, maxTop),
    };
  }

  if (placement === 'bottom') {
    return {
      placement,
      left: clamp(centeredLeft, TOOLTIP_VIEWPORT_MARGIN, maxLeft),
      top: clamp(targetRect.bottom + TOOLTIP_OFFSET, TOOLTIP_VIEWPORT_MARGIN, maxTop),
    };
  }

  return {
    placement,
    left: clamp(centeredLeft, TOOLTIP_VIEWPORT_MARGIN, maxLeft),
    top: clamp(targetRect.top - TOOLTIP_OFFSET - tooltipHeight, TOOLTIP_VIEWPORT_MARGIN, maxTop),
  };
}

function AppTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const activeTargetRef = useRef<HTMLElement | null>(null);
  const tooltipElementRef = useRef<HTMLDivElement | null>(null);

  const hideTooltip = useCallback(() => {
    activeTargetRef.current = null;
    setTooltip(null);
  }, []);

  const refreshTooltip = useCallback(() => {
    const activeTarget = activeTargetRef.current;
    const tooltipElement = tooltipElementRef.current;
    if (!activeTarget || !document.body.contains(activeTarget)) {
      hideTooltip();
      return;
    }
    if (!tooltipElement) return;

    setTooltip((currentTooltip) => {
      if (!currentTooltip) return currentTooltip;
      const nextPosition = resolveTooltipPosition(
        activeTarget,
        tooltipElement,
        currentTooltip.preferredPlacement,
      );
      if (
        currentTooltip.left === nextPosition.left
        && currentTooltip.top === nextPosition.top
        && currentTooltip.placement === nextPosition.placement
        && currentTooltip.visible
      ) {
        return currentTooltip;
      }
      return { ...currentTooltip, ...nextPosition, visible: true };
    });
  }, [hideTooltip]);

  const showTooltip = useCallback((target: HTMLElement) => {
    const text = target.getAttribute('data-tooltip')?.trim();
    if (!text) {
      hideTooltip();
      return;
    }

    const preferredPlacement = parseTooltipPlacement(target.getAttribute('data-tooltip-placement'));
    const maxWidth = parseTooltipWidth(target.getAttribute('data-tooltip-width'));
    const sameTarget = activeTargetRef.current === target;
    activeTargetRef.current = target;

    setTooltip((currentTooltip) => {
      if (
        sameTarget
        && currentTooltip
        && currentTooltip.text === text
        && currentTooltip.preferredPlacement === preferredPlacement
        && currentTooltip.maxWidth === maxWidth
      ) {
        return currentTooltip;
      }
      return {
        text,
        left: TOOLTIP_VIEWPORT_MARGIN,
        top: TOOLTIP_VIEWPORT_MARGIN,
        placement: preferredPlacement,
        preferredPlacement,
        maxWidth,
        visible: false,
      };
    });
  }, [hideTooltip]);

  useLayoutEffect(() => {
    if (!tooltip) return;
    refreshTooltip();
  }, [
    refreshTooltip,
    tooltip?.maxWidth,
    tooltip?.preferredPlacement,
    tooltip?.text,
    tooltip?.visible,
  ]);

  useEffect(() => {
    const handleMouseOver = (event: MouseEvent) => {
      const target = getTooltipTarget(event.target);
      if (target) showTooltip(target);
    };

    const handleMouseOut = (event: MouseEvent) => {
      const activeTarget = activeTargetRef.current;
      if (!activeTarget) return;
      if (event.relatedTarget instanceof Node && activeTarget.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = getTooltipTarget(event.target);
      if (target) showTooltip(target);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const activeTarget = activeTargetRef.current;
      if (!activeTarget) return;
      if (event.relatedTarget instanceof Node && activeTarget.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('mouseout', handleMouseOut);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    window.addEventListener('scroll', refreshTooltip, true);
    window.addEventListener('resize', refreshTooltip);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('mouseout', handleMouseOut);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      window.removeEventListener('scroll', refreshTooltip, true);
      window.removeEventListener('resize', refreshTooltip);
    };
  }, [hideTooltip, refreshTooltip, showTooltip]);

  if (!tooltip) return null;

  return createPortal(
    <div
      ref={tooltipElementRef}
      role="tooltip"
      className={`app-tooltip app-tooltip-${tooltip.placement}${tooltip.visible ? ' app-tooltip-visible' : ''}`}
      style={{
        left: tooltip.left,
        top: tooltip.top,
        '--tooltip-max-width': `${tooltip.maxWidth}px`,
      } as React.CSSProperties}
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}

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
    metadata: normalizeMetadataSettings(preset.metadata),
    naming: { ...preset.naming },
    export: { ...preset.export },
  };
}

function isAppPreset(value: unknown): value is AppPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<AppPreset>;
  return typeof preset.id === 'string'
    && typeof preset.name === 'string'
    && typeof preset.description === 'string'
    && Boolean(preset.output)
    && Boolean(preset.resize)
    && Boolean(preset.crop)
    && Boolean(preset.transform)
    && Boolean(preset.metadata)
    && Boolean(preset.naming)
    && Boolean(preset.export);
}

function loadLocalActivePreset(): AppPreset | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_ACTIVE_PRESET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isAppPreset(parsed) ? clonePreset(parsed) : null;
  } catch {
    return null;
  }
}

function saveLocalActivePreset(preset: AppPreset): void {
  try {
    window.localStorage.setItem(LOCAL_ACTIVE_PRESET_KEY, JSON.stringify(clonePreset(preset)));
  } catch {
    // Session persistence still runs through IPC; localStorage is best-effort reload recovery.
  }
}

function normalizeRestoredActivePreset(
  preset: AppPreset | null,
  loadedPresets: AppPreset[],
): AppPreset | null {
  if (!preset) return null;
  if (RETIRED_PRESET_IDS.has(preset.id)) return null;
  if (preset.id !== 'default') return clonePreset(preset);

  const currentDefault = loadedPresets.find((item) => item.id === 'default');
  return currentDefault ? clonePreset(currentDefault) : clonePreset(preset);
}

function mapResultsBySourcePath(result: BatchJobResult | null): Record<string, ProcessedFileResult> {
  if (!result) return {};
  return Object.fromEntries(result.results.map((item) => [item.sourcePath, item]));
}

function isRecoverableResult(result: ProcessedFileResult): boolean {
  return !result.success && (!result.skipped || result.cancelled === true);
}

function shouldFallbackRestoredPreset(preset: AppPreset): boolean {
  return preset.id === 'custom'
    || preset.id.startsWith('draft-')
    || RETIRED_PRESET_IDS.has(preset.id);
}

export function App() {
  const [page, setPage] = useState<AppPage>('splash');
  const [files, setFiles] = useState<InputFile[]>([]);
  const [presets, setPresets] = useState<AppPreset[]>([]);
  const [activePreset, setActivePreset] = useState<AppPreset | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [batchResult, setBatchResult] = useState<BatchJobResult | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgressUpdate | null>(null);
  const [batchResultsBySourcePath, setBatchResultsBySourcePath] = useState<Record<string, ProcessedFileResult>>({});
  const [activeBatchFiles, setActiveBatchFiles] = useState<InputFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStoppingBatch, setIsStoppingBatch] = useState(false);
  const [isRetryingFailures, setIsRetryingFailures] = useState(false);
  const [isBackgroundRemovalProcessing, setIsBackgroundRemovalProcessing] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [sessionWarning, setSessionWarning] = useState<string | null>(null);
  const [appDragOver, setAppDragOver] = useState(false);
  const sessionRestoredRef = useRef(false);
  const restoredDefaultNormalizedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const requestedThumbnailsRef = useRef<Set<string>>(new Set());
  const pendingLocalPresetRef = useRef<AppPreset | null>(null);
  const toastTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const nextToastIdRef = useRef(1);
  const latestRunSnapshotRef = useRef<RunSnapshot | null>(null);
  const appDragCounterRef = useRef(0);
  const pushToast = useCallback((message: string, kind: ToastItem['kind'] = 'info') => {
    const id = nextToastIdRef.current++;
    setToasts((prev) => [...prev, { id, kind, message }]);
    const timer = setTimeout(() => {
      toastTimersRef.current.delete(timer);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 5000);
    toastTimersRef.current.add(timer);
  }, []);

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const pushErrorToast = useCallback((message: string) => {
    pushToast(message, 'error');
  }, [pushToast]);

  // Load presets on mount, then restore session
  useEffect(() => {
    let isMounted = true;
    void (async () => {
      try {
        const loadedPresets = await api.loadPresets();
        if (!isMounted) return;
        setPresets(loadedPresets);
        const fallbackPreset = loadedPresets.find((preset) => preset.id === 'default') || loadedPresets[0] || null;
        const localActivePreset = normalizeRestoredActivePreset(loadLocalActivePreset(), loadedPresets);

        // Try restoring a previous session
        const session = await api.loadSession();
        if (!isMounted) return;
        if (session && session.files.length > 0) {
          setFiles(session.files);
          const restoredPreset = loadedPresets.find((preset) => preset.id === session.activePreset.id)
            || (shouldFallbackRestoredPreset(session.activePreset) ? fallbackPreset : session.activePreset);
          // The local draft is written immediately whenever the user changes presets.
          // Prefer it over a possibly older debounced workspace session.
          setActivePreset(localActivePreset || restoredPreset || session.activePreset);
          if (session.batchResult) {
            setBatchResult(session.batchResult);
            setBatchResultsBySourcePath(mapResultsBySourcePath(session.batchResult));
          }
          setSelectedFileIndex(
            Math.min(session.selectedFileIndex || 0, session.files.length - 1),
          );
          if ((session.unavailableSourceCount || 0) > 0) {
            setSessionNotice(
              `${session.unavailableSourceCount} previous source${session.unavailableSourceCount === 1 ? '' : 's'} could not be reopened. Restored ${session.files.length} available source${session.files.length === 1 ? '' : 's'}.`,
            );
          } else if (session.batchResult) {
            setSessionNotice('Restored the previous batch results and source list.');
          }
          setPage('workbench');
        } else if (session && (session.unavailableSourceCount || 0) > 0) {
          const restoredPreset = loadedPresets.find((preset) => preset.id === session.activePreset.id)
            || (shouldFallbackRestoredPreset(session.activePreset) ? fallbackPreset : session.activePreset);
          setActivePreset(localActivePreset || restoredPreset || session.activePreset);
          setSessionNotice(
            `Previous session sources unavailable: ${session.unavailableSourceCount} source${session.unavailableSourceCount === 1 ? '' : 's'} could not be reopened.`,
          );
        } else if (localActivePreset) {
          setActivePreset(localActivePreset);
        } else if (fallbackPreset) {
          setActivePreset(fallbackPreset);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushToast(`Could not load presets/session: ${message}`, 'error');
      } finally {
        if (isMounted) {
          setPage('workbench');
        }
        sessionRestoredRef.current = true;
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [pushToast]);

  useEffect(() => {
    if (!sessionRestoredRef.current || !activePreset) return undefined;

    const timer = setTimeout(() => saveLocalActivePreset(activePreset), LOCAL_PRESET_SAVE_DELAY_MS);
    pendingLocalPresetRef.current = activePreset;

    return () => clearTimeout(timer);
  }, [activePreset]);

  // The debounce above can be pending when the window goes away; flush it so the
  // last edit still survives a reload.
  useEffect(() => {
    const flush = () => {
      const pending = pendingLocalPresetRef.current;
      if (pending) saveLocalActivePreset(pending);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  useEffect(() => {
    if (!sessionRestoredRef.current || restoredDefaultNormalizedRef.current) return;
    if (!activePreset || presets.length === 0) return;

    restoredDefaultNormalizedRef.current = true;
    const currentDefault = presets.find((preset) => preset.id === 'default');
    if (
      activePreset.id === 'default'
      && currentDefault
      && recipeFingerprint(activePreset) !== recipeFingerprint(currentDefault)
    ) {
      setActivePreset(clonePreset(currentDefault));
    }
  }, [activePreset, presets]);

  // Auto-save session on state changes (debounced)
  useEffect(() => {
    if (!sessionRestoredRef.current || !activePreset) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void api.saveSession({
        files,
        activePreset,
        selectedFileIndex,
        batchResult,
      }).then(() => {
        setSessionWarning(null);
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setSessionWarning(`Session could not be saved. This workspace may not restore next time. ${message}`);
      });
    }, 500);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [files, activePreset, selectedFileIndex, batchResult]);

  // Generate thumbnails when files change.
  // `requestedThumbnailsRef` is what keeps this from stampeding: the effect used
  // to depend on `thumbnails` and write it, so every completed thumbnail re-ran
  // the effect and re-requested every still-pending file — quadratic IPC on import.
  useEffect(() => {
    if (files.length === 0) return;

    const pending = files.filter((file) => !requestedThumbnailsRef.current.has(file.sourcePath));
    if (pending.length === 0) return;

    for (const file of pending) {
      requestedThumbnailsRef.current.add(file.sourcePath);
    }

    // A small pool keeps the list filling quickly without firing hundreds of
    // concurrent sharp decodes that would starve preview generation.
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const file = pending[cursor++];
        try {
          const thumb = await api.generateThumbnail(file.sourcePath);
          setThumbnails((prev) => (prev[file.sourcePath] ? prev : { ...prev, [file.sourcePath]: thumb }));
        } catch {
          // Leave it unrequested so a later import can retry this source.
          requestedThumbnailsRef.current.delete(file.sourcePath);
        }
      }
    };

    for (let i = 0; i < Math.min(THUMBNAIL_CONCURRENCY, pending.length); i++) {
      void worker();
    }
  }, [files]);

  const handleFilesImported = useCallback((
    result: InputScanResult,
    nextPage: Exclude<AppPage, 'splash'> = 'workbench',
  ) => {
    let nextHasFiles = false;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.sourcePath));
      const newFiles = result.files.filter((f) => !existing.has(f.sourcePath));
      const updated = [...prev, ...newFiles];
      nextHasFiles = updated.length > 0;

      if (prev.length === 0 && newFiles.length > 0) {
        setSelectedFileIndex(0);
      }

      return updated;
    });
    if (nextHasFiles) {
      setPage(nextPage);
    }
  }, []);

  const handleWorkbenchFilesImported = useCallback((result: InputScanResult) => {
    handleFilesImported(result, 'workbench');
  }, [handleFilesImported]);

  const handleBackgroundFilesImported = useCallback((result: InputScanResult) => {
    handleFilesImported(result, 'background-remover');
  }, [handleFilesImported]);

  useEffect(() => {
    if (page === 'quick-favicon') {
      setAppDragOver(false);
      appDragCounterRef.current = 0;
      return undefined;
    }
    const hasDraggedFiles = (event: DragEvent): boolean => (
      Array.from(event.dataTransfer?.types || []).includes('Files')
    );

    const resetDragState = () => {
      appDragCounterRef.current = 0;
      setAppDragOver(false);
    };

    const handleDragEnter = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      appDragCounterRef.current++;
      setAppDragOver(true);
    };

    const handleDragOver = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      setAppDragOver(true);
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      appDragCounterRef.current--;
      const leftWindow = (
        event.clientX <= 0
        || event.clientY <= 0
        || event.clientX >= window.innerWidth
        || event.clientY >= window.innerHeight
      );
      if (appDragCounterRef.current <= 0 || leftWindow) {
        resetDragState();
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      resetDragState();

      const droppedFiles = Array.from(event.dataTransfer?.files || []);
      const paths = droppedFiles
        .map((file) => api.getPathForFile(file))
        .filter((path) => path.length > 0);
      if (paths.length === 0) return;

      const targetPage: Exclude<AppPage, 'splash'> = page === 'background-remover'
        ? 'background-remover'
        : 'workbench';
      void api.dropFiles(paths)
        .then((result) => handleFilesImported(result, targetPage))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          pushToast(`Could not import dropped files: ${message}`, 'error');
        });
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
  }, [handleFilesImported, page, pushToast]);

  const handleRemoveFile = useCallback((sourcePath: string) => {
    const removedIndex = files.findIndex((file) => file.sourcePath === sourcePath);
    const nextFiles = files.filter((file) => file.sourcePath !== sourcePath);

    setFiles(nextFiles);
    requestedThumbnailsRef.current.delete(sourcePath);
    setThumbnails((prev) => {
      const next = { ...prev };
      delete next[sourcePath];
      return next;
    });
    setSelectedFileIndex((current) => {
      if (nextFiles.length === 0) return 0;
      if (removedIndex >= 0 && current > removedIndex) return current - 1;
      return Math.min(current, nextFiles.length - 1);
    });

    if (nextFiles.length === 0) {
      setBatchResult(null);
      setBatchProgress(null);
      setBatchResultsBySourcePath({});
      setActiveBatchFiles([]);
      latestRunSnapshotRef.current = null;
      setPage('workbench');
    }
  }, [files]);

  const runBatchForFiles = useCallback(async (
    batchFiles: InputFile[],
    previousResult?: BatchJobResult,
    snapshot?: RunSnapshot,
  ) => {
    const resolvedSnapshot = snapshot || (activePreset
      ? {
        preset: clonePreset(activePreset),
      }
      : null);

    if (!resolvedSnapshot || batchFiles.length === 0) return;

    const { preset: runPreset } = resolvedSnapshot;
    if (!previousResult) {
      latestRunSnapshotRef.current = resolvedSnapshot;
    }

    setActiveBatchFiles(batchFiles);
    setIsProcessing(true);
    setIsStoppingBatch(false);
    setBatchProgress(null);
    setBatchResultsBySourcePath({});
    if (!previousResult) {
      setBatchResult(null);
    }

    const unsub = api.onBatchProgress((progress) => {
      setBatchProgress(progress);
      if (progress.status === 'stopping') {
        setIsStoppingBatch(true);
      }
      const progressResult = progress.result;
      if (progressResult) {
        setBatchResultsBySourcePath((prev) => ({
          ...prev,
          [progressResult.sourcePath]: progressResult,
        }));
      }
    });

    try {
      const result = await api.runBatch({
        files: batchFiles,
        preset: runPreset,
      });

      const nextResult = previousResult ? mergeBatchResults(previousResult, result) : result;
      setBatchResult(nextResult);
      setBatchResultsBySourcePath(mapResultsBySourcePath(nextResult));

      if (runPreset.export.openFolderWhenDone) {
        const firstSuccess = result.results.find((item) => item.success);
        const outputFolder = firstSuccess ? getParentFolder(firstSuccess.outputPath) : '';
        if (outputFolder) {
          const openResult = await api.openFolder(outputFolder);
          if (openResult) {
            pushToast(`Could not open output folder: ${openResult}`, 'error');
          }
        }
      }
    } catch (err) {
      console.error('Batch failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      pushToast(`Batch failed: ${message}`, 'error');
    } finally {
      setIsProcessing(false);
      setIsStoppingBatch(false);
      unsub();
    }
  }, [activePreset, mergeBatchResults, pushToast]);

  const handleRunBatch = useCallback((presetOverride?: AppPreset) => {
    const preset = presetOverride || activePreset;
    const snapshot = preset
      ? {
        preset: clonePreset(preset),
      }
      : null;
    if (!snapshot) {
      pushToast('Select a preset before starting a batch', 'error');
      return;
    }
    if (
      snapshot.preset.export.destination === 'custom'
      && snapshot.preset.export.customPath.trim().length === 0
    ) {
      pushToast('Choose a custom export folder before starting the batch', 'error');
      return;
    }
    void runBatchForFiles(files, undefined, snapshot);
  }, [activePreset, files, pushToast, runBatchForFiles]);

  const handleRetrySources = useCallback((sourcePaths: string[], usePreviousSettings: boolean) => {
    if (!batchResult || sourcePaths.length === 0) return;

    const retryPathSet = new Set(sourcePaths);
    const retryFiles = files.filter((file) => retryPathSet.has(file.sourcePath));
    if (retryFiles.length === 0) return;

    const snapshot = usePreviousSettings
      ? latestRunSnapshotRef.current
      : activePreset
        ? {
          preset: clonePreset(activePreset),
        }
        : null;

    if (!snapshot) {
      pushToast(
        usePreviousSettings
          ? 'No previous batch settings found for retry'
          : 'Select a preset before retrying with current settings',
        'error',
      );
      return;
    }

    setIsRetryingFailures(true);
    void runBatchForFiles(retryFiles, batchResult, snapshot).finally(() => {
      setIsRetryingFailures(false);
    });
  }, [activePreset, batchResult, files, pushToast, runBatchForFiles]);

  const handleRetryFailed = useCallback(() => {
    if (!batchResult) return;

    const failedPaths = new Set(
      batchResult.results
        .filter(isRecoverableResult)
        .map((result) => result.sourcePath),
    );
    void handleRetrySources(Array.from(failedPaths), true);
  }, [batchResult, handleRetrySources]);

  const handleSavePresetDraft = useCallback(async (preset: AppPreset): Promise<AppPreset> => {
    try {
      const updatedPresets = await api.savePreset(clonePreset(preset));
      setPresets(updatedPresets);

      const refreshedPreset = updatedPresets.find((item) => item.id === preset.id)
        || updatedPresets.find((item) => item.name === preset.name)
        || preset;
      setActivePreset(refreshedPreset);
      pushToast(`Preset "${refreshedPreset.name}" saved`, 'success');
      return refreshedPreset;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(`Could not save preset: ${message}`, 'error');
      throw err;
    }
  }, [pushToast]);

  const handleDeletePreset = useCallback(async (preset: AppPreset): Promise<void> => {
    if (!preset.id.startsWith('user-')) {
      throw new Error('Built-in presets cannot be deleted.');
    }

    try {
      const updatedPresets = await api.deletePreset(preset.id);
      setPresets(updatedPresets);

      if (activePreset?.id === preset.id) {
        const fallbackPreset = updatedPresets.find((item) => item.id === 'default')
          || updatedPresets[0]
          || null;
        if (fallbackPreset) {
          setActivePreset(fallbackPreset);
        }
      }

      pushToast(`Preset "${preset.name}" deleted`, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(`Could not delete preset: ${message}`, 'error');
      throw err;
    }
  }, [activePreset?.id, pushToast]);

  const handleExportErrorLog = useCallback(async () => {
    if (!batchResult || batchResult.failureCount === 0) return;
    const content = buildErrorLog(batchResult);
    try {
      const path = await api.exportErrorLog({
        content,
        defaultFileName: `image-puma-errors-${Date.now()}.txt`,
      });
      if (path) {
        pushToast('Error log exported', 'success');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(`Could not export error log: ${message}`, 'error');
    }
  }, [batchResult, pushToast]);

  const handleCancelBatch = useCallback(async () => {
    setIsStoppingBatch(true);
    try {
      await api.cancelBatch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(`Could not cancel batch: ${message}`, 'error');
    }
  }, [pushToast]);

  const handleDismissResults = useCallback(() => {
    setBatchResult(null);
    setBatchProgress(null);
    setBatchResultsBySourcePath({});
    setActiveBatchFiles([]);
  }, []);

  const handleStartOver = useCallback(() => {
    setFiles([]);
    setBatchResult(null);
    setBatchProgress(null);
    setBatchResultsBySourcePath({});
    setActiveBatchFiles([]);
    setIsRetryingFailures(false);
    setIsStoppingBatch(false);
    setIsBackgroundRemovalProcessing(false);
    setSelectedFileIndex(0);
    setThumbnails({});
    requestedThumbnailsRef.current.clear();
    setSessionNotice(null);
    latestRunSnapshotRef.current = null;
    setPage('workbench');
    // Clear saved session
    if (activePreset) {
      void api.saveSession({
        files: [],
        activePreset,
        selectedFileIndex: 0,
        batchResult: null,
      }).then(() => {
        setSessionWarning(null);
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setSessionWarning(`Session could not be cleared. ${message}`);
      });
    }
  }, [activePreset]);

  return (
    <div className="app-layout">
      {page === 'splash' && <SplashScreen />}

      {appDragOver && (
        <div className="app-drop-overlay" aria-hidden="true">
          <div className="app-drop-overlay-box">Drop files or folders to import</div>
        </div>
      )}

      {page !== 'splash' && (
        <>
          <TitleBar
            activePage={page === 'background-remover'
              ? 'background-remover'
              : page === 'quick-favicon'
                ? 'quick-favicon'
                : 'workbench'}
            onPageChange={setPage}
            navigationLocked={isProcessing || isBackgroundRemovalProcessing}
          />
          <div className="app-body">
            {page === 'workbench' && (
              <BatchWorkbenchPage
                files={files}
                presets={presets}
                activePreset={activePreset}
                setActivePreset={setActivePreset}
                thumbnails={thumbnails}
                selectedIndex={selectedFileIndex}
                setSelectedIndex={setSelectedFileIndex}
                onRunBatch={handleRunBatch}
                onFilesImported={handleWorkbenchFilesImported}
                onRemoveFile={handleRemoveFile}
                onClearFiles={handleStartOver}
                batchProgress={batchProgress}
                batchResult={batchResult}
                resultsBySourcePath={batchResultsBySourcePath}
                activeBatchFiles={activeBatchFiles}
                isProcessing={isProcessing}
                isStoppingBatch={isStoppingBatch}
                isRetryingFailures={isRetryingFailures}
                onCancelBatch={handleCancelBatch}
                onRetryFailed={handleRetryFailed}
                onRetrySources={handleRetrySources}
                onExportErrorLog={handleExportErrorLog}
                onDismissResults={handleDismissResults}
                sessionNotice={sessionNotice}
                sessionWarning={sessionWarning}
                onDismissSessionNotice={() => setSessionNotice(null)}
                onDismissSessionWarning={() => setSessionWarning(null)}
                onSavePresetDraft={handleSavePresetDraft}
                onDeletePreset={handleDeletePreset}
                onError={pushErrorToast}
              />
            )}
            {page === 'background-remover' && (
              <BackgroundRemoverPage
                files={files}
                thumbnails={thumbnails}
                selectedIndex={selectedFileIndex}
                setSelectedIndex={setSelectedFileIndex}
                onFilesImported={handleBackgroundFilesImported}
                onRemoveFile={handleRemoveFile}
                onClearFiles={handleStartOver}
                onSwitchToPrep={() => setPage('workbench')}
                onError={pushErrorToast}
                onSuccess={(message) => pushToast(message, 'success')}
                onProcessingChange={setIsBackgroundRemovalProcessing}
              />
            )}
            {page === 'quick-favicon' && (
              <QuickFaviconPage onError={pushErrorToast} />
            )}
          </div>
        </>
      )}

      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item toast-${toast.kind}`}>
            {toast.message}
          </div>
        ))}
      </div>
      <AppTooltip />
    </div>
  );
}
