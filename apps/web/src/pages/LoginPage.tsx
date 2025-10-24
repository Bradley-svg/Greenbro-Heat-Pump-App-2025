import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Navigate, useNavigate } from 'react-router-dom';
import { brand } from '../brand';
import { useAuth } from '@app/providers/AuthProvider';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const { login, status } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      setFormError(null);
      await login(values);
      navigate('/overview', { replace: true });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : error instanceof Response && error.status === 401
            ? 'Invalid credentials'
            : 'Login failed';
      setFormError(message);
    }
  });

  if (status === 'authenticated') {
    return <Navigate to="/overview" replace />;
  }

  return (
    <div style={{ maxWidth: 420, margin: '80px auto', textAlign: 'center' }}>
      <img
        src={brand.logoWhite}
        alt={brand.name}
        className="logo"
        width={160}
        height={42}
        style={{ marginBottom: 12 }}
      />
      <h2 style={{ margin: '6px 0 16px' }}>Sign in to {brand.product}</h2>
      <h1>Industrial IoT Device Management</h1>
      <ul style={{ textAlign: 'left', margin: '18px 0', padding: 0, listStyle: 'none' }}>
        <li>
          <strong>Secure Device Access</strong> — role-based permissions and audit trails
        </li>
        <li>
          <strong>Live Vitals</strong> — real-time telemetry with instant alerts
        </li>
        <li>
          <strong>Role-Scoped Visibility</strong> — dashboards for administrators, clients, and contractors
        </li>
      </ul>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column' }}>
        <input
          aria-label="Email"
          placeholder="email"
          type="email"
          {...register('email')}
          style={{ width: '100%', margin: '6px 0' }}
        />
        {errors.email ? (
          <span className="auth-form__error" style={{ marginTop: -2 }}>
            {errors.email.message}
          </span>
        ) : null}
        <input
          aria-label="Password"
          placeholder="password"
          type="password"
          {...register('password')}
          style={{ width: '100%', margin: '6px 0' }}
        />
        {errors.password ? (
          <span className="auth-form__error" style={{ marginTop: -2 }}>
            {errors.password.message}
          </span>
        ) : null}
        {formError ? (
          <div className="auth-form__error auth-form__error--global" style={{ marginTop: 6 }}>
            {formError}
          </div>
        ) : null}
        <button
          className="btn btn-primary"
          type="submit"
          disabled={isSubmitting || status === 'loading'}
          style={{ width: '100%', marginTop: 8 }}
        >
          {isSubmitting || status === 'loading' ? 'Continuing…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
