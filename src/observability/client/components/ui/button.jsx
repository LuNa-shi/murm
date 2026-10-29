import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

const variants = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-border bg-background shadow-sm hover:bg-muted',
  ghost: 'hover:bg-muted hover:text-foreground',
  destructive: 'bg-destructive text-white shadow-sm hover:bg-destructive/90',
  link: 'text-primary underline-offset-4 hover:underline',
};

const sizes = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 rounded-md px-3 text-xs',
  lg: 'h-10 rounded-md px-6',
  icon: 'h-9 w-9',
};

export const Button = forwardRef(function Button({ className, variant = 'default', size = 'default', ...props }, ref) {
  return <button ref={ref} className={cn('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50', variants[variant] || variants.default, sizes[size] || sizes.default, className)} {...props} />;
});
