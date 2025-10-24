import type { TelemetryPayload } from '../types';

export enum ModbusFunctionCode {
    ReadHoldingRegisters = 0x03,
    WriteSingleRegister = 0x06,
    WriteMultipleRegisters = 0x10,
}

export type RegisterAccess = 'R' | 'RW';

export interface RegisterInfo {
    address: number;
    access: RegisterAccess;
    label: string;
    code?: string;
    unit?: string;
    range?: string;
    defaultValue?: string;
    note?: string;
    values?: Record<number, string>;
}

export interface BitFlag {
    bit: number;
    label: string;
    zeroLabel: string;
    oneLabel: string;
    defaultState?: 0 | 1;
}

export interface Bitfield {
    register: number;
    label: string;
    flags: BitFlag[];
}

export interface FaultCode {
    code: string;
    description: string;
}

export const HOLDING_REGISTERS: RegisterInfo[] = [
    { address: 0x0000, access: 'RW', label: 'Control sign 1', range: 'Bitfield', defaultValue: '0x0000' },
    { address: 0x0001, access: 'RW', label: 'Control sign 2', range: 'Bitfield', defaultValue: '0x0000' },
    {
        address: 0x0002,
        access: 'RW',
        label: 'Mode selection',
        code: 'Mode',
        values: { 0: 'Hot water', 1: 'Heating', 2: 'Cooling', 3: 'Hot water + Heating', 4: 'Hot water + Cooling' },
        defaultValue: '0',
    },
    { address: 0x0003, access: 'RW', label: 'L0 DHW hysteresis', code: 'L0', unit: 'deg C', range: '2-18', defaultValue: '3' },
    { address: 0x0004, access: 'RW', label: 'L1 DHW setpoint', code: 'L1', unit: 'deg C', range: '20-F1', defaultValue: '55' },
    {
        address: 0x0005,
        access: 'RW',
        label: 'L2 heating/cooling hysteresis',
        code: 'L2',
        unit: 'deg C',
        range: '2-18',
        defaultValue: '3',
    },
    { address: 0x0006, access: 'RW', label: 'L3 heating setpoint', code: 'L3', unit: 'deg C', range: '20-F1', defaultValue: '50' },
    { address: 0x0007, access: 'RW', label: 'L4 cooling setpoint', code: 'L4', unit: 'deg C', range: '7-30', defaultValue: '12' },
    {
        address: 0x0008,
        access: 'RW',
        label: 'L5 ambient limit for auxiliary heater',
        code: 'L5',
        unit: 'deg C',
        range: '-30-35',
        defaultValue: '0',
    },
    { address: 0x0009, access: 'RW', label: 'Reserved' },
    { address: 0x000A, access: 'RW', label: 'Reserved' },
    {
        address: 0x000B,
        access: 'RW',
        label: 'L6 compressor current limit',
        code: 'L6',
        unit: 'A',
        range: '0-40',
        defaultValue: '15',
        note: 'Real limit is displayed value * 1.25. 0 disables the check.',
    },
    { address: 0x000C, access: 'RW', label: 'H2 low ambient cutoff', code: 'H2', unit: 'deg C', range: '-30-0', defaultValue: '-10' },
    { address: 0x000D, access: 'RW', label: 'H3 defrost interval', code: 'H3', unit: 'min', range: '20-90', defaultValue: '45' },
    {
        address: 0x000E,
        access: 'RW',
        label: 'H4 defrost entry coil temperature',
        code: 'H4',
        unit: 'deg C',
        range: '-15--1',
        defaultValue: '-3',
    },
    { address: 0x000F, access: 'RW', label: 'H5 max defrost duration', code: 'H5', unit: 'min', range: '5-20', defaultValue: '8' },
    { address: 0x0010, access: 'RW', label: 'H6 defrost exit temperature', code: 'H6', unit: 'deg C', range: '1-40', defaultValue: '20' },
    {
        address: 0x0011,
        access: 'RW',
        label: 'H7 ambient vs coil delta for defrost',
        code: 'H7',
        unit: 'deg C',
        range: '0-15',
        defaultValue: '0',
    },
    {
        address: 0x0012,
        access: 'RW',
        label: 'H8 ambient limit for defrost',
        code: 'H8',
        unit: 'deg C',
        range: '0-20',
        defaultValue: '15',
    },
    { address: 0x0013, access: 'RW', label: 'P1 EEV regulation period', code: 'P1', unit: 's', range: '20-90', defaultValue: '45' },
    { address: 0x0014, access: 'RW', label: 'P2 target superheat', code: 'P2', unit: 'deg C', range: '-5-10', defaultValue: '0' },
    { address: 0x0015, access: 'RW', label: 'P3 discharge temperature limit', code: 'P3', unit: 'deg C', range: '60-115', defaultValue: '88' },
    {
        address: 0x0016,
        access: 'RW',
        label: 'P4 EEV steps during defrost',
        code: 'P4',
        range: '2-45',
        defaultValue: '45',
        note: 'Multiply value by 10 before sending to valve driver.',
    },
    {
        address: 0x0017,
        access: 'RW',
        label: 'P5 EEV minimum opening',
        code: 'P5',
        range: '5-20',
        defaultValue: '12',
        note: 'Multiply value by 10 before sending to valve driver.',
    },
    {
        address: 0x0018,
        access: 'RW',
        label: 'P7 manual EEV steps',
        code: 'P7',
        range: '2-50',
        defaultValue: '40',
        note: 'Divide value by 10 when shown to operators.',
    },
    { address: 0x0019, access: 'RW', label: 'F1 maximum setpoint', code: 'F1', unit: 'deg C', range: '20-99', defaultValue: '60' },
    { address: 0x001A, access: 'RW', label: 'F3 display offset', code: 'F3', unit: 'deg C', range: '-5-15', defaultValue: '2' },
    { address: 0x001B, access: 'RW', label: 'Reserved' },
    {
        address: 0x001C,
        access: 'RW',
        label: 'F8 superheat compensation enable',
        code: 'F8',
        values: { 0: 'Disabled', 1: 'Enabled' },
        defaultValue: '0',
    },
    {
        address: 0x001D,
        access: 'RW',
        label: 'F8 time limited lock cycles',
        code: 'F8 lock',
        range: '0-99 cycles',
        defaultValue: '0',
    },
    { address: 0x001E, access: 'RW', label: 'F11 cascade inspection interval', code: 'F11', unit: 'min', range: '1-15', defaultValue: '15' },
    {
        address: 0x001F,
        access: 'RW',
        label: 'F12 power on unit share',
        code: 'F12',
        range: '1-4 (25-100 percent)',
        defaultValue: '1',
        note: 'Units started = floor(total units * 25 percent).',
    },
    { address: 0x0020, access: 'RW', label: 'Reserved' },
    { address: 0x0021, access: 'RW', label: 'Reserved' },
    { address: 0x0022, access: 'RW', label: 'Reserved' },
    { address: 0x0023, access: 'RW', label: 'Timer 1 enable', range: '0 Off, 1 On', defaultValue: '0' },
    { address: 0x0024, access: 'RW', label: 'Timer 1 open hour', unit: 'hour', range: '0-23', defaultValue: '0' },
    { address: 0x0025, access: 'RW', label: 'Timer 1 open minute', unit: 'minute', range: '0-59', defaultValue: '0' },
    { address: 0x0026, access: 'RW', label: 'Timer 1 close hour', unit: 'hour', range: '0-23', defaultValue: '0' },
    { address: 0x0027, access: 'RW', label: 'Timer 1 close minute', unit: 'minute', range: '0-59', defaultValue: '0' },
    { address: 0x0028, access: 'RW', label: 'Timer 2 enable', range: '0 Off, 1 On', defaultValue: '0' },
    { address: 0x0029, access: 'RW', label: 'Timer 2 open hour', unit: 'hour', range: '0-23', defaultValue: '0' },
    { address: 0x002A, access: 'RW', label: 'Timer 2 open minute', unit: 'minute', range: '0-59', defaultValue: '0' },
    { address: 0x002B, access: 'RW', label: 'Timer 2 close hour', unit: 'hour', range: '0-23', defaultValue: '0' },
    { address: 0x002C, access: 'RW', label: 'Timer 2 close minute', unit: 'minute', range: '0-59', defaultValue: '0' },
    { address: 0x002D, access: 'RW', label: 'Timer 3 enable', range: '0 Off, 1 On', defaultValue: '0', note: 'Factory reserved' },
    { address: 0x002E, access: 'RW', label: 'Timer 3 open hour', unit: 'hour', range: '0-23', defaultValue: '0', note: 'Reserved' },
    { address: 0x002F, access: 'RW', label: 'Timer 3 open minute', unit: 'minute', range: '0-59', defaultValue: '0', note: 'Reserved' },
    { address: 0x0030, access: 'RW', label: 'Timer 3 close hour', unit: 'hour', range: '0-23', defaultValue: '0', note: 'Reserved' },
    { address: 0x0031, access: 'RW', label: 'Timer 3 close minute', unit: 'minute', range: '0-59', defaultValue: '0', note: 'Reserved' },
    { address: 0x0032, access: 'RW', label: 'Timer 4 enable', range: '0 Off, 1 On', defaultValue: '0', note: 'Reserved' },
    { address: 0x0033, access: 'RW', label: 'Timer 4 open hour', unit: 'hour', range: '0-23', defaultValue: '0', note: 'Reserved' },
    { address: 0x0034, access: 'RW', label: 'Timer 4 open minute', unit: 'minute', range: '0-59', defaultValue: '0', note: 'Reserved' },
    { address: 0x0035, access: 'RW', label: 'Timer 4 close hour', unit: 'hour', range: '0-23', defaultValue: '0', note: 'Reserved' },
    { address: 0x0036, access: 'RW', label: 'Timer 4 close minute', unit: 'minute', range: '0-59', defaultValue: '0', note: 'Reserved' },
    { address: 0x0037, access: 'RW', label: 'Timer 5 enable', range: '0 Off, 1 On', defaultValue: '0', note: 'Reserved' },
    { address: 0x0038, access: 'RW', label: 'Timer 5 open hour', unit: 'hour', range: '0-23', defaultValue: '0', note: 'Reserved' },
    { address: 0x0039, access: 'RW', label: 'Timer 5 open minute', unit: 'minute', range: '0-59', defaultValue: '0', note: 'Reserved' },
    { address: 0x003A, access: 'RW', label: 'Timer 5 close hour', unit: 'hour', range: '0-23', defaultValue: '0', note: 'Reserved' },
    { address: 0x003B, access: 'RW', label: 'Timer 5 close minute', unit: 'minute', range: '0-59', defaultValue: '0', note: 'Reserved' },
];

export const READ_ONLY_REGISTERS: RegisterInfo[] = [
    { address: 0x8000, access: 'R', label: 'Time limited runtime high byte' },
    { address: 0x8001, access: 'R', label: 'Time limited runtime low byte' },
    {
        address: 0x8002,
        access: 'R',
        label: 'Model',
        values: { 0: 'Hot water', 1: 'Heating', 2: 'Cooling', 3: 'Hot water + Heating', 4: 'Hot water + Cooling', 5: 'Heating + Cooling' },
    },
    { address: 0x8003, access: 'R', label: 'Active fault code', note: '0xFF means no active fault.' },
    { address: 0x8004, access: 'R', label: 'Fault history 1 (reserved)' },
    { address: 0x8005, access: 'R', label: 'Fault history 2 (reserved)' },
    { address: 0x8006, access: 'R', label: 'Fault history 3 (reserved)' },
    { address: 0x8007, access: 'R', label: 'Fault history 4 (reserved)' },
    { address: 0x8008, access: 'R', label: 'Fault history 5 (reserved)' },
    { address: 0x8009, access: 'R', label: 'Fault history 6 (reserved)' },
    { address: 0x800A, access: 'R', label: 'Output sign 1', range: 'Bitfield' },
    { address: 0x800B, access: 'R', label: 'Output sign 2', range: 'Bitfield' },
    { address: 0x800C, access: 'R', label: 'Status sign 1', range: 'Bitfield' },
    { address: 0x800D, access: 'R', label: 'Status sign 2 (reserved)', range: 'Bitfield' },
    { address: 0x800E, access: 'R', label: 'Fault sign 1', range: 'Bitfield' },
    { address: 0x800F, access: 'R', label: 'Fault sign 2', range: 'Bitfield' },
    { address: 0x8010, access: 'R', label: 'Fault sign 3', range: 'Bitfield' },
    { address: 0x8011, access: 'R', label: 'Fault sign 4', range: 'Bitfield' },
    { address: 0x8012, access: 'R', label: 'Fault sign 5', range: 'Bitfield' },
    { address: 0x8013, access: 'R', label: 'Hot water tank temperature', unit: 'deg C' },
    { address: 0x8014, access: 'R', label: 'Hot water outlet temperature', unit: 'deg C' },
    { address: 0x8015, access: 'R', label: 'Ambient temperature', unit: 'deg C' },
    { address: 0x8016, access: 'R', label: 'Air conditioning inlet water temperature', unit: 'deg C' },
    { address: 0x8017, access: 'R', label: 'Air conditioning outlet water temperature', unit: 'deg C' },
    { address: 0x8018, access: 'R', label: 'Coil temperature 1', unit: 'deg C' },
    { address: 0x8019, access: 'R', label: 'Exhaust temperature 1', unit: 'deg C' },
    { address: 0x801A, access: 'R', label: 'Air return temperature 1', unit: 'deg C' },
    { address: 0x801B, access: 'R', label: 'Compressor current 1', unit: 'A' },
    { address: 0x801C, access: 'R', label: 'Coil temperature 2', unit: 'deg C' },
    { address: 0x801D, access: 'R', label: 'Exhaust temperature 2', unit: 'deg C' },
    { address: 0x801E, access: 'R', label: 'Air return temperature 2', unit: 'deg C' },
    { address: 0x801F, access: 'R', label: 'Compressor current 2', unit: 'A' },
    { address: 0x8020, access: 'R', label: 'EEV 1 steps', note: 'Value scaled by 10.' },
    { address: 0x8021, access: 'R', label: 'EEV 2 steps', note: 'Value scaled by 10.' },
];

export const CONTROL_SIGN_1: Bitfield = {
    register: 0x0000,
    label: 'Control sign 1',
    flags: [
        { bit: 0, label: 'System enable', zeroLabel: 'Off', oneLabel: 'On', defaultState: 0 },
        { bit: 1, label: 'Pump with auxiliary heater (F2)', zeroLabel: 'No', oneLabel: 'Yes', defaultState: 0 },
        { bit: 2, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved', defaultState: 0 },
        { bit: 3, label: 'Water flow switch topology (F4)', zeroLabel: 'Separate', oneLabel: 'Shared', defaultState: 0 },
        { bit: 4, label: 'Electronic expansion valve mode (P6)', zeroLabel: 'Manual', oneLabel: 'Automatic', defaultState: 1 },
        { bit: 5, label: 'Energy saving mode', zeroLabel: 'Off', oneLabel: 'On', defaultState: 0 },
        { bit: 6, label: 'Water pump selection (F5)', zeroLabel: 'General', oneLabel: 'Special', defaultState: 1 },
        { bit: 7, label: 'System type (F7)', zeroLabel: 'Dual', oneLabel: 'Single', defaultState: 0 },
    ],
};

export const CONTROL_SIGN_2: Bitfield = {
    register: 0x0001,
    label: 'Control sign 2',
    flags: [
        { bit: 0, label: 'Manual defrost', zeroLabel: 'Off', oneLabel: 'On', defaultState: 0 },
        { bit: 1, label: 'Manual electric heating', zeroLabel: 'Off', oneLabel: 'On', defaultState: 0 },
        { bit: 2, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved', defaultState: 0 },
        { bit: 3, label: 'Onboard energy level', zeroLabel: 'Off', oneLabel: 'On', defaultState: 0 },
        { bit: 4, label: 'Online energy level', zeroLabel: 'Off', oneLabel: 'On', defaultState: 0 },
        { bit: 5, label: 'Auxiliary heater mode (F6)', zeroLabel: 'Hot water', oneLabel: 'Air conditioning', defaultState: 0 },
        { bit: 6, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved', defaultState: 0 },
        { bit: 7, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved', defaultState: 0 },
    ],
};

export const OUTPUT_SIGN_1: Bitfield = {
    register: 0x800A,
    label: 'Output sign 1',
    flags: [
        { bit: 0, label: 'Compressor 1', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 1, label: 'External fan motor', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 2, label: 'Four-way valve', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 3, label: 'Circulating pump', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 4, label: 'Electric heating', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 5, label: 'Three-way valve', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 6, label: 'Crankshaft heater', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 7, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
    ],
};

export const OUTPUT_SIGN_2: Bitfield = {
    register: 0x800B,
    label: 'Output sign 2',
    flags: [
        { bit: 0, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 1, label: 'High fan speed', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 2, label: 'Low fan speed', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 3, label: 'Bypass valve 1', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 4, label: 'Compressor 2', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 5, label: 'Bypass valve 2', zeroLabel: 'Off', oneLabel: 'On' },
        { bit: 6, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 7, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
    ],
};

export const STATUS_SIGN_1: Bitfield = {
    register: 0x800C,
    label: 'Status sign 1',
    flags: [
        { bit: 0, label: 'Defrost active', zeroLabel: 'No', oneLabel: 'Yes' },
        { bit: 1, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 2, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 3, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 4, label: 'Phase type', zeroLabel: 'Single phase', oneLabel: 'Three phase' },
        { bit: 5, label: 'Wired remote state', zeroLabel: 'On', oneLabel: 'Off' },
        { bit: 6, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 7, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
    ],
};

export const FAULT_SIGN_1: Bitfield = {
    register: 0x800E,
    label: 'Fault sign 1',
    flags: [
        { bit: 0, label: 'Hot water tank temperature fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 1, label: 'Ambient sensor fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 2, label: 'Coil 1 sensor fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 3, label: 'Exhaust 1 sensor fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 4, label: 'Air return 1 sensor fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 5, label: 'High pressure 1 fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 6, label: 'Low pressure 1 fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 7, label: 'Hot water flow fault', zeroLabel: 'None', oneLabel: 'Present' },
    ],
};

export const FAULT_SIGN_2: Bitfield = {
    register: 0x800F,
    label: 'Fault sign 2',
    flags: [
        { bit: 0, label: 'Air conditioning flow fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 1, label: 'Low ambient protection', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 2, label: 'Anti-freeze protection', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 3, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 4, label: 'Exhaust 1 over temperature', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 5, label: 'Compressor 1 over current', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 6, label: 'Air conditioning inlet temperature fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 7, label: 'Air conditioning outlet temperature fault', zeroLabel: 'None', oneLabel: 'Present' },
    ],
};

export const FAULT_SIGN_3: Bitfield = {
    register: 0x8010,
    label: 'Fault sign 3',
    flags: [
        { bit: 0, label: 'Cooling over-cooling protection', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 1, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 2, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 3, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 4, label: 'Hot water outlet temp fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 5, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 6, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 7, label: 'Coil 2 temperature fault', zeroLabel: 'None', oneLabel: 'Present' },
    ],
};

export const FAULT_SIGN_4: Bitfield = {
    register: 0x8011,
    label: 'Fault sign 4',
    flags: [
        { bit: 0, label: 'Air return 2 temperature fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 1, label: 'Exhaust 2 temperature fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 2, label: 'Exhaust 2 over temperature', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 3, label: 'High pressure 2 fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 4, label: 'Low pressure 2 fault', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 5, label: 'Compressor 2 over current', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 6, label: 'Time limited lock', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 7, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
    ],
};

export const FAULT_SIGN_5: Bitfield = {
    register: 0x8012,
    label: 'Fault sign 5',
    flags: [
        { bit: 0, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 1, label: 'Large inlet-outlet delta protection', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 2, label: 'Wrong phase', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 3, label: 'Phase loss', zeroLabel: 'None', oneLabel: 'Present' },
        { bit: 4, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 5, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 6, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
        { bit: 7, label: 'Reserved', zeroLabel: 'Reserved', oneLabel: 'Reserved' },
    ],
};

export const BITFIELDS: Bitfield[] = [
    CONTROL_SIGN_1,
    CONTROL_SIGN_2,
    OUTPUT_SIGN_1,
    OUTPUT_SIGN_2,
    STATUS_SIGN_1,
    FAULT_SIGN_1,
    FAULT_SIGN_2,
    FAULT_SIGN_3,
    FAULT_SIGN_4,
    FAULT_SIGN_5,
];

export const FAULT_CODES: FaultCode[] = [
    { code: 'Er 01', description: 'Phase fault' },
    { code: 'Er 02', description: 'Phase missing' },
    { code: 'Er 03', description: 'DHW water flow failure' },
    { code: 'Er 04', description: 'Heating or cooling water flow failure' },
    { code: 'Er 05', description: 'System 1 high pressure protection' },
    { code: 'Er 06', description: 'System 1 low pressure protection' },
    { code: 'Er 07', description: 'System 2 high pressure protection' },
    { code: 'Er 08', description: 'System 2 low pressure protection' },
    { code: 'Er 09', description: 'Communication failure' },
    { code: 'Er 10', description: 'DHW temperature sensor failure' },
    { code: 'Er 11', description: 'Countdown lock active' },
    { code: 'Er 12', description: 'System 1 high discharge temperature protection' },
    { code: 'Er 13', description: 'System 2 high discharge temperature protection' },
    { code: 'Er 16', description: 'System 1 coil temperature sensor failure' },
    { code: 'Er 17', description: 'System 2 coil temperature sensor failure' },
    { code: 'Er 18', description: 'System 1 discharge temperature sensor failure' },
    { code: 'Er 19', description: 'System 2 discharge temperature sensor failure' },
    { code: 'Er 20', description: 'Ambient temperature sensor failure' },
    { code: 'Er 21', description: 'Heating or cooling inlet temperature sensor failure' },
    { code: 'Er 22', description: 'DHW outlet temperature sensor failure' },
    { code: 'Er 23', description: 'System 1 suction temperature sensor failure' },
    { code: 'Er 24', description: 'System 1 discharge temperature sensor failure' },
    { code: 'Er 29', description: 'System 1 compressor over-current' },
    { code: 'Er 30', description: 'System 2 compressor over-current' },
    { code: 'Er 32', description: 'Low ambient temperature protection' },
    { code: 'Er 33', description: 'Heating or cooling outlet temperature sensor failure' },
    { code: 'Er 34', description: 'Low outlet water temperature protection (cooling)' },
    { code: 'Er 37', description: 'Large inlet-outlet temperature difference' },
    { code: 'Er 99', description: 'Communication failure' },
];

export function getRegister(address: number): RegisterInfo | undefined {
    return HOLDING_REGISTERS.find((reg) => reg.address === address)
        ?? READ_ONLY_REGISTERS.find((reg) => reg.address === address);
}

export function isHoldingRegister(address: number): boolean {
    return HOLDING_REGISTERS.some((reg) => reg.address === address);
}

export function isReadOnlyRegister(address: number): boolean {
    return READ_ONLY_REGISTERS.some((reg) => reg.address === address);
}

const REGISTER_LOOKUP = new Map<number, RegisterInfo>([
    ...HOLDING_REGISTERS.map((reg): [number, RegisterInfo] => [reg.address, reg]),
    ...READ_ONLY_REGISTERS.map((reg): [number, RegisterInfo] => [reg.address, reg]),
]);

const BITFIELD_LOOKUP = new Map<number, Bitfield>(BITFIELDS.map((field): [number, Bitfield] => [field.register, field]));
const FAULT_BITFIELD_REGISTERS = new Set<number>([
    FAULT_SIGN_1.register,
    FAULT_SIGN_2.register,
    FAULT_SIGN_3.register,
    FAULT_SIGN_4.register,
    FAULT_SIGN_5.register,
]);

const MODE_NAMES: Record<number, string> = {
    0: 'hot water',
    1: 'heating',
    2: 'cooling',
    3: 'hot water + heating',
    4: 'hot water + cooling',
    5: 'heating + cooling',
};

const FAULT_CODE_LOOKUP = (() => {
    const entries: Array<[number, string]> = [];
    for (const fault of FAULT_CODES) {
        const match = fault.code.match(/\d+/);
        if (!match) continue;
        const codeNumber = Number(match[0]);
        if (Number.isFinite(codeNumber)) {
            entries.push([codeNumber, fault.description]);
        }
    }
    return new Map<number, string>(entries);
})();

function slugify(label: string): string {
    return label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function toSigned16(value: number): number {
    const masked = value & 0xffff;
    return masked >= 0x8000 ? masked - 0x10000 : masked;
}

function decodeTemperature(raw: number): number {
    const signed = toSigned16(raw);
    if (signed !== 0 && signed % 10 === 0 && Math.abs(signed) >= 100) {
        return signed / 10;
    }
    return signed;
}

function normalizeFlags(value: number, bitfield: Bitfield): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const flag of bitfield.flags) {
        const active = ((value >> flag.bit) & 1) === 1;
        result[slugify(flag.label)] = active;
    }
    return result;
}

function formatFaultCode(code: number): { code: string; description?: string } | undefined {
    if (!Number.isInteger(code) || code < 0) {
        return undefined;
    }
    if (code === 0xff) {
        return undefined;
    }
    const normalized = code % 100;
    const formatted = `Er ${normalized.toString().padStart(2, '0')}`;
    return { code: formatted, description: FAULT_CODE_LOOKUP.get(normalized) };
}

export type RegisterSnapshot = Record<number, number>;

export function normalizeRegisterMap(
    input: Record<string | number, unknown> | undefined | null,
): RegisterSnapshot {
    const snapshot: RegisterSnapshot = {};
    if (!input || typeof input !== 'object') {
        return snapshot;
    }
    for (const [rawKey, rawValue] of Object.entries(input)) {
        let address: number | null = null;
        if (typeof rawKey === 'number') {
            address = Number.isFinite(rawKey) ? Math.trunc(rawKey) : null;
        } else {
            const trimmed = rawKey.trim();
            if (/^0x[0-9a-f]{1,4}$/i.test(trimmed)) {
                address = parseInt(trimmed, 16);
            } else if (/^[0-9]{1,5}$/.test(trimmed)) {
                address = parseInt(trimmed, 10);
            }
        }
        if (address == null || address < 0 || address > 0xffff) {
            continue;
        }
        const numeric =
            typeof rawValue === 'number'
                ? rawValue
                : typeof rawValue === 'string'
                  ? Number(rawValue)
                  : Number.NaN;
        if (!Number.isFinite(numeric)) {
            continue;
        }
        snapshot[address] = Math.trunc(numeric);
    }
    return snapshot;
}

export interface DecodedRegisterTelemetry {
    metrics: TelemetryPayload['metrics'];
    status: TelemetryPayload['status'];
    faults: NonNullable<TelemetryPayload['faults']>;
    registers: RegisterSnapshot;
}

export function decodeTelemetryFromRegisters(registers: RegisterSnapshot): DecodedRegisterTelemetry {
    const metrics: TelemetryPayload['metrics'] = {};
    const status: TelemetryPayload['status'] = {};
    const faults: NonNullable<TelemetryPayload['faults']> = [];
    const flagGroups: Record<string, Record<string, boolean>> = {};

    const tank = registers[0x8013];
    if (tank != null) {
        metrics.tankC = decodeTemperature(tank);
    }
    const ambient = registers[0x8015];
    if (ambient != null) {
        metrics.ambientC = decodeTemperature(ambient);
    }
    const inlet = registers[0x8016];
    if (inlet != null) {
        metrics.returnC = metrics.returnC ?? decodeTemperature(inlet);
    }
    const outlet = registers[0x8017];
    if (outlet != null) {
        metrics.supplyC = decodeTemperature(outlet);
    }
    const hwOutlet = registers[0x8014];
    if (hwOutlet != null && metrics.supplyC == null) {
        metrics.supplyC = decodeTemperature(hwOutlet);
    }
    const compCurrent = registers[0x801B];
    if (compCurrent != null) {
        metrics.compCurrentA = toSigned16(compCurrent);
    }
    const eev1 = registers[0x8020];
    if (eev1 != null) {
        metrics.eevSteps = toSigned16(eev1);
    }

    const model = registers[0x8002];
    if (model != null) {
        const normalized = model & 0xffff;
        status.mode = MODE_NAMES[normalized] ?? `mode ${normalized}`;
    }

    for (const bitfield of BITFIELDS) {
        const value = registers[bitfield.register];
        if (value == null) {
            continue;
        }
        const flags = normalizeFlags(value, bitfield);
        if (Object.keys(flags).length > 0) {
            flagGroups[slugify(bitfield.label)] = flags;
        }
        if (bitfield.register === STATUS_SIGN_1.register) {
            if ('defrost_active' in flags) {
                status.defrost = Boolean(flags.defrost_active);
            }
        }
        if (FAULT_BITFIELD_REGISTERS.has(bitfield.register)) {
            for (const flag of bitfield.flags) {
                const active = ((value >> flag.bit) & 1) === 1;
                if (!active) continue;
                const code = `fault.${slugify(bitfield.label)}.${slugify(flag.label)}`;
                faults.push({ code, description: flag.label, active: true });
            }
        }
    }

    const activeFaultCode = registers[0x8003];
    const formattedFault = activeFaultCode != null ? formatFaultCode(activeFaultCode) : undefined;
    if (formattedFault) {
        faults.push({ code: formattedFault.code, description: formattedFault.description, active: true });
    }

    if (Object.keys(flagGroups).length > 0) {
        status.flags = flagGroups;
    }
    if (status.online === undefined) {
        status.online = true;
    }

    // Remove metrics entries that remained undefined after decoding
    for (const key of Object.keys(metrics)) {
        if (metrics[key as keyof typeof metrics] == null) {
            delete metrics[key as keyof typeof metrics];
        }
    }

    return { metrics, status, faults, registers };
}
