import type { Role } from './types';

export const ALL_ROLES: Role[] = ['admin', 'ops', 'client', 'contractor'];

export const ROUTE_ROLES = {
  overview: ALL_ROLES,
  compactOverview: ['admin', 'ops', 'contractor'] satisfies Role[],
  devices: ['admin', 'ops', 'client'] satisfies Role[],
  deviceDetail: ['admin', 'ops', 'client'] satisfies Role[],
  alerts: ['admin', 'ops'] satisfies Role[],
  commissioning: ['admin', 'contractor'] satisfies Role[],
  ops: ['admin', 'ops'] satisfies Role[],
  admin: ['admin'] satisfies Role[],
} as const;

type RouteKey = keyof typeof ROUTE_ROLES;

export function canAccess(roleKey: RouteKey, userRoles: Role[]): boolean {
  const allowed = ROUTE_ROLES[roleKey];
  return allowed.some((role) => userRoles.includes(role));
}
