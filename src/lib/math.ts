import type { Derived } from '../alerts';
import type { TelemetryPayload } from '../types';

const WATER_DENSITY = 0.997;
const WATER_SPECIFIC_HEAT = 4.186;

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function computeDerived(metrics: TelemetryPayload['metrics']): Derived {
  const supply = metrics.supplyC ?? null;
  const ret = metrics.returnC ?? null;
  const flow = metrics.flowLps ?? null;
  const power = metrics.powerKW ?? null;

  const deltaT = supply != null && ret != null ? round1(supply - ret) : null;
  const thermalKW =
    flow != null && deltaT != null ? round2((WATER_DENSITY * WATER_SPECIFIC_HEAT * flow * deltaT) / 1_000) : null;

  let cop: number | null = null;
  let copQuality: 'measured' | 'estimated' | null = null;

  if (thermalKW != null && power != null && power > 0.05) {
    cop = round2(thermalKW / power);
    copQuality = 'measured';
  } else if (thermalKW != null) {
    cop = null;
    copQuality = 'estimated';
  }

  return { deltaT, thermalKW, cop, copQuality };
}

export function computeDerivedFromTelemetry(telemetry: TelemetryPayload): Derived {
  return computeDerived(telemetry.metrics);
}
