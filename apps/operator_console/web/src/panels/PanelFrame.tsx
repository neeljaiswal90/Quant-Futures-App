import type { ReactElement, ReactNode } from 'react';

export function PanelFrame({
  title,
  meta,
  children,
  className,
}: {
  readonly title: string;
  readonly meta?: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <section className={`panel-frame${className === undefined ? '' : ` ${className}`}`} aria-label={title}>
      <div className="panel-heading">
        <h2>{title}</h2>
        {meta === undefined ? null : <span>{meta}</span>}
      </div>
      {children}
    </section>
  );
}

export function MetricRow({
  label,
  value,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'neutral' | 'good' | 'warn' | 'bad';
}): ReactElement {
  return (
    <div className="metric-row">
      <span>{label}</span>
      <strong className={`metric-value metric-value-${tone}`}>{value}</strong>
    </div>
  );
}

export function EmptyState({ children }: { readonly children: ReactNode }): ReactElement {
  return <p className="empty-state">{children}</p>;
}

export function StatusDot({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: 'neutral' | 'good' | 'warn' | 'bad';
}): ReactElement {
  return (
    <span className={`status-dot status-dot-${tone}`}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

export function toneForAvailability(status: 'available' | 'unavailable'): 'good' | 'warn' {
  return status === 'available' ? 'good' : 'warn';
}
