export type ExerciseCategory =
  | 'ciliary'       // Focus & Accommodation spasm relief
  | 'dry-eye'       // Meibomian & Blink training
  | 'extraocular'   // Eye muscle mobility & saccades
  | 'relaxation';   // Palming & sensory deprivation

export interface ExerciseStep {
  instruction: string;
  durationSeconds: number;
  visualMode: 'dot-figure8' | 'dot-circle' | 'dot-saccades' | 'near-far' | 'blink' | 'palming' | 'zen-horizon';
  direction?: 1 | -1;
  path?: 'horizontal' | 'vertical' | 'diagonal';
  focus?: 'near' | 'far';
}

export interface ExerciseTechnique {
  id: string;
  title: string;
  shortDesc: string;
  category: ExerciseCategory;
  categoryLabel: string;
  badgeClass: string;
  durationSeconds: number;
  scientificReference: string;
  clinicalMechanism: string;
  steps: ExerciseStep[];
  indications: string[];
}

export type TimerPreset = '20-20-20' | 'pomodoro' | 'custom';
export type AppearanceMode = 'system' | 'light' | 'dark';
export type ColorPalette = 'sage' | 'ocean' | 'lavender';

export interface AppSettings {
  timerPreset: TimerPreset;
  workMinutes: number;
  breakSeconds: number;
  soundEnabled: boolean;
  soundVolume: number;
  notificationsEnabled: boolean;
  autoTakeoverModal: boolean;
  theme: AppearanceMode;
  colorPalette: ColorPalette;
  idleDetectionEnabled: boolean;
  idleAction: 'pause' | 'reset';
  idleThresholdMinutes: number;
  strictModeIgnoreIdle: boolean;
  meetingDetectionEnabled: boolean;
  meetingHistoryEnabled: boolean;
  cameraLockEnabled: boolean;
  localMcpEnabled: boolean;
  strictMode: boolean;
}

export type ActivityState = 'work' | 'idle' | 'locked' | 'suspended' | 'hidden' | 'unconfirmed' | 'manual' | 'break' | 'exercise';

export interface ActivitySpan {
  start: number;
  end: number;
  state: ActivityState;
}

export interface MeetingSpan {
  start: number;
  end: number;
  app: string;
}

export interface DayStats {
  date: string; // YYYY-MM-DD
  breaksCompleted: number;
  exercisesCompleted: number;
  focusMinutes: number;
  techniqueCounts?: Record<string, number>;
  completedEventIds?: string[];
  // Older aggregate-only history has no timeline and remains readable.
  activity?: ActivitySpan[];
  // Missing in history recorded before meeting observations were introduced.
  meetings?: MeetingSpan[];
}

export interface CVSSurveyQuestion {
  id: string;
  question: string;
  explanation: string;
  options: { label: string; score: number }[];
}

export interface CVSSurveyResult {
  score: number;
  maxScore: number;
  level: 'minimal' | 'moderate' | 'high' | 'severe' | 'self-check';
  title: string;
  recommendations: string[];
  date: string;
  // Optional so records saved before detailed answers were introduced remain readable.
  answers?: Record<string, number>;
}
