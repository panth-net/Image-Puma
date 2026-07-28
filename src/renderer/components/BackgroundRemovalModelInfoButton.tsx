import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { ModalDialog } from './ModalDialog';

const MODEL_ACCESS_DESCRIPTION = [
  'Image Puma includes BRIA RMBG-2.0 for noncommercial use.',
  'Before using background removal, review the model terms and confirm access with your own Hugging Face account.',
  'Image Puma never asks for or stores your Hugging Face token.',
].join(' ');

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

export function BackgroundRemovalModelInfoButton() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const openModelPage = async () => {
    try {
      await api.openRmbgModelPage();
      close();
    } catch (openError) {
      const message = openError instanceof Error ? openError.message : String(openError);
      setError(`Could not open Hugging Face: ${message}`);
    }
  };

  return (
    <>
      <button
        type="button"
        className="background-model-info-button"
        aria-label="View RMBG-2.0 license and access details"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip="RMBG-2.0 license and access"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <EyeIcon />
      </button>
      {open && createPortal(
        <ModalDialog
          open
          title="RMBG-2.0 terms and access"
          description={MODEL_ACCESS_DESCRIPTION}
          error={error}
          confirmLabel="Review terms on Hugging Face"
          cancelLabel="Close"
          autoFocusConfirm
          onConfirm={openModelPage}
          onCancel={close}
        />,
        document.body,
      )}
    </>
  );
}
