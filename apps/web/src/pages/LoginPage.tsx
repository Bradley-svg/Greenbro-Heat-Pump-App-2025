import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Navigate, useNavigate } from 'react-router-dom';
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
      if (error instanceof Response) {
        setFormError(error.status === 401 ? 'Invalid credentials' : 'Login failed');
      } else {
        setFormError('Login failed');
      }
    }
  });

  if (status === 'authenticated') {
    return <Navigate to="/overview" replace />;
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>GreenBro Control Center</h1>
        <p className="auth-card__subtitle">Sign in to manage devices and alerts</p>
        <form onSubmit={onSubmit} className="auth-form">
          <label className="auth-form__field">
            <span>Email</span>
            <input type="email" placeholder="you@example.com" {...register('email')} />
            {errors.email ? <span className="auth-form__error">{errors.email.message}</span> : null}
          </label>
          <label className="auth-form__field">
            <span>Password</span>
            <input type="password" placeholder="••••••" {...register('password')} />
            {errors.password ? <span className="auth-form__error">{errors.password.message}</span> : null}
          </label>
          {formError ? <div className="auth-form__error auth-form__error--global">{formError}</div> : null}
          <button
            className="app-button app-button--primary primary-cta"
            type="submit"
            disabled={isSubmitting || status === 'loading'}
          >
            {isSubmitting || status === 'loading' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
