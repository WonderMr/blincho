import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface HistoryDatePickerProps {
  value: string;
  dates: string[];
  label: string;
  formatLabel: (date: string) => string;
  onChange: (date: string) => void;
}

/** Keep history choices in the WebView so no system popup is needed. */
export const HistoryDatePicker: React.FC<HistoryDatePickerProps> = ({ value, dates, label, formatLabel, onChange }) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const choices = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };

  useEffect(() => {
    if (!open) return;
    selected.current?.focus({ preventScroll: true });
    choices.current?.scrollIntoView?.({ block: 'nearest' });
    selected.current?.scrollIntoView?.({ block: 'nearest' });
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [open]);

  return <div className="statistics-date-picker" ref={container} data-no-drag
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <span id={`${id}-label`}>{label}</span>
    <button ref={trigger} type="button" className="statistics-date-trigger" aria-expanded={open}
      aria-controls={`${id}-choices`} aria-labelledby={`${id}-label ${id}-value`} onClick={() => setOpen(value => !value)}>
      <span id={`${id}-value`}>{formatLabel(value)}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && <div ref={choices} id={`${id}-choices`} className="statistics-date-choices" role="group" aria-labelledby={`${id}-label`}>
      {dates.map(date => <button key={date} ref={date === value ? selected : undefined} type="button"
        data-date={date} aria-pressed={date === value} aria-controls="daily-activity-detail"
        onClick={() => { onChange(date); close(); }}>{formatLabel(date)}</button>)}
    </div>}
  </div>;
};
