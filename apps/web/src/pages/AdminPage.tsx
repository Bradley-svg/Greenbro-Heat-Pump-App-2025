import { useAuth } from '@app/providers/AuthProvider';
import { ROUTE_ROLES } from '@utils/rbac';
import type { Role } from '@utils/types';

export function AdminPage(): JSX.Element {
  const { user, refresh, logout } = useAuth();

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Admin</h2>
          <p className="page__subtitle">Review session state and RBAC</p>
        </div>
      </header>
      <section className="card">
        <h3>Current user</h3>
        {user ? (
          <ul className="kv-list">
            <li>
              <span>Email</span>
              <span>{user.email}</span>
            </li>
            {user.name ? (
              <li>
                <span>Name</span>
                <span>{user.name}</span>
              </li>
            ) : null}
            <li>
              <span>Roles</span>
              <span>{user.roles.join(', ')}</span>
            </li>
            {user.clientIds ? (
              <li>
                <span>Clients</span>
                <span>{user.clientIds.join(', ')}</span>
              </li>
            ) : null}
          </ul>
        ) : (
          <p>No user loaded.</p>
        )}
        <div className="button-row">
          <button className="app-button" type="button" onClick={() => void refresh()}>
            Refresh token
          </button>
          <button className="app-button" type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </section>
      <section className="card">
        <h3>Route access matrix</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Route</th>
              {ROUTE_ROLES.overview.map((role) => (
                <th key={role}>{role}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(ROUTE_ROLES).map(([route, roles]) => {
              const allowed = new Set<Role>(roles as Role[]);
              return (
                <tr key={route}>
                  <td>{route}</td>
                  {ROUTE_ROLES.overview.map((role) => (
                    <td key={`${route}-${role}`}>{allowed.has(role) ? '✓' : '—'}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
