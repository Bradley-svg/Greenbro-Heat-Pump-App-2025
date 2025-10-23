import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { useAuth } from './providers/AuthProvider';
import { FullScreenLoader } from '@components/FullScreenLoader';
import { ROUTE_ROLES } from '@utils/rbac';
import type { Role } from '@utils/types';
import { LoginPage } from '@pages/LoginPage';
import OverviewPage from '@pages/overview/OverviewPage';
import CompactDashboard from '@pages/overview/CompactDashboard';
import { DevicesPage } from '@pages/DevicesPage';
import { DeviceDetailPage } from '@pages/DeviceDetailPage';
import { AlertsPage } from '@pages/AlertsPage';
import { CommissioningPage } from '@pages/CommissioningPage';
import OpsPage from '@pages/ops/OpsPage';
import { AdminPage } from '@pages/AdminPage';
import { UnauthorizedPage } from '@pages/UnauthorizedPage';
import { AdminArchivePage } from '@pages/AdminArchivePage';

export function AppRouter(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/unauthorized" element={<UnauthorizedPage />} />
        <Route path="/" element={<ProtectedApp />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route
            path="overview"
            element={
              <RoleGuard roles={ROUTE_ROLES.overview}>
                <OverviewPage />
              </RoleGuard>
            }
          />
          <Route
            path="m"
            element={
              <RoleGuard roles={ROUTE_ROLES.compactOverview}>
                <CompactDashboard />
              </RoleGuard>
            }
          />
          <Route
            path="devices"
            element={
              <RoleGuard roles={ROUTE_ROLES.devices}>
                <DevicesPage />
              </RoleGuard>
            }
          />
          <Route
            path="devices/:deviceId"
            element={
              <RoleGuard roles={ROUTE_ROLES.deviceDetail}>
                <DeviceDetailPage />
              </RoleGuard>
            }
          />
          <Route
            path="alerts"
            element={
              <RoleGuard roles={ROUTE_ROLES.alerts}>
                <AlertsPage />
              </RoleGuard>
            }
          />
          <Route
            path="commissioning"
            element={
              <RoleGuard roles={ROUTE_ROLES.commissioning}>
                <CommissioningPage />
              </RoleGuard>
            }
          />
          <Route
            path="ops"
            element={
              <RoleGuard roles={ROUTE_ROLES.ops}>
                <OpsPage />
              </RoleGuard>
            }
          />
          <Route
            path="admin"
            element={
              <RoleGuard roles={ROUTE_ROLES.admin}>
                <Outlet />
              </RoleGuard>
            }
          >
            <Route index element={<AdminPage />} />
            <Route path="archive" element={<AdminArchivePage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function ProtectedApp(): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') {
    return <FullScreenLoader />;
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }
  return <AppLayout />;
}

function RoleGuard({ roles, children }: { roles: readonly Role[]; children: ReactNode }): JSX.Element {
  const { user, status } = useAuth();

  if (status === 'loading') {
    return <FullScreenLoader />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (roles.length > 0 && !roles.some((role) => user.roles.includes(role))) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
}
