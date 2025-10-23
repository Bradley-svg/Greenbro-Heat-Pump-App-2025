import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/api/http';
import { useToast } from '@app/providers/ToastProvider';
import { useReadOnly } from '@hooks/useReadOnly';

const StepUpdate = z.object({
  session_id: z.string(),
  step_id: z.string(),
  state: z.enum(['pending', 'pass', 'fail', 'skip']),
  readings: z.record(z.any()).optional(),
  comment: z.string().optional(),
});

type ChecklistSummary = {
  checklist_id: string;
  name: string;
  version: number;
};

type SessionSummary = {
  session_id: string;
  device_id: string;
  site_id: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  last_update: string | null;
  notes: string | null;
};

type ArtifactInfo = { r2_key: string; size_bytes: number | null; created_at: string };

type StepResult = {
  step_id: string;
  title: string;
  state: 'pending' | 'pass' | 'fail' | 'skip';
  readings?: Record<string, unknown> | null;
  comment: string | null;
  updated_at: string;
};

type SessionDetail = {
  session: SessionSummary;
  steps: StepResult[];
  artifacts: Record<string, ArtifactInfo | undefined>;
};

type CommissioningSettings = {
  delta_t_min: number;
  flow_min_lpm: number;
  cop_min: number;
};

const MEASURE_STEPS = new Set(['deltaT_under_load', 'flow_detected']);

export default function CommissioningPage(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const { ro } = useReadOnly();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [notes, setNotes] = useState('');
  const [checklistId, setChecklistId] = useState('');
  const [noteDraft, setNoteDraft] = useState('');

  const { data: checklists } = useQuery<ChecklistSummary[]>({
    queryKey: ['comm:lists'],
    queryFn: () => api.get('/api/commissioning/checklists').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const sessionsQuery = useQuery<SessionSummary[]>({
    queryKey: ['comm:sessions'],
    queryFn: () => api.get('/api/commissioning/sessions').then((r) => r.json()),
    refetchInterval: 20_000,
  });

  const settingsQuery = useQuery<CommissioningSettings>({
    queryKey: ['comm:settings'],
    queryFn: () => api.get('/api/commissioning/settings').then((r) => r.json()),
    staleTime: 60_000,
  });

  const sessions = useMemo(() => {
    const rows = sessionsQuery.data ?? [];
    return [...rows].sort((a, b) => {
      if (a.status === b.status) {
        return b.started_at.localeCompare(a.started_at);
      }
      if (a.status === 'in_progress') return -1;
      if (b.status === 'in_progress') return 1;
      return b.started_at.localeCompare(a.started_at);
    });
  }, [sessionsQuery.data]);

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0].session_id);
    }
  }, [selectedSessionId, sessions]);

  const detailQuery = useQuery<SessionDetail>({
    queryKey: ['comm:session', selectedSessionId],
    queryFn: () => api.get(`/api/commissioning/session/${selectedSessionId}`).then((r) => r.json()),
    enabled: Boolean(selectedSessionId),
  });

  const thresholds = settingsQuery.data ?? { delta_t_min: 0, flow_min_lpm: 0, cop_min: 0 };

  useEffect(() => {
    const detail = detailQuery.data;
    if (detail?.session) {
      setNoteDraft(detail.session.notes ?? '');
    }
  }, [detailQuery.data?.session?.session_id, detailQuery.data?.session?.notes]);

  const create = useMutation({
    mutationFn: (payload: any) => api.post('/api/commissioning/start', payload).then((r) => r.json()),
    onSuccess: (data: { ok: boolean; session_id?: string }) => {
      void qc.invalidateQueries({ queryKey: ['comm:sessions'] });
      if (data?.session_id) {
        setSelectedSessionId(data.session_id);
        toast.success('Commissioning session started');
        setDeviceId('');
        setSiteId('');
        setNotes('');
        setChecklistId('');
      }
    },
    onError: () => {
      toast.error('Failed to start commissioning session');
    },
  });

  const updateStep = useMutation({
    mutationFn: (payload: z.infer<typeof StepUpdate>) => api.post('/api/commissioning/step', payload).then((r) => r.json()),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['comm:session', variables.session_id] });
      void qc.invalidateQueries({ queryKey: ['comm:sessions'] });
      toast.success('Step updated');
    },
    onError: () => toast.error('Failed to update step'),
  });

  const finalise = useMutation({
    mutationFn: (payload: { session_id: string; outcome: 'passed' | 'failed'; notes?: string }) =>
      api.post('/api/commissioning/finalise', payload).then((r) => r.json()),
    onSuccess: (_data, variables) => {
      toast.success(`Session ${variables.outcome === 'passed' ? 'finalised' : 'marked as failed'}`);
      void qc.invalidateQueries({ queryKey: ['comm:session', variables.session_id] });
      void qc.invalidateQueries({ queryKey: ['comm:sessions'] });
    },
    onError: () => toast.error('Failed to finalise session'),
  });

  const measure = useMutation({
    mutationFn: (payload: { session_id: string; step_id: string }) =>
      api
        .post('/api/commissioning/measure-now', {
          session_id: payload.session_id,
          step_id: payload.step_id,
          expectations: thresholds,
        })
        .then((r) => r.json()),
    onSuccess: (data, variables) => {
      void qc.invalidateQueries({ queryKey: ['comm:session', variables.session_id] });
      if (data?.ok) {
        toast[data.pass ? 'success' : 'warning'](
          data.pass ? 'Measurements meet thresholds' : 'Measurements below thresholds',
        );
      } else {
        toast.error('Measurement failed');
      }
    },
    onError: () => toast.error('Failed to capture measurement'),
  });

  const labels = useMutation({
    mutationFn: (session_id: string) =>
      api.post('/api/commissioning/labels', { session_id }).then((r) => r.json()),
    onSuccess: (_data, session_id) => {
      void qc.invalidateQueries({ queryKey: ['comm:session', session_id] });
      toast.success('Labels generated');
    },
    onError: () => toast.error('Failed to generate labels'),
  });

  const email = useMutation({
    mutationFn: (session_id: string) =>
      api.post('/api/commissioning/email-report', { session_id }).then((r) => r.json()),
    onSuccess: (data) => {
      if (data?.ok) {
        toast.success('Commissioning report emailed');
      } else {
        toast.warning('No webhook configured for commissioning reports');
      }
    },
    onError: () => toast.error('Failed to send commissioning email'),
  });

  const detail = detailQuery.data;
  const currentSession = detail?.session ?? null;
  const artifacts = detail?.artifacts ?? {};

  const handleCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!deviceId.trim()) {
      toast.warning('Device ID is required');
      return;
    }
    create.mutate({
      device_id: deviceId.trim(),
      site_id: siteId.trim() || undefined,
      checklist_id: checklistId || undefined,
      notes: notes.trim() || undefined,
    });
  };

  const handleStateChange = (step: StepResult, nextState: StepResult['state']) => {
    if (!currentSession) return;
    updateStep.mutate({ session_id: currentSession.session_id, step_id: step.step_id, state: nextState });
  };

  const handleSaveComment = (step: StepResult, comment: string) => {
    if (!currentSession) return;
    updateStep.mutate({
      session_id: currentSession.session_id,
      step_id: step.step_id,
      state: step.state,
      comment: comment.trim() ? comment : undefined,
    });
  };

  const handleMeasure = (step: StepResult) => {
    if (!currentSession) return;
    measure.mutate({ session_id: currentSession.session_id, step_id: step.step_id });
  };

  const handleFinalize = (outcome: 'passed' | 'failed') => {
    if (!currentSession) return;
    finalise.mutate({
      session_id: currentSession.session_id,
      outcome,
      notes: noteDraft.trim() || undefined,
    });
  };

  const handleGenerateLabels = () => {
    if (!currentSession) return;
    labels.mutate(currentSession.session_id);
  };

  const handleEmail = () => {
    if (!currentSession) return;
    email.mutate(currentSession.session_id);
  };

  const actionDisabled = ro;
  const waiting = create.isPending || updateStep.isPending || finalise.isPending;

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h2>Commissioning</h2>
          <p className="page__subtitle">Track, measure, and finalise commissioning sessions</p>
        </div>
      </header>
      <div
        className="commissioning-grid"
        style={{
          display: 'grid',
          gap: '16px',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          alignItems: 'start',
        }}
      >
        <section className="card" aria-labelledby="commissioning-start">
          <h3 id="commissioning-start">Start a new session</h3>
          <form onSubmit={handleCreate} className="commissioning-form" style={{ display: 'grid', gap: '10px' }}>
            <label className="form-field">
              Device ID
              <input
                type="text"
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
                required
                placeholder="DEVICE-123"
                disabled={actionDisabled || create.isPending}
              />
            </label>
            <label className="form-field">
              Site ID (optional)
              <input
                type="text"
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
                placeholder="SITE-CT-001"
                disabled={actionDisabled || create.isPending}
              />
            </label>
            <label className="form-field">
              Checklist
              <select
                value={checklistId}
                onChange={(event) => setChecklistId(event.target.value)}
                disabled={actionDisabled || create.isPending}
              >
                <option value="">Default</option>
                {(checklists ?? []).map((cl) => (
                  <option key={cl.checklist_id} value={cl.checklist_id}>
                    {cl.name} v{cl.version}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              Notes
              <textarea
                rows={3}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Install notes"
                disabled={actionDisabled || create.isPending}
              />
            </label>
            <button className="app-button" type="submit" disabled={actionDisabled || create.isPending}>
              {create.isPending ? 'Starting…' : 'Start session'}
            </button>
          </form>

          <h3 style={{ marginTop: '24px' }}>Sessions</h3>
          {sessionsQuery.isLoading ? (
            <p>Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p>No commissioning sessions yet.</p>
          ) : (
            <ul className="commissioning-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' }}>
              {sessions.map((session) => {
                const active = session.session_id === selectedSessionId;
                return (
                  <li key={session.session_id}>
                    <button
                      type="button"
                      onClick={() => setSelectedSessionId(session.session_id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '10px 12px',
                        borderRadius: '12px',
                        border: active ? '2px solid rgba(57, 181, 74, 0.5)' : '1px solid rgba(0,0,0,0.1)',
                        background: active ? 'rgba(57, 181, 74, 0.1)' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <span>
                        <strong>{session.device_id}</strong>
                        <span style={{ display: 'block', fontSize: '0.85em', color: 'rgba(71, 85, 105, 0.85)' }}>
                          {session.site_id ?? 'No site'}
                        </span>
                      </span>
                      <span className={statePillClass(session.status)}>{statusLabel(session.status)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="commissioning-detail">
          <h3 id="commissioning-detail">Session detail</h3>
          {!selectedSessionId ? (
            <p>Select a session to review progress.</p>
          ) : detailQuery.isLoading ? (
            <p>Loading session…</p>
          ) : detailQuery.isError || !detail ? (
            <p>Failed to load session detail.</p>
          ) : (
            <div className="commissioning-detail" style={{ display: 'grid', gap: '16px' }}>
              <div className="commissioning-summary" style={{ display: 'grid', gap: '6px' }}>
                <div>
                  <strong>Device</strong>: {currentSession?.device_id}
                </div>
                <div>
                  <strong>Site</strong>: {currentSession?.site_id ?? '—'}
                </div>
                <div>
                  <strong>Status</strong>:{' '}
                  <span className={statePillClass(currentSession?.status ?? 'pending')}>
                    {statusLabel(currentSession?.status ?? 'pending')}
                  </span>
                </div>
                <div>
                  <strong>Started</strong>: {formatDate(currentSession?.started_at)}
                </div>
                <div>
                  <strong>Finished</strong>: {formatDate(currentSession?.finished_at)}
                </div>
              </div>

              <label className="form-field">
                Session notes
                <textarea
                  rows={3}
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  disabled={actionDisabled || finalise.isPending}
                />
              </label>

              <div className="commissioning-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <button
                  className="app-button"
                  type="button"
                  onClick={() => handleFinalize('passed')}
                  disabled={actionDisabled || waiting || currentSession?.status !== 'in_progress'}
                >
                  {finalise.isPending ? 'Finalising…' : 'Finalise – Passed'}
                </button>
                <button
                  className="app-button"
                  type="button"
                  onClick={() => handleFinalize('failed')}
                  disabled={actionDisabled || waiting || currentSession?.status !== 'in_progress'}
                >
                  {finalise.isPending ? 'Finalising…' : 'Finalise – Failed'}
                </button>
                <button
                  className="app-button"
                  type="button"
                  onClick={handleGenerateLabels}
                  disabled={actionDisabled || labels.isPending}
                >
                  {labels.isPending ? 'Generating…' : 'Generate labels'}
                </button>
                <button
                  className="app-button"
                  type="button"
                  onClick={handleEmail}
                  disabled={actionDisabled || email.isPending || !artifacts.pdf}
                >
                  {email.isPending ? 'Emailing…' : 'Email report'}
                </button>
              </div>

              <div className="commissioning-artifacts" style={{ display: 'grid', gap: '4px', fontSize: '0.9em' }}>
                <div>
                  <strong>PDF</strong>: {artifacts.pdf ? <code>{artifacts.pdf.r2_key}</code> : '—'}
                </div>
                <div>
                  <strong>Labels</strong>: {artifacts.labels ? <code>{artifacts.labels.r2_key}</code> : '—'}
                </div>
              </div>

              <div className="commissioning-steps" style={{ display: 'grid', gap: '12px' }}>
                {detail.steps.length === 0 ? (
                  <p>No steps configured for this session.</p>
                ) : (
                  detail.steps.map((step) => (
                    <StepCard
                      key={step.step_id}
                      step={step}
                      thresholds={thresholds}
                      onChange={(state) => handleStateChange(step, state)}
                      onSaveComment={(comment) => handleSaveComment(step, comment)}
                      onMeasure={MEASURE_STEPS.has(step.step_id) ? () => handleMeasure(step) : undefined}
                      disabled={actionDisabled}
                      updating={updateStep.isPending}
                      measuring={measure.isPending && measure.variables?.step_id === step.step_id}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

type StepCardProps = {
  step: StepResult;
  thresholds: CommissioningSettings;
  onChange: (state: StepResult['state']) => void;
  onSaveComment: (comment: string) => void;
  onMeasure?: () => void;
  disabled: boolean;
  updating: boolean;
  measuring: boolean;
};

function StepCard({ step, thresholds, onChange, onSaveComment, onMeasure, disabled, updating, measuring }: StepCardProps) {
  const [comment, setComment] = useState(step.comment ?? '');

  useEffect(() => {
    setComment(step.comment ?? '');
  }, [step.step_id, step.comment]);

  const readings = useMemo(() => (step.readings && typeof step.readings === 'object' ? step.readings : null), [step.readings]);
  const capturedAt = typeof readings?.ts === 'string' ? readings.ts : null;
  const deltaT = toNumber(readings?.delta_t ?? readings?.deltaT);
  const flow = toNumber(readings?.flow_lpm ?? readings?.flow);
  const outlet = toNumber(readings?.outlet ?? readings?.outlet_temp_c);
  const ret = toNumber(readings?.return ?? readings?.return_temp_c);
  const cop = toNumber(readings?.cop);

  return (
    <div className="commissioning-step" style={{ border: '1px solid rgba(0,0,0,0.1)', borderRadius: '12px', padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <h4 style={{ margin: 0 }}>{step.title}</h4>
        <span className={statePillClass(step.state)}>{statusLabel(step.state)}</span>
      </div>
      <div style={{ fontSize: '0.85em', color: 'rgba(71, 85, 105, 0.85)' }}>Updated {formatDate(step.updated_at)}</div>

      {capturedAt || deltaT != null || flow != null || cop != null ? (
        <ul style={{ margin: '8px 0', paddingLeft: '18px', fontSize: '0.9em' }}>
          {capturedAt ? <li>Captured at {formatDate(capturedAt)}</li> : null}
          {deltaT != null ? <li>ΔT {formatNumber(deltaT, 1)} °C</li> : null}
          {flow != null ? <li>Flow {formatNumber(flow, 2)} L/min</li> : null}
          {outlet != null && ret != null ? <li>Temps {formatNumber(outlet, 1)} / {formatNumber(ret, 1)} °C</li> : null}
          {cop != null ? <li>COP {formatNumber(cop, 2)}</li> : null}
        </ul>
      ) : null}

      {onMeasure ? (
        <div style={{ display: 'grid', gap: '6px', marginBottom: '8px' }}>
          <button
            className="app-button"
            type="button"
            onClick={onMeasure}
            disabled={disabled || measuring}
          >
            {measuring ? 'Measuring…' : 'Measure now'}
          </button>
          <span style={{ fontSize: '0.8em', color: 'rgba(71, 85, 105, 0.85)' }}>
            Targets: ΔT ≥ {formatNumber(thresholds.delta_t_min, 1)} °C, Flow ≥ {formatNumber(thresholds.flow_min_lpm, 1)} L/min,
            COP ≥ {formatNumber(thresholds.cop_min, 1)}
          </span>
        </div>
      ) : null}

      <div className="step-actions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button
          className="app-button"
          type="button"
          onClick={() => onChange('pass')}
          disabled={disabled || updating}
        >
          Pass
        </button>
        <button
          className="app-button"
          type="button"
          onClick={() => onChange('fail')}
          disabled={disabled || updating}
        >
          Fail
        </button>
        <button
          className="app-button"
          type="button"
          onClick={() => onChange('skip')}
          disabled={disabled || updating}
        >
          Skip
        </button>
      </div>

      <label className="form-field" style={{ display: 'block', marginTop: '10px' }}>
        Comment
        <textarea
          rows={2}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          disabled={disabled || updating}
        />
      </label>
      <button
        className="app-button"
        type="button"
        onClick={() => onSaveComment(comment)}
        disabled={disabled || updating}
        style={{ marginTop: '6px' }}
      >
        Save comment
      </button>
    </div>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatNumber(value: number, fractionDigits = 1): string {
  return Number.isFinite(value) ? value.toFixed(fractionDigits) : '—';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pass':
    case 'passed':
      return 'Passed';
    case 'fail':
    case 'failed':
      return 'Failed';
    case 'skip':
      return 'Skipped';
    case 'in_progress':
      return 'In progress';
    default:
      return status;
  }
}

function statePillClass(state: string): string {
  switch (state) {
    case 'pass':
    case 'passed':
      return 'status-pill status-pill--positive';
    case 'fail':
    case 'failed':
      return 'status-pill status-pill--negative';
    case 'skip':
      return 'status-pill status-pill--warning';
    default:
      return 'status-pill status-pill--neutral';
  }
}
