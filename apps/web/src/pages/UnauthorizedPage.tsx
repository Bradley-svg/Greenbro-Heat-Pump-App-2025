import { Link } from 'react-router-dom';

export function UnauthorizedPage(): JSX.Element {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Access denied</h1>
        <p className="auth-card__subtitle">You do not have permission to view that page.</p>
        <Link to="/overview" className="app-button app-button--primary">
          Back to overview
        </Link>
      </div>
    </div>
  );
}
