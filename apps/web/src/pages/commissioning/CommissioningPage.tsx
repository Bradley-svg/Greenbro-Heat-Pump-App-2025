import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/api/http';
import { useToast } from '@app/providers/ToastProvider';
import { useReadOnly } from '@hooks/useReadOnly';

const StepUpdateSchema = z.object({
  session_id: z.string(),
  step_id: z.string(),
  state: z.enum(['pending', 'pass', 'fail', 'skip']),
  readings: z.record(z.any()).optional(),
  comment: z.string().optional(),
});

type StepUpdateInput = z.infer<typeof StepUpdateSchema>;

type ChecklistSummary = {
  checklist_id: string;
  name: string;
  version: number;
  steps_json: string;
  required_steps_json?: string | null;
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
  checklist_id: string | null;
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
const WINDOW_MEASURE_STEP = 'deltaT_under_load';

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
  const [missingSteps, setMissingSteps] = useState<string[]>([]);

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

  const requiredMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const cl of checklists ?? []) {
      const parseIds = (raw: string | null | undefined): string[] => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return parsed
              .map((value) => {
                if (typeof value === 'string') return value;
                if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
                  return (value as { id: string }).id;
                }
                return null;
              })
              .filter((id): id is string => Boolean(id));
          }
        } catch (error) {
          console.warn('Failed to parse checklist required steps', error);
        }
        return [];
      };

      const required = parseIds(cl.required_steps_json ?? undefined);
      const fallback = parseIds(cl.steps_json);
      const ids = required.length > 0 ? required : fallback;
      map.set(cl.checklist_id, new Set(ids));
    }
    return map;
  }, [checklists]);

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
    mutationFn: (payload: StepUpdateInput) =>
      api.post('/api/commissioning/step', StepUpdateSchema.parse(payload)).then((r) => r.json()),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['comm:session', variables.session_id] });
      void qc.invalidateQueries({ queryKey: ['comm:sessions'] });
      toast.success('Step updated');
    },
    onError: () => toast.error('Failed to update step'),
  });

  const finalise = useMutation({
    mutationFn: async (payload: { session_id: string; outcome: 'passed' | 'failed'; notes?: string }) => {
      const response = await api.post('/api/commissioning/finalise', payload);
      const body = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 409) {
        throw Object.assign(new Error('finalise_failed'), { status: response.status, body });
      }
      return { status: response.status, body } as {
        status: number;
        body: { ok?: boolean; error?: string; missing?: string[] };
      };
    },
    onSuccess: (result, variables) => {
      if (result.status === 409 && result.body?.error === 'required_steps_not_passed') {
        const missingList = Array.isArray(result.body.missing)
          ? (result.body.missing as string[])
          : [];
        setMissingSteps(missingList);
        const detailData = qc.getQueryData<SessionDetail>(['comm:session', variables.session_id]);
        const missingNames = missingList.map((id) => {
          const match = detailData?.steps.find((step) => step.step_id === id);
          return match?.title ?? id;
        });
        const label = missingNames.length > 0 ? missingNames.join(', ') : 'Check checklist';
        toast.warning(`Required steps outstanding: ${label}`);
        return;
      }
      if (result.body?.ok) {
        toast.success(`Session ${variables.outcome === 'passed' ? 'finalised' : 'marked as failed'}`);
        setMissingSteps([]);
        void qc.invalidateQueries({ queryKey: ['comm:session', variables.session_id] });
        void qc.invalidateQueries({ queryKey: ['comm:sessions'] });
        return;
      }
      toast.error('Failed to finalise session');
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

  const measureWindow = useMutation({
    mutationFn: (payload: { session_id: string; step_id: string; window_s?: number }) =>
      api.post('/api/commissioning/measure-window', payload).then((r) => r.json()),
    onSuccess: (data, variables) => {
      void qc.invalidateQueries({ queryKey: ['comm:session', variables.session_id] });
      if (data?.ok) {
        const dt = typeof data.sample?.delta_t_med === 'number' ? data.sample.delta_t_med : null;
        const thresholdRaw = typeof data.thresholds?.delta_t_min === 'number'
          ? data.thresholds.delta_t_min
          : thresholds.delta_t_min;
        const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 0;
        const dtText = dt != null ? `${dt.toFixed(1)}°C` : '—';
        if (data.pass) {
          toast.success(`ΔT ${dtText} ≥ ${threshold.toFixed(1)}°C`);
        } else {
          toast.warning(`Below threshold — ΔT ${dtText}`);
        }
      } else {
        toast.error('Measurement failed');
      }
    },
    onError: () => toast.error('Failed to capture window measurement'),
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

  const provisioningZip = useMutation({
    mutationFn: (session_id: string) =>
      api.post('/api/commissioning/provisioning-zip', { session_id }).then((r) => r.json()),
    onSuccess: (data, session_id) => {
      if (data?.ok) {
        toast.success('Provisioning ZIP ready');
        void qc.invalidateQueries({ queryKey: ['comm:session', session_id] });
      } else {
        toast.error('ZIP generation failed');
      }
    },
    onError: () => toast.error('Failed to create provisioning ZIP'),
  });

  const emailBundle = useMutation({
    mutationFn: async (session_id: string) => {
      const response = await api.post('/api/commissioning/email-bundle', { session_id });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error('email_bundle_failed'), { status: response.status, body });
      }
      return body as { ok?: boolean; reason?: string };
    },
    onSuccess: (data) => {
      if (data?.ok) {
        toast.success('Bundle email triggered');
      } else if (data?.reason === 'no_pdf') {
        toast.warning('Commissioning PDF not available yet');
      } else if (data?.reason === 'no_webhook') {
        toast.warning('No webhook configured for commissioning reports');
      } else {
        toast.warning('Unable to send commissioning bundle');
      }
    },
    onError: () => toast.error('Failed to send commissioning bundle'),
  });

  const detail = detailQuery.data;
  const currentSession = detail?.session ?? null;
  const artifacts = detail?.artifacts ?? {};

  const currentRequired = useMemo(() => {
    if (!currentSession?.checklist_id) {
      return new Set<string>();
    }
    return requiredMap.get(currentSession.checklist_id) ?? new Set<string>();
  }, [currentSession?.checklist_id, requiredMap]);

  const requiredStats = useMemo(() => {
    const total = currentRequired.size;
    if (!detail?.steps || total === 0) {
      return { total, passed: 0, missing: [] as string[] };
    }
    let passed = 0;
    const missing: string[] = [];
    for (const step of detail.steps) {
      if (!currentRequired.has(step.step_id)) continue;
      if (step.state === 'pass') {
        passed += 1;
      } else {
        missing.push(step.step_id);
      }
    }
    return { total, passed, missing };
  }, [currentRequired, detail?.steps]);

  const outstandingRequiredLabels = useMemo(() => {
    if (!detail?.steps || requiredStats.missing.length === 0) {
      return [] as string[];
    }
    return requiredStats.missing.map((id) => {
      const match = detail.steps.find((step) => step.step_id === id);
      return match?.title ?? id;
    });
  }, [detail?.steps, requiredStats.missing]);

  useEffect(() => {
    if (!missingSteps.length) return;
    if (!detail?.steps) return;
    const stillMissing = missingSteps.filter((id) => {
      const match = detail.steps.find((step) => step.step_id === id);
      return match ? match.state !== 'pass' : false;
    });
    if (stillMissing.length !== missingSteps.length) {
      setMissingSteps(stillMissing);
    }
  }, [detail?.steps, missingSteps]);

  useEffect(() => {
    setMissingSteps([]);
  }, [selectedSessionId]);

  const missingHighlight = useMemo(() => {
    const set = new Set<string>(requiredStats.missing);
    for (const id of missingSteps) {
      set.add(id);
    }
    return set;
  }, [missingSteps, requiredStats.missing]);

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

  const handleMeasureWindow = (step: StepResult) => {
    if (!currentSession) return;
    measureWindow.mutate({ session_id: currentSession.session_id, step_id: step.step_id, window_s: 90 });
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

  const handleProvisioningZip = () => {
    if (!currentSession) return;
    provisioningZip.mutate(currentSession.session_id);
  };

  const handleEmailBundle = () => {
    if (!currentSession) return;
    if (!artifacts.pdf) {
      toast.warning('Finalise the session to generate the PDF first');
      return;
    }
    if (!artifacts.zip) {
      toast.warning('Generate the provisioning ZIP before emailing');
      return;
    }
    emailBundle.mutate(currentSession.session_id);
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
                const requiredCount = session.checklist_id
                  ? requiredMap.get(session.checklist_id)?.size ?? 0
                  : 0;
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
                        {requiredCount > 0 ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              marginTop: '4px',
                              fontSize: '0.75em',
                              padding: '2px 6px',
                              borderRadius: '999px',
                              background: 'rgba(14, 165, 233, 0.15)',
                              color: 'rgba(14, 165, 233, 0.9)',
                            }}
                          >
                            Required: {requiredCount}
                          </span>
                        ) : null}
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
                {requiredStats.total > 0 ? (
                  <div>
                    <strong>Required</strong>:{' '}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        fontSize: '0.85em',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        background: 'rgba(59, 130, 246, 0.12)',
                        color: 'rgba(37, 99, 235, 0.95)',
                      }}
                    >
                      {requiredStats.passed}/{requiredStats.total} passed
                    </span>
                  </div>
                ) : null}
                {outstandingRequiredLabels.length > 0 ? (
                  <div style={{ fontSize: '0.85em', color: 'rgba(239, 68, 68, 0.9)' }}>
                    Outstanding required: {outstandingRequiredLabels.join(', ')}
                  </div>
                ) : null}
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
                  onClick={handleProvisioningZip}
                  disabled={actionDisabled || provisioningZip.isPending}
                >
                  {provisioningZip.isPending ? 'Generating…' : 'Provisioning ZIP'}
                </button>
                {currentSession?.status !== 'in_progress' ? (
                  <button
                    className="app-button"
                    type="button"
                    onClick={handleEmailBundle}
                    disabled={actionDisabled || emailBundle.isPending}
                  >
                    {emailBundle.isPending ? 'Emailing…' : 'Email bundle'}
                  </button>
                ) : null}
              </div>

              <div className="commissioning-artifacts" style={{ display: 'grid', gap: '4px', fontSize: '0.9em' }}>
                <div>
                  <strong>PDF</strong>: {artifacts.pdf ? <code>{artifacts.pdf.r2_key}</code> : '—'}
                </div>
                <div>
                  <strong>Labels</strong>: {artifacts.labels ? <code>{artifacts.labels.r2_key}</code> : '—'}
                </div>
                <div>
                  <strong>Provisioning ZIP</strong>: {artifacts.zip ? <code>{artifacts.zip.r2_key}</code> : '—'}
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
                      onMeasureWindow={
                        step.step_id === WINDOW_MEASURE_STEP ? () => handleMeasureWindow(step) : undefined
                      }
                      disabled={actionDisabled}
                      updating={updateStep.isPending}
                      measuring={measure.isPending && measure.variables?.step_id === step.step_id}
                      measuringWindow={
                        measureWindow.isPending && measureWindow.variables?.step_id === step.step_id
                      }
                      required={currentRequired.has(step.step_id)}
                      missing={missingHighlight.has(step.step_id)}
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
  onMeasureWindow?: () => void;
  disabled: boolean;
  updating: boolean;
  measuring: boolean;
  measuringWindow: boolean;
  required: boolean;
  missing: boolean;
};

function StepCard({
  step,
  thresholds,
  onChange,
  onSaveComment,
  onMeasure,
  onMeasureWindow,
  disabled,
  updating,
  measuring,
  measuringWindow,
  required,
  missing,
}: StepCardProps) {
  const [comment, setComment] = useState(step.comment ?? '');

  useEffect(() => {
    setComment(step.comment ?? '');
  }, [step.step_id, step.comment]);

  const readings = useMemo(() => (step.readings && typeof step.readings === 'object' ? step.readings : null), [step.readings]);
  const capturedAt = typeof readings?.ts === 'string' ? readings.ts : null;
  const deltaT = toNumber(readings?.delta_t ?? readings?.deltaT ?? readings?.delta_t_med);
  const flow = toNumber(readings?.flow_lpm ?? readings?.flow ?? readings?.flow_lpm_med);
  const outlet = toNumber(readings?.outlet ?? readings?.outlet_temp_c ?? readings?.outlet_c_med);
  const ret = toNumber(readings?.return ?? readings?.return_temp_c ?? readings?.return_c_med);
  const cop = toNumber(readings?.cop ?? readings?.cop_med);
  const windowSeconds = toNumber(readings?.window_s);
  const sampleCount = toNumber(readings?.count);

  const showMeasurements = Boolean(onMeasure || onMeasureWindow);

  const cardStyle: CSSProperties = {
    border: missing ? '2px solid rgba(244, 63, 94, 0.6)' : '1px solid rgba(0,0,0,0.1)',
    borderRadius: '12px',
    padding: '12px',
    boxShadow: missing ? '0 0 0 2px rgba(244,63,94,0.25), 0 0 14px rgba(244,63,94,0.35)' : 'none',
    background: missing ? 'rgba(255, 241, 242, 0.75)' : 'transparent',
    transition: 'box-shadow 0.2s ease, border-color 0.2s ease',
  };

  return (
    <div className="commissioning-step" style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h4 style={{ margin: 0 }}>{step.title}</h4>
          {required ? (
            <span
              style={{
                fontSize: '0.75em',
                padding: '2px 6px',
                borderRadius: '999px',
                background: 'rgba(251, 191, 36, 0.25)',
                color: 'rgba(217, 119, 6, 0.95)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              Required
            </span>
          ) : null}
        </div>
        <span className={statePillClass(step.state)}>{statusLabel(step.state)}</span>
      </div>
      <div style={{ fontSize: '0.85em', color: 'rgba(71, 85, 105, 0.85)' }}>Updated {formatDate(step.updated_at)}</div>

      {capturedAt || deltaT != null || flow != null || cop != null ? (
        <ul style={{ margin: '8px 0', paddingLeft: '18px', fontSize: '0.9em' }}>
          {capturedAt ? <li>Captured at {formatDate(capturedAt)}</li> : null}
          {windowSeconds != null ? (
            <li>
              Window {formatNumber(windowSeconds, 0)} s
              {sampleCount != null ? ` (${formatNumber(sampleCount, 0)} samples)` : null}
            </li>
          ) : null}
          {deltaT != null ? <li>ΔT {formatNumber(deltaT, 1)} °C</li> : null}
          {flow != null ? <li>Flow {formatNumber(flow, 2)} L/min</li> : null}
          {outlet != null && ret != null ? <li>Temps {formatNumber(outlet, 1)} / {formatNumber(ret, 1)} °C</li> : null}
          {cop != null ? <li>COP {formatNumber(cop, 2)}</li> : null}
        </ul>
      ) : null}

      {showMeasurements ? (
        <div style={{ display: 'grid', gap: '6px', marginBottom: '8px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {onMeasure ? (
              <button
                className="app-button"
                type="button"
                onClick={onMeasure}
                disabled={disabled || measuring}
              >
                {measuring ? 'Measuring…' : 'Measure now'}
              </button>
            ) : null}
            {onMeasureWindow ? (
              <button
                className="app-button"
                type="button"
                onClick={onMeasureWindow}
                disabled={disabled || measuringWindow}
              >
                {measuringWindow ? 'Measuring…' : 'Measure (90 s median)'}
              </button>
            ) : null}
          </div>
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
