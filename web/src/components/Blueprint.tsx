import type { CSSProperties, ReactNode } from 'react';

interface Props {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

// The design system's wireframe frame: hairline box with registration marks at the corners.
export function Blueprint({ children, className = '', style }: Props) {
  return (
    <div className={`blueprint ${className}`} style={style}>
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      {children}
    </div>
  );
}
