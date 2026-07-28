import React, { useCallback, useEffect, useRef, useState } from 'react';

interface SliderNumberInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Digits shown in the number box. Slider values are rounded to this precision. */
  decimals?: number;
  unit?: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: number) => void;
  /** Fired when a continuous drag/type gesture ends, so history can close the entry. */
  onCommit?: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatValue(value: number, decimals: number): string {
  return decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
}

/**
 * Range slider paired with an editable number box. The box keeps a local draft
 * while focused so partial entries ("-", "1" on the way to "180") stay typable,
 * and clamps to range on blur/Enter.
 */
export function SliderNumberInput({
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  unit,
  disabled = false,
  ariaLabel,
  onChange,
  onCommit,
}: SliderNumberInputProps) {
  const [draft, setDraft] = useState(() => formatValue(value, decimals));
  const isEditingRef = useRef(false);

  // Re-sync the box whenever the value moves from the outside (slider, undo,
  // preset switch, reset) while the user is not mid-edit.
  useEffect(() => {
    if (isEditingRef.current) return;
    setDraft(formatValue(value, decimals));
  }, [decimals, value]);

  const commitDraft = useCallback((raw: string) => {
    const parsed = Number(raw);
    const next = raw.trim() === '' || !Number.isFinite(parsed)
      ? value
      : roundTo(clamp(parsed, min, max), decimals);

    setDraft(formatValue(next, decimals));
    if (next !== value) onChange(next);
    onCommit?.();
  }, [decimals, max, min, onChange, onCommit, value]);

  const handleNumberChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    setDraft(raw);

    // Push through only fully-formed in-range numbers so the preview tracks
    // typing, while partial entries stay in the box until blur.
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    if (parsed < min || parsed > max) return;

    const next = roundTo(parsed, decimals);
    if (next !== value) onChange(next);
  }, [decimals, max, min, onChange, value]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft(event.currentTarget.value);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      isEditingRef.current = false;
      setDraft(formatValue(value, decimals));
      event.currentTarget.blur();
    }
  }, [commitDraft, decimals, value]);

  const numberInput = (
    <input
      type="number"
      className="slider-number-input"
      aria-label={`${ariaLabel} value`}
      inputMode="decimal"
      disabled={disabled}
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => { isEditingRef.current = true; }}
      onChange={handleNumberChange}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        isEditingRef.current = false;
        commitDraft(event.target.value);
      }}
    />
  );

  return (
    <div className="slider-number-field">
      <input
        type="range"
        aria-label={ariaLabel}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(roundTo(Number(event.target.value), decimals))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      {unit ? (
        <span className="number-unit-field slider-number-unit" data-unit={unit}>
          {numberInput}
        </span>
      ) : numberInput}
    </div>
  );
}
