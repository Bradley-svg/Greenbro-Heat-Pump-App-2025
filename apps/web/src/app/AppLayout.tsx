import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { brand } from '../brand';
import { useAuth } from './providers/AuthProvider';
import { useToast } from './providers/ToastProvider';
import { ROUTE_ROLES } from '@utils/rbac';
import type { Role } from '@utils/types';
import { useReadOnly } from '@hooks/useReadOnly';
import { useDeployRibbon } from '@hooks/useDeployRibbon';
import { useVersion } from '@hooks/useVersion';
import { AboutModal } from '@/components/AboutModal';

interface NavItem {
  to: string;
  label: string;
  roleKey: keyof typeof ROUTE_ROLES;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/overview', label: 'Overview', roleKey: 'overview' },
  { to: '/devices', label: 'Devices', roleKey: 'devices' },
  { to: '/alerts', label: 'Alerts', roleKey: 'alerts' },
  { to: '/commissioning', label: 'Commissioning', roleKey: 'commissioning' },
  { to: '/ops', label: 'Ops', roleKey: 'ops' },
  { to: '/admin', label: 'Admin', roleKey: 'admin' },
  { to: '/admin/archive', label: 'Archive', roleKey: 'admin' },
];

export function AppLayout(): JSX.Element {
  const { user, logout, status } = useAuth();
  const { ro, canToggle, toggle } = useReadOnly();
  const toast = useToast();
  const { deploy, dismiss } = useDeployRibbon();
  const { data: version } = useVersion();
  const [aboutOpen, setAboutOpen] = useState(false);

  const permittedNav = NAV_ITEMS.filter((item) => hasAnyRole(user?.roles ?? [], ROUTE_ROLES[item.roleKey]));
  const allowToggle = Boolean(user?.roles.includes('admin')) && canToggle;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <img className="logo" src={brand.logoWhite} alt={brand.name} width={40} height={40} />
          <span className="brand">{brand.nameCaps}</span>
        </div>
        <nav className="app-nav">
          {permittedNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `app-nav__link${isActive ? ' app-nav__link--active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <div className="app-topbar__title">{status === 'authenticated' ? brand.product : 'Loading…'}</div>
          <div className="app-topbar__actions">
            <ReadOnlyPill readOnly={ro} onToggle={allowToggle ? toggle : undefined} />
            <label className="app-topbar__mute">
              <input
                data-testid="toast-mute"
                type="checkbox"
                checked={toast.muted}
                onChange={(event) => toast.setMuted(event.target.checked)}
                aria-label="Mute notifications"
              />
              Mute notifications
            </label>
            {deploy ? (
              <div
                className={`deploy-chip ${deploy.color}`}
                role="status"
                aria-label={`Deployment: ${deploy.color}${deploy.msg ? ` — ${deploy.msg}` : ''}`}
              >
                <span className="dot" aria-hidden="true" />
                <span className="txt">
                  Deployment: <strong className="cap">{deploy.color}</strong>
                  {deploy.msg ? <span className="sub"> — {deploy.msg}</span> : null}
                </span>
                <button className="x" aria-label="Dismiss readiness banner" onClick={dismiss} type="button">
                  ×
                </button>
              </div>
            ) : null}
            {version ? (
              <div
                className="ver-chip-spa"
                title={`Build ${version.build_sha}${version.build_date ? ` • ${version.build_date}` : ''}`}
              >
                <span className="mono">{version.build_sha.slice(0, 7)}</span>
                {version.build_date ? <span className="muted"> · {version.build_date}</span> : null}
                {version.schema_ok === false ? <span className="warn"> · schema?</span> : null}
              </div>
            ) : null}
            <button
              className="icon-btn"
              type="button"
              aria-label={`About ${brand.product}`}
              onClick={() => setAboutOpen(true)}
            >
              ?
            </button>
            <div className="app-topbar__account">
              {user ? (
                <>
                  <div className="app-topbar__user">
                    <span className="app-topbar__user-name">{user.name ?? user.email}</span>
                    <span className="app-topbar__user-roles">{user.roles.join(', ')}</span>
                  </div>
                  <button className="app-button" onClick={() => void logout()} type="button">
                    Log out
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </header>
        <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function hasAnyRole(userRoles: Role[], allowed: readonly Role[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((role) => userRoles.includes(role));
}

interface ReadOnlyPillProps {
  readOnly: boolean;
  onToggle?: () => void;
  disabled?: boolean;
}

function ReadOnlyPill({ readOnly, onToggle, disabled }: ReadOnlyPillProps): JSX.Element {
  const label = readOnly ? 'READ-ONLY' : 'READ/WRITE';
  const className = `ro-pill ${readOnly ? 'ro-pill--locked' : 'ro-pill--unlocked'}${onToggle ? ' ro-pill--interactive' : ''}`;

  if (onToggle) {
    return (
      <button className={className} type="button" onClick={onToggle} disabled={disabled}>
        {label}
      </button>
    );
  }

  return <span className={className}>{label}</span>;
}
