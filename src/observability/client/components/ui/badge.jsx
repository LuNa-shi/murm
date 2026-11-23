import { cn } from '@/lib/utils';
import { normalizeState } from '../../../format.js';

const tones = {
  default: 'bg-primary text-primary-foreground',
  secondary: 'bg-secondary text-secondary-foreground',
  outline: 'border border-border text-muted-foreground',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300',
  warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300',
  danger: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300',
  info: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-300',
};

export function Badge({ children, variant = 'outline', className, ...props }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]', tones[variant] || tones.outline, className)} {...props}>{children}</span>;
}

export function StateBadge({ value }) {
  const state = String(value || 'UNKNOWN').toUpperCase();
  const variant = /FAILED|ERROR|FENCED|REJECTED|EXPIRED/.test(state) ? 'danger' : /WAITING|BLOCKED|PAUSED/.test(state) ? 'warning' : /RUNNING|ASSIGNED|ACTIVE/.test(state) ? 'info' : /SUCCEEDED|SATISFIED|DONE|COMPLETED/.test(state) ? 'success' : 'outline';
  return <Badge variant={variant}><span className={cn('h-1.5 w-1.5 rounded-full bg-current', /RUNNING|ASSIGNED/.test(state) && 'animate-pulse')} />{state.replaceAll('_', ' ')}</Badge>;
}

export function StateDot({ value, className }) {
  const state = normalizeState(value);
  return <span className={cn('h-2.5 w-2.5 rounded-full ring-4 ring-muted/60', `state-dot-${state}`, className)} aria-label={value || 'unknown'} />;
}
