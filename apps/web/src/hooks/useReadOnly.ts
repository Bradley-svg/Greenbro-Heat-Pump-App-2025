import { useEffect, useState } from 'react';
import { authFetch } from '@api/client';

export function useReadOnly() {
  const [ro, setRo] = useState(false);
  const [canToggle, setCanToggle] = useState(false);

  const load = async () => {
    try {
      const pub = await fetch('/api/settings/public')
        .then((r) => r.json())
        .catch(() => ({ read_only: false }));
      setRo(Boolean(pub.read_only));
    } catch {
      setRo(false);
    }
    try {
      const response = await authFetch('/api/admin/settings');
      setCanToggle(response.ok);
    } catch {
      setCanToggle(false);
    }
  };

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      void load();
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const toggle = async () => {
    const value = ro ? '0' : '1';
    await authFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'read_only', value }),
    });
    await load();
  };

  return { ro, canToggle, toggle };
}
