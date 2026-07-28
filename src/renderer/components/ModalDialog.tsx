import React, { useEffect, useMemo, useState } from 'react';

interface ModalDialogProps {
  open: boolean;
  title: string;
  description?: string;
  error?: string | null;
  confirmLabel: string;
  cancelLabel?: string;
  secondaryLabel?: string;
  confirmVariant?: 'primary' | 'danger';
  secondaryVariant?: 'secondary' | 'danger';
  initialValue?: string;
  inputLabel?: string;
  inputPlaceholder?: string;
  requireInput?: boolean;
  autoFocusConfirm?: boolean;
  onConfirm: (value: string) => Promise<void> | void;
  onSecondary?: () => Promise<void> | void;
  onCancel: () => void;
}

export function ModalDialog({
  open,
  title,
  description,
  error = null,
  confirmLabel,
  cancelLabel = 'Cancel',
  secondaryLabel,
  confirmVariant = 'primary',
  secondaryVariant = 'secondary',
  initialValue = '',
  inputLabel,
  inputPlaceholder,
  requireInput = false,
  autoFocusConfirm = false,
  onConfirm,
  onSecondary,
  onCancel,
}: ModalDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setIsSubmitting(false);
  }, [open, initialValue]);

  const canSubmit = useMemo(() => {
    if (isSubmitting) return false;
    if (!requireInput) return true;
    return value.trim().length > 0;
  }, [isSubmitting, requireInput, value]);

  if (!open) return null;

  const handleConfirm = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      await onConfirm(value.trim());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onCancel();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !isSubmitting) {
          onCancel();
        }
      }}
    >
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        {description && <div className="modal-description">{description}</div>}
        {error && <div className="modal-error">{error}</div>}

        {inputLabel && (
          <label className="modal-input-row">
            <span className="modal-input-label">{inputLabel}</span>
            <input
              autoFocus
              type="text"
              value={value}
              placeholder={inputPlaceholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault();
                  void handleConfirm();
                }
              }}
            />
          </label>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={isSubmitting}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              className={`btn ${secondaryVariant === 'danger' ? 'btn-danger' : 'btn-secondary'}`}
              disabled={isSubmitting}
              onClick={() => void onSecondary()}
            >
              {secondaryLabel}
            </button>
          )}
          <button
            autoFocus={autoFocusConfirm && !inputLabel}
            type="button"
            className={`btn ${confirmVariant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            disabled={!canSubmit}
            onClick={() => void handleConfirm()}
          >
            {isSubmitting ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
