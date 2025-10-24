import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createWindow } from 'linkedom';

import {
  SeriesChart,
  type SeriesChartHandle,
} from '../apps/web/src/components/charts/SeriesChart';
import { BaselineCompareChips } from '../apps/web/src/pages/DeviceDetailPage';
import { formatAlertMeta } from '../apps/web/src/pages/AlertsPage';
import type { Alert } from '../apps/web/src/api/types';

const SAMPLE_DATA = [
  { ts: 0, v: 1 },
  { ts: 30_000, v: 2 },
  { ts: 60_000, v: 3 },
];

test('SeriesChart renders a time window overlay with positive width', () => {
  const markup = renderToStaticMarkup(
    <SeriesChart
      data={SAMPLE_DATA}
      overlays={[]}
      timeWindows={[{ start: 0, end: 60_000 }]}
      width={320}
      height={160}
    />,
  );
  const match = markup.match(/data-testid="time-window-0"[^>]*width="([^"]+)"/);
  assert(match, 'expected time window rectangle to render');
  const width = Number.parseFloat(match[1]!);
  assert.ok(Number.isFinite(width) && width > 0, 'window width should be positive');
});

test('SeriesChart exposes setXDomain to control the viewport', async () => {
  const { window } = createWindow('<!doctype html><html><body></body></html>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;

  Object.assign(globalThis, {
    window: window as unknown as typeof globalThis.window,
    document: window.document,
    navigator: window.navigator,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const ref = React.createRef<SeriesChartHandle>();

  await act(async () => {
    root.render(
      <SeriesChart
        ref={ref}
        data={SAMPLE_DATA}
        overlays={[]}
        timeWindows={[]}
        width={320}
        height={160}
      />,
    );
  });

  const domainNode = container.querySelector('[data-testid="xdomain"]');
  assert(domainNode, 'expected domain marker');

  await act(async () => {
    ref.current?.setXDomain([10_000, 20_000]);
  });

  const updatedNode = container.querySelector('[data-testid="xdomain"]');
  assert(updatedNode, 'expected updated domain marker');
  assert.equal(Number(updatedNode.getAttribute('data-min')), 10_000);
  assert.equal(Number(updatedNode.getAttribute('data-max')), 20_000);

  await act(async () => {
    root.unmount();
  });

  container.remove();

  if (previousWindow === undefined) {
    delete (globalThis as { window?: typeof globalThis.window }).window;
  } else {
    globalThis.window = previousWindow;
  }

  if (previousDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = previousDocument;
  }

  if (previousNavigator === undefined) {
    delete (globalThis as { navigator?: Navigator }).navigator;
  } else {
    globalThis.navigator = previousNavigator;
  }

  if (previousRaf === undefined) {
    delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
  } else {
    globalThis.requestAnimationFrame = previousRaf;
  }

  if (previousCancelRaf === undefined) {
    delete (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame;
  } else {
    globalThis.cancelAnimationFrame = previousCancelRaf;
  }
});

test('formatAlertMeta renders COP baseline details', () => {
  const alert: Alert = {
    id: 'a1',
    deviceId: 'dev-1',
    title: 'Baseline deviation',
    severity: 'warning',
    state: 'open',
    createdAt: new Date().toISOString(),
    type: 'baseline_deviation',
    meta: { kind: 'cop', coverage: 0.68, drift: 0.12, units: '' },
  };
  const label = formatAlertMeta(alert);
  assert.equal(label, 'COP: 68% in-range · drift +0.12');
});

test('BaselineCompareChips renders coverage chip when baseline exists', () => {
  const markup = renderToStaticMarkup(
    <BaselineCompareChips
      result={{
        isLoading: false,
        isError: false,
        isFetching: false,
        data: { hasBaseline: true, coverage: 0.82, drift: 0.05 },
      } as any}
      unit="×"
      precision={2}
    />,
  );
  assert.ok(markup.includes('82% in-range'));
  assert.ok(markup.includes('+0.05×'));
});
