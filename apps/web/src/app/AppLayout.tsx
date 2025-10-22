import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './providers/AuthProvider';
import { ROUTE_ROLES } from '@utils/rbac';
import type { Role } from '@utils/types';
import { useReadOnly } from '@hooks/useReadOnly';

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
];

export function AppLayout(): JSX.Element {
  const { user, logout, status } = useAuth();
  const { ro, canToggle, toggle, isPending } = useReadOnly();

  const permittedNav = NAV_ITEMS.filter((item) => hasAnyRole(user?.roles ?? [], ROUTE_ROLES[item.roleKey]));
  const allowToggle = Boolean(user?.roles.includes('admin')) && canToggle;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <span className="logo">GB</span>
          <span className="brand">GreenBro</span>
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
          <div className="app-topbar__title">{status === 'authenticated' ? 'Control Center' : 'Loading…'}</div>
          <div className="app-topbar__actions">
            <ReadOnlyPill
              readOnly={ro}
              onToggle={allowToggle ? toggle : undefined}
              disabled={isPending}
            />
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
