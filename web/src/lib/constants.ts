import { msg, t } from './i18n';

// Labels are English source strings; call the getters at render time so the current language applies.
export const PROFILE_KINDS = [
  { kind: 'smoke', label: msg('Smoke test'), desc: msg('Short check with 1-2 users. Does the flow work?') },
  { kind: 'constant_vus', label: msg('Constant users'), desc: msg('A fixed number of concurrent users for a fixed time.') },
  { kind: 'constant_rate', label: msg('Constant rate'), desc: msg('Starts N user flows per second (the rate holds even if the system slows down).') },
  { kind: 'ramp', label: msg('Ramp-up'), desc: msg('Slowly raises users, holds, then ramps down.') },
  { kind: 'stress', label: msg('Stress'), desc: msg('Steps above the target to show where it breaks.') },
  { kind: 'spike', label: msg('Spike'), desc: msg('A sudden surge like a campaign launch, then recovery.') },
  { kind: 'soak', label: msg('Soak'), desc: msg('Steady load for a long time: memory leaks, slowdowns.') },
  { kind: 'breakpoint', label: msg('Breakpoint'), desc: msg('Keeps raising the rate; stops when the p95 or error threshold is exceeded and reports capacity.') },
] as const;

const PROFILE_LABELS_EN: Record<string, string> = {
  ...Object.fromEntries(PROFILE_KINDS.map((p) => [p.kind, p.label])),
  debug: msg('Debug run'),
};

export const profileLabel = (kind: string) => (PROFILE_LABELS_EN[kind] ? t(PROFILE_LABELS_EN[kind]) : kind);

const STATUS_LABELS_EN: Record<string, string> = {
  queued: msg('Queued'),
  starting: msg('Starting'),
  running: msg('Running'),
  stopping: msg('Stopping'),
  completed: msg('Completed'),
  stopped: msg('Stopped'),
  failed: msg('Failed'),
  canceled: msg('Canceled'),
  draft: msg('Draft'),
  ready: msg('Ready'),
  active: msg('Active'),
  archived: msg('Archived'),
};

export const statusLabel = (s: string) => (STATUS_LABELS_EN[s] ? t(STATUS_LABELS_EN[s]) : s);

export const ACTIVE_STATUSES = ['queued', 'starting', 'running', 'stopping'];

const SOURCE_LABELS_EN: Record<string, string> = { panel: msg('Panel'), mcp: msg('MCP'), har: msg('HAR'), schedule: msg('Scheduler') };
export const sourceLabel = (s: string) => (SOURCE_LABELS_EN[s] ? t(SOURCE_LABELS_EN[s]) : s);
