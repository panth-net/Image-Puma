import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { AppPreset } from '../../core/shared/types';

interface PresetGroup {
  label: string;
  presets: AppPreset[];
}

interface PresetPickerModalProps {
  open: boolean;
  presets: AppPreset[];
  activePresetId?: string;
  disabled?: boolean;
  onSelect: (preset: AppPreset) => void;
  onCreate?: () => void;
  onEdit?: (preset: AppPreset) => void;
  onDelete?: (preset: AppPreset) => void;
  onClose: () => void;
}

const RECOMMENDED_PRESET_IDS = ['web-upload', 'squoosh-aggressive', 'windows-icon'];
const SOCIAL_PRESET_IDS = [
  'blog-hero',
  'social-portrait',
  'twitter-og',
  'thumbnail',
];

function groupPresets(presets: AppPreset[]): PresetGroup[] {
  const builtIns = presets.filter((preset) => !preset.id.startsWith('user-'));
  const saved = presets.filter((preset) => preset.id.startsWith('user-'));
  const groupedIds = new Set([
    ...RECOMMENDED_PRESET_IDS,
    ...SOCIAL_PRESET_IDS,
  ]);

  return [
    {
      label: 'Recommended',
      presets: builtIns.filter((preset) => RECOMMENDED_PRESET_IDS.includes(preset.id)),
    },
    {
      label: 'Social & Web',
      presets: builtIns.filter((preset) => SOCIAL_PRESET_IDS.includes(preset.id)),
    },
    {
      label: 'Advanced',
      presets: builtIns.filter((preset) => !groupedIds.has(preset.id)),
    },
    {
      label: 'Saved Presets',
      presets: saved,
    },
  ].filter((group) => group.presets.length > 0);
}

export function PresetPickerModal({
  open,
  presets,
  activePresetId,
  disabled = false,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
  onClose,
}: PresetPickerModalProps) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const groups = useMemo(() => groupPresets(presets), [presets]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTarget = modalRef.current?.querySelector<HTMLElement>(
      '[data-active-preset="true"], .preset-picker-close',
    );
    focusTarget?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === 'Tab' && modalRef.current) {
        const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop preset-picker-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="preset-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preset-picker-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="preset-picker-header">
          <div>
            <div id="preset-picker-title" className="preset-picker-title">Choose a preset</div>
            <div className="preset-picker-description">
              Pick a starting recipe. You can fine-tune every setting afterward.
            </div>
          </div>
          <div className="preset-picker-header-actions">
            {onCreate && (
              <button
                type="button"
                className="btn btn-secondary btn-sm preset-picker-new"
                disabled={disabled}
                onClick={onCreate}
              >
                New
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost preset-picker-close"
              aria-label="Close preset picker"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>

        <div className="preset-picker-columns">
          {groups.map((group) => (
            <section key={group.label} className="preset-picker-group" aria-label={group.label}>
              <div className="preset-picker-group-title">
                {group.label}
              </div>
              <div className="preset-picker-card-list">
                {group.presets.map((preset) => {
                  const active = preset.id === activePresetId;
                  const userOwned = preset.id.startsWith('user-');
                  return (
                    <article key={preset.id} className={`preset-picker-card${active ? ' active' : ''}`}>
                      <button
                        type="button"
                        className="preset-picker-card-main"
                        disabled={disabled}
                        aria-pressed={active}
                        data-active-preset={active ? 'true' : undefined}
                        onClick={() => onSelect(preset)}
                      >
                        <span className="preset-picker-card-name-row">
                          <strong>{preset.name}</strong>
                          {active && <span className="preset-picker-active-badge">Current</span>}
                        </span>
                        <span>{preset.description}</span>
                      </button>
                      {(onEdit || onDelete) && (
                        <div className="preset-picker-card-actions">
                          {onEdit && (
                            <button
                              type="button"
                              className="btn btn-ghost preset-picker-icon-button"
                              disabled={disabled}
                              aria-label={`Edit ${preset.name}`}
                              data-tooltip={`Edit ${preset.name}`}
                              onClick={() => onEdit(preset)}
                            >
                              <svg className="preset-button-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M4 20h4l10.5-10.5-4-4L4 16v4Z" />
                                <path d="m13.5 6.5 4 4" />
                              </svg>
                            </button>
                          )}
                          {onDelete && (
                            <button
                              type="button"
                              className="btn btn-ghost preset-picker-icon-button preset-picker-delete"
                              disabled={disabled || !userOwned}
                              aria-label={`Delete ${preset.name}`}
                              data-tooltip={userOwned ? `Delete ${preset.name}` : 'Built-in presets cannot be deleted'}
                              onClick={() => onDelete(preset)}
                            >
                              <svg className="preset-button-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M3 6h18" />
                                <path d="M8 6V4h8v2" />
                                <path d="M6 6l1 14h10l1-14" />
                                <path d="M10 11v5" />
                                <path d="M14 11v5" />
                              </svg>
                            </button>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
