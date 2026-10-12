import React, { useId } from 'react';
import { Languages, Monitor } from 'lucide-react';

export interface LanguageOption {
  code: string;
  nativeName: string;
  name?: string;
  dir?: 'ltr' | 'rtl';
}

interface LanguagePickerProps {
  value: string;
  languages: ReadonlyArray<LanguageOption>;
  onChange: (code: string) => void;
  labels: {
    label: string;
    description: string;
    automaticLabel: string;
    detectedLabel?: string;
  };
  detectedLanguage?: string;
}

/** A controlled native select keeps all language choices available to keyboard users. */
export const LanguagePicker: React.FC<LanguagePickerProps> = ({
  value, languages, onChange, labels, detectedLanguage,
}) => {
  const id = useId();
  const detected = languages.find(language => language.code === detectedLanguage);
  const selected = languages.find(language => language.code === value);

  return (
    <div className="language-picker">
      <div className="language-picker-heading">
        <span className="language-picker-symbol" aria-hidden="true"><Languages size={22} /></span>
        <div className="language-picker-copy">
          <label htmlFor={id}>{labels.label}</label>
          <p id={`${id}-description`}>{labels.description}</p>
        </div>
      </div>
      <div className="language-picker-field">
        <select id={id} className="form-control language-select" value={value}
          aria-describedby={`${id}-description${detected && labels.detectedLabel ? ` ${id}-detected` : ''}`}
          onChange={event => onChange(event.target.value)}
          lang={selected?.code}>
          <option value="auto">{labels.automaticLabel}</option>
          {languages.map(language => (
            <option key={language.code} value={language.code} lang={language.code} dir={language.dir}>
              {language.nativeName}{language.name && language.name !== language.nativeName ? ` · ${language.name}` : ''}
            </option>
          ))}
        </select>
        {detected && labels.detectedLabel && (
          <p className="language-picker-detected" id={`${id}-detected`}>
            <Monitor size={14} aria-hidden="true" />
            <span>{labels.detectedLabel} <bdi lang={detected.code} dir={detected.dir}>{detected.nativeName}</bdi></span>
          </p>
        )}
      </div>
    </div>
  );
};
