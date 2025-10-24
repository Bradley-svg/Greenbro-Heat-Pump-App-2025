import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeTelemetryFromRegisters,
  normalizeRegisterMap,
  RegisterSnapshot,
} from '../src/lib/modbus';

test('normalizeRegisterMap parses hex and decimal keys', () => {
  const snapshot = normalizeRegisterMap({
    '0x8013': 550,
    '32791': 480,
    'invalid': 123,
    '0xZZZZ': 10,
  });

  assert.equal(snapshot[0x8013], 550);
  assert.equal(snapshot[32791], 480);
  assert.equal(Object.keys(snapshot).length, 2);
});

test('decodeTelemetryFromRegisters maps metrics, status, and faults', () => {
  const registers: RegisterSnapshot = {
    0x0000: 0b00010001, // Control sign 1: system enable + auto EEV
    0x8002: 3, // Mode code -> hot water + heating
    0x8003: 5, // Active fault code
    0x800A: 0b00010101, // Output sign 1
    0x800C: 0b00000001, // Status sign 1 (defrost active)
    0x800E: 0b00000010, // Fault sign 1 (ambient sensor fault)
    0x8013: 550, // Tank temp (55.0 C)
    0x8015: 0xff9c, // Ambient temp (-10.0 C, scaled)
    0x8016: 420, // Return temp (42.0 C)
    0x8017: 480, // Supply temp (48.0 C)
    0x801B: 10, // Compressor current
    0x8020: 320, // EEV steps
  };

  const decoded = decodeTelemetryFromRegisters(registers);

  assert.equal(decoded.metrics.tankC, 55);
  assert.equal(decoded.metrics.supplyC, 48);
  assert.equal(decoded.metrics.returnC, 42);
  assert.equal(decoded.metrics.ambientC, -10);
  assert.equal(decoded.metrics.compCurrentA, 10);
  assert.equal(decoded.metrics.eevSteps, 320);

  assert.equal(decoded.status.mode, 'hot water + heating');
  assert.equal(decoded.status.defrost, true);
  assert.equal(decoded.status.online, true);
  assert.ok(decoded.status.flags);
  assert.equal(decoded.status.flags?.control_sign_1?.system_enable, true);
  assert.equal(decoded.status.flags?.control_sign_1?.electronic_expansion_valve_mode_p6, true);
  assert.equal(decoded.status.flags?.status_sign_1?.defrost_active, true);

  const faultCodes = decoded.faults.map((fault) => fault.code);
  assert.ok(faultCodes.includes('Er 05'), 'Expected Er 05 active fault');
  assert.ok(
    faultCodes.includes('fault.fault_sign_1.ambient_sensor_fault'),
    'Expected fault_sign_1 ambient sensor entry',
  );

  const er05 = decoded.faults.find((fault) => fault.code === 'Er 05');
  assert.equal(er05?.description, 'System 1 high pressure protection');
});
