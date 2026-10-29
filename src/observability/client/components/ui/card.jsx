import { cn } from '@/lib/utils';

export function Card({ className, ...props }) { return <section className={cn('rounded-2xl border border-border/70 bg-card text-card-foreground shadow-sm', className)} {...props} />; }
export function CardHeader({ className, ...props }) { return <div className={cn('flex flex-col gap-1.5 border-b border-border/60 px-5 py-4 sm:px-6', className)} {...props} />; }
export function CardTitle({ className, ...props }) { return <h2 className={cn('text-sm font-semibold tracking-tight', className)} {...props} />; }
export function CardDescription({ className, ...props }) { return <p className={cn('text-xs leading-5 text-muted-foreground', className)} {...props} />; }
export function CardContent({ className, ...props }) { return <div className={cn('px-5 py-5 sm:px-6', className)} {...props} />; }
