import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/api/http';

const StepUpdate = z.object({
  session_id: z.string(),
  step_id: z.string(),
  state: z.enum(['pending', 'pass', 'fail', 'skip']),
  readings: z.record(z.any()).optional(),
  comment: z.string().optional(),
});

export default function CommissioningPage(): JSX.Element {
  const qc = useQueryClient();

  const { data: checklists } = useQuery({
    queryKey: ['comm:lists'],
    queryFn: () => api.get('/api/commissioning/checklists').then((r) => r.json()),
  });

  const create = useMutation({
    mutationFn: (payload: any) => api.post('/api/commissioning/start', payload).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comm:sessions'] }),
  });

  const updateStep = useMutation({
    mutationFn: (payload: z.infer<typeof StepUpdate>) => api.post('/api/commissioning/step', payload).then((r) => r.json()),
  });

  const finalise = useMutation({
    mutationFn: (payload: { session_id: string; outcome: 'passed' | 'failed'; notes?: string }) =>
      api.post('/api/commissioning/finalise', payload).then((r) => r.json()),
  });

  // … render: select device + checklist → Start → list steps with Pass/Fail/Skip and a small readings form …
  // … show a “Generate report” button that calls finalise.mutate({ session_id, outcome }) …

  return (
    <div className="card">
      <h2>Commissioning</h2>
      {/* left: checklist + device pickers; right: steps */}
      {/* keep buttons disabled when read-only flag is active; your header chip already exposes it */}
    </div>
  );
}
