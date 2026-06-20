// ui.tsx — icons + shared primitives for EU-DSS Sign
import React from 'react';

/* ---------------- Icons (simple line glyphs) ---------------- */

interface IcProps {
  size?: number;
  fill?: string;
  sw?: number;
  vb?: number;
  d?: string;
  children?: React.ReactNode;
}

function Ic({ d, size = 18, fill, sw = 1.8, children, vb = 24 }: IcProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vb} ${vb}`}
      fill={fill || 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

export interface IconProps {
  size?: number;
  fill?: string;
  sw?: number;
}

export const Icon: Record<string, (p: IconProps) => React.ReactElement> = {
  sign:       (p) => <Ic {...p} d="M3 17.5c2-.5 3-2 4-4s2-5 3-5 1 3 2 3 1.5-2 2.5-2 2 4 3 4 2-.5 2.5-1" />,
  shield:     (p) => <Ic {...p} d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />,
  shieldCheck:(p) => <Ic {...p}><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 11.5l2 2 4-4"/></Ic>,
  check:      (p) => <Ic {...p} d="M5 12.5l4.5 4.5L19 7" />,
  checkCircle:(p) => <Ic {...p}><circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.3 2.3L16 9"/></Ic>,
  x:          (p) => <Ic {...p} d="M6 6l12 12M18 6L6 18" />,
  lock:       (p) => <Ic {...p}><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></Ic>,
  unlock:     (p) => <Ic {...p}><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/></Ic>,
  usb:        (p) => <Ic {...p}><path d="M12 21V6"/><path d="M9 9l3-3 3 3"/><circle cx="12" cy="22" r="0.5" fill="currentColor"/><path d="M12 14l-3.5-2v-2M12 16l3.5-2v-2"/><rect x="10.5" y="9" width="3" height="3" rx=".5"/></Ic>,
  file:       (p) => <Ic {...p}><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5"/></Ic>,
  fileCheck:  (p) => <Ic {...p}><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5"/><path d="M9 15l2 2 4-4"/></Ic>,
  upload:     (p) => <Ic {...p}><path d="M12 16V5"/><path d="M8 9l4-4 4 4"/><path d="M5 16v2a2 2 0 002 2h10a2 2 0 002-2v-2"/></Ic>,
  download:   (p) => <Ic {...p}><path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></Ic>,
  refresh:    (p) => <Ic {...p}><path d="M20 11a8 8 0 10-2 5.3"/><path d="M20 5v5h-5"/></Ic>,
  alert:      (p) => <Ic {...p}><path d="M12 8v5"/><circle cx="12" cy="16.5" r=".4" fill="currentColor"/><path d="M10.3 4.3l-7 12A1.9 1.9 0 005 19.2h14a1.9 1.9 0 001.7-2.9l-7-12a1.9 1.9 0 00-3.4 0z"/></Ic>,
  chevR:      (p) => <Ic {...p} d="M9 6l6 6-6 6" />,
  clock:      (p) => <Ic {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></Ic>,
  card:       (p) => <Ic {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></Ic>,
  key:        (p) => <Ic {...p}><circle cx="8" cy="14" r="3.5"/><path d="M10.5 11.5L20 2M17 5l2 2M14 8l1.8 1.8"/></Ic>,
  euro:       (p) => <Ic {...p}><path d="M16 7a6 6 0 100 10"/><path d="M5 10h7M5 14h7"/></Ic>,
  doc2:       (p) => <Ic {...p}><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></Ic>,
};

/* ---------------- Primitives ---------------- */

export interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'soft' | 'danger-ghost';
  size?: 'lg' | 'sm';
  icon?: React.ReactNode;
  iconR?: React.ReactNode;
}

export function Btn({ variant = 'primary', size, icon, iconR, children, className, ...rest }: BtnProps & { className?: string }) {
  const cls = [`btn`, `btn-${variant}`, size ? `btn-${size}` : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button className={cls} {...rest}>
      {icon}{children}{iconR}
    </button>
  );
}

export interface TrustBadgeProps {
  kind?: 'default' | 'solid' | 'ok';
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

export function TrustBadge({ kind = 'default', icon, children }: TrustBadgeProps) {
  const cls = ['tbadge', kind !== 'default' ? kind : ''].filter(Boolean).join(' ');
  return (
    <span className={cls}>
      {icon && <span className="gi">{icon}</span>}
      {children}
    </span>
  );
}

export interface TagProps {
  kind?: '' | 'ok' | 'brand' | 'warn';
  children?: React.ReactNode;
}

export function Tag({ kind = '', children }: TagProps) {
  return <span className={`tag ${kind}`}>{children}</span>;
}

export interface CardProps {
  no?: string | number;
  title?: React.ReactNode;
  desc?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}

export function Card({ no, title, desc, action, children }: CardProps) {
  return (
    <section className="card">
      {(title || no) && (
        <div className="card-h">
          {no !== undefined && <div className="step-no">{no}</div>}
          <div className="hh">
            {title && <h2>{title}</h2>}
            {desc && <p>{desc}</p>}
          </div>
          {action && <div style={{ marginLeft: 'auto', flexShrink: 0 }}>{action}</div>}
        </div>
      )}
      <div className="card-b">{children}</div>
    </section>
  );
}

export interface BannerProps {
  kind?: 'warn' | 'ok' | 'info' | 'danger';
  icon?: React.ReactNode;
  title?: React.ReactNode;
  children?: React.ReactNode;
  links?: React.ReactNode;
}

export function Banner({ kind = 'info', icon, title, children, links }: BannerProps) {
  return (
    <div className={`banner ${kind}`}>
      <span className="bi">{icon}</span>
      <div style={{ flex: 1 }}>
        {title && <div><b>{title}</b></div>}
        <div style={{ marginTop: title ? 3 : 0 }}>{children}</div>
        {links && <div className="links">{links}</div>}
      </div>
    </div>
  );
}

export interface CertItem {
  k: React.ReactNode;
  v: React.ReactNode;
  mono?: boolean;
}

export interface CertGridProps {
  items: CertItem[];
}

export function CertGrid({ items }: CertGridProps) {
  return (
    <div className="cert">
      {items.map((it, i) => (
        <div className="ci" key={i}>
          <div className="k">{it.k}</div>
          <div className={'v' + (it.mono ? ' mono' : '')}>{it.v}</div>
        </div>
      ))}
    </div>
  );
}

export interface FileKindResult {
  ext: string;
  target: string;
  asic: boolean;
}

// extension -> {ext, target format, asic}
export function fileKind(name: string): FileKindResult {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return { ext: 'PDF', target: 'PAdES-BASELINE-T', asic: false };
  return { ext: ext.toUpperCase().slice(0, 4) || 'DOC', target: 'ASiC-E (.asice)', asic: true };
}
