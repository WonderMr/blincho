import { CVSSurveyQuestion } from '../types';

// An original symptom log. It is not OSDI, CVS-Q, or a validated diagnostic scale.
const FREQUENCY_OPTIONS = [
  { label: '0 дней', score: 0 },
  { label: '1–2 дня', score: 1 },
  { label: '3–4 дня', score: 2 },
  { label: '5–7 дней', score: 3 },
];

export const CVS_SURVEY_QUESTIONS: CVSSurveyQuestion[] = [
  {
    id: 'dryness',
    question: 'Сколько дней вы замечали сухость, жжение или ощущение «песка» в глазах?',
    explanation: 'За последние 7 дней.',
    options: FREQUENCY_OPTIONS,
  },
  {
    id: 'blurriness',
    question: 'Сколько дней текст или дальние предметы выглядели нечётко во время работы за экраном или после неё?',
    explanation: 'За последние 7 дней.',
    options: FREQUENCY_OPTIONS,
  },
  {
    id: 'headache',
    question: 'Сколько дней после работы за экраном у вас болела голова?',
    explanation: 'За последние 7 дней.',
    options: FREQUENCY_OPTIONS,
  },
  {
    id: 'redness',
    question: 'Сколько дней вы замечали покраснение или раздражение глаз?',
    explanation: 'За последние 7 дней.',
    options: FREQUENCY_OPTIONS,
  },
  {
    id: 'neck_shoulder',
    question: 'Сколько дней во время работы за экраном вы чувствовали скованность или дискомфорт в шее и плечах?',
    explanation: 'За последние 7 дней.',
    options: FREQUENCY_OPTIONS,
  },
  {
    id: 'light_sensitivity',
    question: 'Сколько дней свет экрана или ламп казался вам неприятно ярким?',
    explanation: 'За последние 7 дней. Не учитывайте обычную настройку яркости экрана.',
    options: FREQUENCY_OPTIONS,
  },
];
