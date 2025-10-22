export type Role = 'admin' | 'ops' | 'client' | 'contractor';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface User {
  id: string;
  email: string;
  name?: string;
  roles: Role[];
  clientIds?: string[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface AuthSession {
  user: User;
  tokens: AuthTokens;
}
