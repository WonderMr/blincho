import { useI18n } from '../i18n/useI18n';
import { t, formatNumber, formatDate } from '../i18n/runtime';
import React, { useState, useEffect, useRef } from 'react';
import { CVS_SURVEY_QUESTIONS } from '../data/cvsQuestions';
import { CVSSurveyResult } from '../types';
import { loadCVSResult, saveCVSResult, getTodayDateString } from '../utils/storage';
import { HeartPulse, RefreshCw, ArrowRight, ShieldCheck } from 'lucide-react';

const GENERAL_RECOMMENDATIONS = [
  'Делайте регулярные перерывы: отводите взгляд от экрана и мягко полностью моргайте.',
  'Подберите удобное расстояние, размер текста и яркость; уменьшите блики и прямой поток воздуха в лицо.',
  'Если симптомы повторяются, мешают работе или сохраняются после отдыха, запланируйте очную проверку зрения. Низкая сумма ответов не исключает заболевание.',
];

// The sum records answer frequency only. There are no diagnostic cutoffs.
export function calculateSymptomResult(answers: Record<string, number>, date: string): CVSSurveyResult | null {
  const complete = CVS_SURVEY_QUESTIONS.every((question) =>
    question.options.some((option) => option.score === answers[question.id])
  );
  if (!complete) return null;

  return {
    score: CVS_SURVEY_QUESTIONS.reduce((sum, question) => sum + answers[question.id], 0),
    maxScore: CVS_SURVEY_QUESTIONS.reduce((sum, question) => sum + Math.max(...question.options.map((option) => option.score)), 0),
    level: 'self-check',
    title: "Самопроверка симптомов",
    recommendations: [...GENERAL_RECOMMENDATIONS],
    date,
    answers: Object.fromEntries(CVS_SURVEY_QUESTIONS.map(question => [question.id, answers[question.id]])),
  };
}

interface CVSSurveyProps {
  onResult?: (result: CVSSurveyResult) => void;
}

export const CVSSurvey: React.FC<CVSSurveyProps> = ({ onResult }) => {
  useI18n();
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<CVSSurveyResult | null>(() => {
    const existing = loadCVSResult();
    // Normalize display wording without rewriting a saved record merely by opening it.
    return existing ? {
      ...existing,
      level: 'self-check',
      title: "Самопроверка симптомов",
      recommendations: [...GENERAL_RECOMMENDATIONS],
    } : null;
  });
  const [saveError, setSaveError] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const firstQuestionRef = useRef<HTMLHeadingElement>(null);
  const focusTarget = useRef<'result' | 'question' | null>(null);

  useEffect(() => {
    if (result) onResult?.(result);
  }, [result, onResult]);

  useEffect(() => {
    if (!focusTarget.current) return;
    const target = focusTarget.current === 'result' ? resultRef.current : firstQuestionRef.current;
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      focusTarget.current = null;
    }
  }, [result]);

  const handleSelect = (questionId: string, score: number) => {
    setAnswers((prev) => ({ ...prev, [questionId]: score }));
  };

  const calculateResult = () => {
    const calculated = calculateSymptomResult(answers, getTodayDateString());
    if (!calculated) return;
    if (!saveCVSResult(calculated)) {
      setSaveError(true);
      return;
    }
    setSaveError(false);
    setJustSaved(true);
    focusTarget.current = 'result';
    setResult(calculated);
    setAnswers({});
  };

  const isComplete = CVS_SURVEY_QUESTIONS.every((question) =>
    question.options.some((option) => option.score === answers[question.id])
  );

  return (
    <section className="survey-view" aria-labelledby="survey-title">
      {/* Title Header */}
      <header className="view-header">
        <div className="view-eyebrow-row">
          <HeartPulse size={20} style={{ color: 'var(--accent-primary)' }} />
          <span className="section-eyebrow">{t("Самопроверка")}</span>
        </div>
        <h2 id="survey-title">{t("Как чувствуют себя глаза за экраном")}</h2>
        <p>{t("6 вопросов о самочувствии за последние 7 дней. Выберите, сколько дней возникало каждое ощущение. Если оно появлялось несколько раз за день, считайте этот день один раз. Если его не было, выберите «0 дней».")}</p>
        <details className="survey-about">
          <summary>{t("Об этой самопроверке")}</summary>
          <p>{t("Отметьте частоту ощущений за последние 7 дней. Это собственный опрос из шести вопросов, не валидированная шкала OSDI или CVS-Q. Сумма ответов от 0 до 18 помогает сохранить ваши отметки, но не определяет диагноз, риск заболевания или причину симптомов.")}</p>
        </details>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.84rem', marginTop: 10 }}>{t("При внезапном ухудшении зрения, сильной боли, болезненном красном глазе или боли от света обратитесь за срочной медицинской помощью.")}{' '}
          <a href="https://www.nhs.uk/symptoms/dry-eyes/" target="_blank" rel="noreferrer">{t("Когда нужна помощь")}</a>
        </p>
      </header>

      {/* Result Card if previously completed */}
      {result && (
        <div
          ref={resultRef}
          tabIndex={-1}
          role="region"
          aria-labelledby="survey-result-title"
          className="glass-card"
          style={{
            borderColor: 'var(--border-active)',
            background: 'var(--bg-card)',
            scrollMarginTop: 20,
          }}
        >
          <div className="survey-result-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <HeartPulse size={28} style={{ color: 'var(--accent-primary)' }} />
              <div>
                <h3 id="survey-result-title" style={{ fontSize: '1.25rem' }}>{justSaved ? t("Ответы сохранены") : t(result.title)}</h3>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t("Дата ответов: {value0}", { value0: formatDate(result.date) })}</div>
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{t("Сумма ответов")}</div>
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                {formatNumber(result.score)}
              </span>
              <span style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>/{formatNumber(result.maxScore)}</span>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14, marginTop: 10 }}>
            <h4 style={{ fontSize: '0.95rem', marginBottom: 12 }}>{t("Ваши ответы за последние 7 дней")}</h4>
            {result.answers ? (
              <dl style={{ display: 'grid', gap: 12, margin: 0 }}>
                {CVS_SURVEY_QUESTIONS.map(question => (
                  <div key={question.id}>
                    <dt style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{t(question.question)}</dt>
                    <dd style={{ margin: '4px 0 0', fontWeight: 600 }}>{t(question.options.find(option => option.score === result.answers![question.id])!.label)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{t("Подробные ответы для этого результата не сохранены. Пройдите опрос повторно, чтобы сохранить их.")}</p>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14, marginTop: 10 }}>
            <h4 style={{ fontSize: '0.95rem', marginBottom: 8, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <ShieldCheck size={16} /> {t("Привычки для комфорта:")}</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {result.recommendations.map((rec, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                  <span style={{ color: 'var(--status-success)', fontWeight: 800 }}>•</span>
                  <span>{t(rec)}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: '0.82rem', padding: '6px 14px' }}
              onClick={() => {
                focusTarget.current = 'question';
                setResult(null);
                setAnswers({});
                setSaveError(false);
                setJustSaved(false);
              }}
            >
              <RefreshCw size={14} /> {t("Пройти повторно")}</button>
          </div>
        </div>
      )}

      {/* Survey Questions Form */}
      {!result && (
        <form className="survey-questions" onSubmit={event => { event.preventDefault(); calculateResult(); }}>
          {/* Progress Header */}
          <div className="glass-card" style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem' }}>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{t("Ответы: {value0} из {value1}", { value0: Object.keys(answers).length, value1: CVS_SURVEY_QUESTIONS.length })}</span>
              <span style={{ color: 'var(--accent-primary)', fontWeight: 700 }}>
                {Math.round((Object.keys(answers).length / CVS_SURVEY_QUESTIONS.length) * 100)}%
              </span>
            </div>
            <div style={{ width: '100%', height: 6, background: 'var(--progress-track)', borderRadius: 4, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${(Object.keys(answers).length / CVS_SURVEY_QUESTIONS.length) * 100}%`,
                  background: 'linear-gradient(90deg, var(--accent-primary) 0%, var(--status-success) 100%)',
                  borderRadius: 4,
                  transition: 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
                }}
              />
            </div>
          </div>

          {CVS_SURVEY_QUESTIONS.map((q, idx) => {
            const isAnswered = answers[q.id] !== undefined;
            return (
              <div
                key={q.id}
                className="survey-question-card"
                style={{
                  borderColor: isAnswered ? 'var(--border-active)' : 'var(--border-subtle)',
                  background: isAnswered ? 'var(--status-success-bg)' : 'var(--surface-muted)',
                  transition: 'border-color 0.25s ease, background 0.25s ease'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: '50%',
                      background: isAnswered ? 'var(--status-success-bg)' : 'var(--status-info-bg)',
                      color: isAnswered ? 'var(--status-success)' : 'var(--accent-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      flexShrink: 0,
                      marginTop: 2,
                      transition: 'all 0.2s ease'
                    }}
                  >
                    {isAnswered ? '✓' : idx + 1}
                  </span>
                  <div style={{ flex: 1 }}>
                    <h4 ref={idx === 0 ? firstQuestionRef : undefined} tabIndex={-1} id={`survey-question-${q.id}`} style={{ fontSize: '1.02rem', marginBottom: 4, scrollMarginTop: 20 }}>{t(q.question)}</h4>
                    <p id={`survey-explanation-${q.id}`} style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t(q.explanation)}</p>
                  </div>
                </div>

                <div className="survey-options" role="group" aria-labelledby={`survey-question-${q.id}`} aria-describedby={`survey-explanation-${q.id}`}>
                  {q.options.map((opt) => (
                    <button
                      type="button"
                      key={opt.score}
                      className={`survey-radio-btn ${answers[q.id] === opt.score ? 'selected' : ''}`}
                      onClick={() => handleSelect(q.id, opt.score)}
                      aria-pressed={answers[q.id] === opt.score}
                    >
                      {t(opt.label)}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {saveError && (
            <p role="alert" style={{ color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 14 }}>
              {t("Не удалось сохранить ответы. Они остались в форме. Попробуйте ещё раз.")}
            </p>
          )}
          <button
            type="submit"
            className="btn btn-primary survey-submit"
            disabled={!isComplete}
            style={{
              padding: '12px 28px',
              fontSize: '0.98rem',
              opacity: isComplete ? 1 : 0.5,
              cursor: isComplete ? 'pointer' : 'not-allowed',
              alignSelf: 'center',
              boxShadow: isComplete ? '0 4px 20px var(--border-active)' : 'none'
            }}
          >
            {isComplete
              ? t("Сохранить ответы")
              : t("Ответьте ещё на {value0} вопр.", { value0: CVS_SURVEY_QUESTIONS.length - Object.keys(answers).length })}
            <ArrowRight size={18} />
          </button>
        </form>
      )}
    </section>
  );
};
