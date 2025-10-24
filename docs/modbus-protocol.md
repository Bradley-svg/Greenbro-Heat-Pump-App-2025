# MODBUS RTU Reference (Factory Spec)

This document consolidates the factory documentation for the Kolant/Greenbro heat pump family. It covers the RS-485 MODBUS RTU link, address formation, supported function codes, register map, control bitfields, parameter tables, diagnostics, and integration notes for the Greenbro cloud platform.

## Bus and Addressing

- Physical layer: RS-485 multi-drop, asynchronous serial 8N1 (1 start bit, 8 data bits, no parity, 1 stop bit).
- Transport: MODBUS RTU frame format with CRC-16 (low byte first, high byte second).
- Master/slave: Host computer (or edge gateway) is the master. Controllers/screens are slaves.
- Each screen supervises up to 16 machines. Device address = PCB dial code (0-15) + screen parameter "Address" (0-15) * 16.
  - Screen address 0 => machines 1-16.
  - Screen address 1 => machines 17-32.
  - Screen address 10 => machines 161-176.
- Multiple screens can share a bus if each screen uses a unique address. Dial codes may repeat across screens because of the 16-address offset.

## Supported Function Codes

| Function | Hex | Request Frame (high byte first for addresses/data) | Response Frame |
|----------|-----|----------------------------------------------------|----------------|
| Read holding registers | 0x03 | `[Addr][03][StartHi][StartLo][CountHi][CountLo][CRCLo][CRCHi]` | `[Addr][03][ByteCount][Data...][CRCLo][CRCHi]` |
| Write single register | 0x06 | `[Addr][06][RegHi][RegLo][DataHi][DataLo][CRCLo][CRCHi]` | Echo of request on success (no reply if rejected) |
| Write multiple registers | 0x10 | `[Addr][10][StartHi][StartLo][CountHi][CountLo][ByteCount][Payload...][CRCLo][CRCHi]` | `[Addr][10][StartHi][StartLo][CountHi][CountLo][CRCLo][CRCHi]` |

> Register offsets in this document are zero-based MODBUS addresses (inclusive).

## Holding Registers 0x0000-0x003B (Read/Write)

| Addr | Label | Access | Range / Values | Default | Notes |
|------|-------|--------|----------------|---------|-------|
| 0x0000 | Control sign 1 | RW | Bitfield | 0x0000 | See Control sign 1 flags |
| 0x0001 | Control sign 2 | RW | Bitfield | 0x0000 | See Control sign 2 flags |
| 0x0002 | Mode selection | RW | 0 HW, 1 Heating, 2 Cooling, 3 HW+Heating, 4 HW+Cooling | 0 | Default domestic hot water (DHW) |
| 0x0003 | L0 return hot water delta | RW | 2-18 deg C | 3 | DHW hysteresis |
| 0x0004 | L1 DHW setpoint | RW | 20 deg C to F1 | 55 | Default DHW temperature |
| 0x0005 | L2 heating/cooling hysteresis | RW | 2-18 deg C | 3 | Heating and cooling restart diff |
| 0x0006 | L3 heating setpoint | RW | 20 deg C to F1 | 50 | Default heating water temp |
| 0x0007 | L4 cooling setpoint | RW | 7-30 deg C | 12 | Default cooling water temp |
| 0x0008 | L5 ambient threshold for electric heater | RW | -30 to 35 deg C | 0 | Heater engages when ambient below setpoint |
| 0x0009 | Reserved | RW | - | - | - |
| 0x000A | Reserved | RW | - | - | - |
| 0x000B | L6 compressor current limit | RW | 0-60 A | 15 | Real value is shown value * 1.25. 0 skips check. |
| 0x000C | H2 low ambient cutoff | RW | -30 to 0 deg C | -10 | Stops unit below setpoint |
| 0x000D | H3 defrost interval | RW | 20-90 min | 45 | Minimum time between defrost cycles |
| 0x000E | H4 defrost entry coil temp | RW | -15 to -1 deg C | -3 | Defrost eligible when coil <= value |
| 0x000F | H5 max defrost duration | RW | 5-20 min | 8 | Auto-exit once limit reached |
| 0x0010 | H6 defrost exit temp | RW | 1-40 deg C | 20 | Exit defrost when coil >= value |
| 0x0011 | H7 ambient vs coil delta | RW | 0-15 deg C | 0 | Minimum delta to allow defrost |
| 0x0012 | H8 ambient limit for defrost | RW | 0-20 deg C | 15 | Blocks defrost when ambient >= value |
| 0x0013 | P1 EEV regulation period | RW | 20-90 s | 45 | Action period for electronic expansion valve |
| 0x0014 | P2 EEV target superheat | RW | -5 to 10 deg C | 0 | Superheat setpoint |
| 0x0015 | P3 discharge temp limit | RW | 60-115 deg C | 88 | Adjust EEV if discharge above limit |
| 0x0016 | P4 defrost EEV opening | RW | 2-45 | 45 | Multiply by 10 before applying |
| 0x0017 | P5 EEV minimum opening | RW | 5-20 | 12 | Multiply by 10 before applying |
| 0x0018 | P7 manual EEV steps | RW | 2-50 | 40 | Divide by 10 when applying in manual mode |
| 0x0019 | F1 max setpoint limit | RW | 20-99 deg C | 60 | Upper bound used by L1, L3 |
| 0x001A | F3 display offset | RW | -5 to 15 deg C | 2 | Compensation between tank sensor and display |
| 0x001B | Reserved | RW | - | - | - |
| 0x001C | F8 superheat compensation enable | RW | 0 Off, 1 On | 0 | See also special parameter F8 below |
| 0x001D | F8 time limited lock cycles | RW | 0-99 cycles | 0 | Lockout counter |
| 0x001E | F11 cascade check interval | RW | 1-15 min | 15 | Energy level inspection period |
| 0x001F | F12 power on unit share | RW | 1-4 | 1 | Units started = floor(total units * 25%) |
| 0x0020 | Reserved | RW | - | - | - |
| 0x0021 | Reserved | RW | - | - | - |
| 0x0022 | Reserved | RW | - | - | - |
| 0x0023-0x003B | Timers 1-5 enable/open/close (hours and minutes) | RW | 0-23 hours, 0-59 minutes | 0 | Timers 3-5 marked reserved in factory doc |

## Read-Only Registers 0x8000-0x8021

| Addr | Label | Notes |
|------|-------|-------|
| 0x8000 | Time limited runtime high byte | Combine with 0x8001 |
| 0x8001 | Time limited runtime low byte | - |
| 0x8002 | Model | 0 HW, 1 Heating, 2 Cooling, 3 HW+Heating, 4 HW+Cooling, 5 Heating+Cooling |
| 0x8003 | Active fault code | 0xFF means no active fault |
| 0x8004-0x8009 | Fault history 1-6 | Reserved in factory sheet |
| 0x800A | Output sign 1 | Bitfield (see below) |
| 0x800B | Output sign 2 | Bitfield |
| 0x800C | Status sign 1 | Bitfield |
| 0x800D | Status sign 2 | Reserved bitfield |
| 0x800E | Fault sign 1 | Bitfield |
| 0x800F | Fault sign 2 | Bitfield |
| 0x8010 | Fault sign 3 | Bitfield |
| 0x8011 | Fault sign 4 | Bitfield |
| 0x8012 | Fault sign 5 | Bitfield |
| 0x8013 | Hot water tank temperature | deg C |
| 0x8014 | Hot water outlet temperature | deg C |
| 0x8015 | Ambient temperature | deg C |
| 0x8016 | Air conditioning inlet water temperature | deg C |
| 0x8017 | Air conditioning outlet water temperature | deg C |
| 0x8018 | Coil temperature 1 | deg C |
| 0x8019 | Exhaust temperature 1 | deg C |
| 0x801A | Air return temperature 1 | deg C |
| 0x801B | Compressor current 1 | A |
| 0x801C | Coil temperature 2 | deg C |
| 0x801D | Exhaust temperature 2 | deg C |
| 0x801E | Air return temperature 2 | deg C |
| 0x801F | Compressor current 2 | A |
| 0x8020 | Electronic expansion valve 1 steps | Value * 10 |
| 0x8021 | Electronic expansion valve 2 steps | Value * 10 |

## Control Bitfields

### Control sign 1 (0x0000, RW)

| Bit | Meaning | 0 | 1 | Default |
|-----|---------|---|---|---------|
| 0 | System enable | Off | On | 0 |
| 1 | Circulating pump when F2 electric heating active | No | Yes | 0 |
| 2 | Reserved | - | - | 0 |
| 3 | F4 water flow switch topology | Separate | Shared | 0 |
| 4 | P6 electronic expansion valve mode | Manual | Automatic | 1 |
| 5 | Energy saving mode | Off | On | 0 |
| 6 | F5 pump mode | General | Special | 1 |
| 7 | F7 system type | Dual system | Single system | 0 |

### Control sign 2 (0x0001, RW)

| Bit | Meaning | 0 | 1 | Default |
|-----|---------|---|---|---------|
| 0 | Manual defrost | Off | On | 0 |
| 1 | Manual electric heating | Off | On | 0 |
| 2 | Reserved | - | - | 0 |
| 3 | Onboard energy level | Off | On | 0 |
| 4 | Online energy level | Off | On | 0 |
| 5 | F6 auxiliary heater mode | Hot water | Air conditioning | 0 |
| 6 | Reserved | - | - | 0 |
| 7 | Reserved | - | - | 0 |

### Output sign 1 (0x800A, R)

| Bit | Meaning |
|-----|---------|
| 0 | Compressor 1 |
| 1 | External fan motor |
| 2 | Four-way valve |
| 3 | Circulating pump |
| 4 | Electric heating |
| 5 | Three-way valve |
| 6 | Crankshaft heater |
| 7 | Reserved |

### Output sign 2 (0x800B, R)

| Bit | Meaning |
|-----|---------|
| 0 | Reserved |
| 1 | High fan speed |
| 2 | Low fan speed |
| 3 | Bypass valve 1 |
| 4 | Compressor 2 |
| 5 | Bypass valve 2 |
| 6 | Reserved |
| 7 | Reserved |

### Status sign 1 (0x800C, R)

| Bit | Meaning | 0 | 1 |
|-----|---------|---|---|
| 0 | Defrost active | No | Yes |
| 1 | Reserved | - | - |
| 2 | Reserved | - | - |
| 3 | Reserved | - | - |
| 4 | Phase type | Single phase | Three phase |
| 5 | Wired remote state | ON | OFF |
| 6 | Reserved | - | - |
| 7 | Reserved | - | - |

### Fault sign bitfields (0x800E-0x8012, R)

| Register | Bit | Description |
|----------|-----|-------------|
| 0x800E | 0 | Hot water tank temperature fault |
| 0x800E | 1 | Ambient sensor fault |
| 0x800E | 2 | Coil 1 sensor fault |
| 0x800E | 3 | Exhaust 1 sensor fault |
| 0x800E | 4 | Air return 1 sensor fault |
| 0x800E | 5 | High pressure 1 protection |
| 0x800E | 6 | Low pressure 1 protection |
| 0x800E | 7 | Hot water flow fault |
| 0x800F | 0 | Air conditioning flow fault |
| 0x800F | 1 | Low ambient protection |
| 0x800F | 2 | Anti-freeze protection |
| 0x800F | 3 | Reserved |
| 0x800F | 4 | Exhaust 1 over temperature |
| 0x800F | 5 | Compressor 1 over current |
| 0x800F | 6 | Air conditioning inlet temp fault |
| 0x800F | 7 | Air conditioning outlet temp fault |
| 0x8010 | 0 | Cooling over-cooling protection |
| 0x8010 | 1 | Reserved |
| 0x8010 | 2 | Reserved |
| 0x8010 | 3 | Reserved |
| 0x8010 | 4 | Hot water outlet temp fault |
| 0x8010 | 5 | Reserved |
| 0x8010 | 6 | Reserved |
| 0x8010 | 7 | Coil 2 temperature fault |
| 0x8011 | 0 | Air return 2 temperature fault |
| 0x8011 | 1 | Exhaust 2 temperature fault |
| 0x8011 | 2 | Exhaust 2 over temperature |
| 0x8011 | 3 | High pressure 2 protection |
| 0x8011 | 4 | Low pressure 2 protection |
| 0x8011 | 5 | Compressor 2 over current |
| 0x8011 | 6 | Time limited lock |
| 0x8011 | 7 | Reserved |
| 0x8012 | 0 | Reserved |
| 0x8012 | 1 | Large inlet-outlet delta protection |
| 0x8012 | 2 | Wrong phase |
| 0x8012 | 3 | Phase loss |
| 0x8012 | 4 | Reserved |
| 0x8012 | 5 | Reserved |
| 0x8012 | 6 | Reserved |
| 0x8012 | 7 | Reserved |

## Parameter Tables

### User parameters (L-series)

| Code | Register | Description | Range | Default | Notes |
|------|----------|-------------|-------|---------|-------|
| L0 | 0x0003 | DHW water temperature hysteresis | 2-18 deg C | 3 deg C | Stops when temp >= setpoint, restarts when temp <= setpoint minus hysteresis |
| L1 | 0x0004 | DHW setpoint | 20 deg C to F1 | 55 deg C | Default DHW target |
| L2 | 0x0005 | Heating/cooling hysteresis | 2-18 deg C | 3 deg C | Heating: restart below set minus hysteresis. Cooling: restart above set plus hysteresis. |
| L3 | 0x0006 | Heating setpoint | 20 deg C to F1 | 50 deg C | Default heating water temp |
| L4 | 0x0007 | Cooling setpoint | 7-30 deg C | 12 deg C | Default cooling water temp |
| L5 | 0x0008 | Ambient threshold for auxiliary heater | -30 to 35 deg C | 0 deg C | Heater turns on when ambient < value |
| L6 | 0x000B | Compressor current protection | 0-40 A | 15 A | Real current limit = displayed * 1.25. 0 ignores limit. |

### Factory parameters (H/P/F series)

| Code | Register | Description | Range | Default | Notes |
|------|----------|-------------|-------|---------|-------|
| H2 | 0x000C | Minimum ambient for operation | -30 to 0 deg C | -10 deg C | Stops below set, restarts above |
| H3 | 0x000D | Defrost interval | 20-90 min | 45 min | Minimum time between defrost events |
| H4 | 0x000E | Defrost entry coil temp | -15 to -1 deg C | -3 deg C | Defrost allowed when coil <= value |
| H5 | 0x000F | Max defrost duration | 5-20 min | 8 min | Forced exit when exceeded |
| H6 | 0x0010 | Defrost exit coil temp | 1-40 deg C | 20 deg C | Exit defrost when coil >= value |
| H7 | 0x0011 | Ambient vs coil delta for defrost | 0-15 deg C | 0 deg C | Minimum difference required |
| H8 | 0x0012 | Ambient limit for defrost | 0-20 deg C | 15 deg C | No defrost when ambient >= value |
| P1 | 0x0013 | EEV regulation period | 20-90 s | 45 s | - |
| P2 | 0x0014 | EEV target overheat | -5 to 10 deg C | 0 deg C | - |
| P3 | 0x0015 | Discharge temp threshold for EEV gain | 60-115 deg C | 88 deg C | Increases opening when exceeded |
| P4 | 0x0016 | EEV steps during defrost | 2-45 | 45 | Multiply displayed value by 10 |
| P5 | 0x0017 | Minimum EEV steps | 5-20 | 12 | Multiply displayed value by 10 |
| P6 | Control sign 1 bit 4 | EEV control mode | 0 manual, 1 automatic | 1 | - |
| P7 | 0x0018 | Manual EEV steps | 2-50 | 40 | Multiply displayed value by 10 |
| F1 | 0x0019 | Maximum setpoint | 20-99 deg C | 60 deg C | Upper bound for user temps |
| F2 | Control sign 1 bit 1 | Pump with auxiliary heater | 0 OFF, 1 ON | 0 | - |
| F3 | 0x001A | Tank vs display offset | -5 to 15 deg C | 2 deg C | - |
| F4 | Control sign 1 bit 3 | Flow switch topology | 0 separate, 1 common | 0 | Central control wiring |
| F5 | Control sign 1 bit 6 | Pump mode | 0 normal, 1 special | 1 | Special = pump follows compressor |
| F6 | Control sign 2 bit 5 | Auxiliary heater mode | 0 hot water, 1 heating | 0 | - |
| F7 | Control sign 1 bit 7 | Refrigeration system count | 0 dual, 1 single | 0 | 1 = single system |
| F8 | 0x001C | Superheat compensation | 0 no, 1 yes | 0 | Factory default disables |
| F9 | Reserved | Energy step control internal | 0 ON, 1 OFF | 0 | Mentioned in factory sheet, no MODBUS address provided |
| F10 | Reserved | Energy step control cascade | 0 ON, 1 OFF | 0 | - |
| F11 | 0x001E | Cascade inspection interval | 1-15 min | 15 min | - |
| F12 | 0x001F | Units started after power on | 25-100 percent | 25 percent | floor(total units * 25 percent) |

### Special manufacturer parameter

| Code | Register | Description | Range | Default | Notes |
|------|----------|-------------|-------|---------|-------|
| F8 countdown lock (factory) | 0x001D | Weeks until lock | 0-99 | 0 | Countdown in weeks. 0 disables locking. |

## Unit Status (read-only aliases)

These labels appear in front-panel status menus and map to MODBUS registers.

| Code | Description | Register |
|------|-------------|----------|
| A1 | System 1 coil temperature | 0x8018 |
| A2 | System 1 compressor suction temperature | (not directly provided; inferred) |
| A3 | System 1 compressor discharge temperature | 0x8019 |
| A4 | Ambient temperature | 0x8015 |
| A5 | DHW outlet temperature | 0x8014 |
| A6 | Heating/Cooling outlet water temperature | 0x8017 |
| A7 | Reserved | - |
| A8 | System 1 compressor current | 0x801B |
| A9 | System 1 EEV steps | 0x8020 |
| A10 | Reserved | - |
| b1 | System 2 coil temperature | 0x801C |
| b2 | System 2 suction temperature | (not provided) |
| b3 | System 2 discharge temperature | 0x801D |
| b8 | System 2 compressor current | 0x801F |
| b9 | System 2 EEV steps | 0x8021 |
| E1-E6 | Fault history slots | 0x8004-0x8009 |

## Error Codes (0x8003 active fault and history slots)

| Code | Meaning |
|------|--------|
| Er 01 | Phase fault |
| Er 02 | Phase missing |
| Er 03 | DHW water flow failure |
| Er 04 | Heating/cooling water flow failure |
| Er 05 | System 1 high pressure protection |
| Er 06 | System 1 low pressure protection |
| Er 07 | System 2 high pressure protection |
| Er 08 | System 2 low pressure protection |
| Er 09 | Communication failure |
| Er 10 | DHW temperature sensor failure |
| Er 11 | Countdown lock |
| Er 12 | System 1 high discharge temperature protection |
| Er 13 | System 2 high discharge temperature protection |
| Er 16 | System 1 coil temperature sensor failure |
| Er 17 | System 2 coil temperature sensor failure |
| Er 18 | System 1 discharge temp sensor failure |
| Er 19 | System 2 discharge temp sensor failure |
| Er 20 | Ambient temperature sensor failure |
| Er 21 | Heating/cooling inlet temp sensor failure |
| Er 22 | DHW outlet temperature sensor failure |
| Er 23 | System 1 suction temp sensor failure |
| Er 24 | System 1 discharge temp sensor failure |
| Er 29 | System 1 compressor over-current |
| Er 30 | System 2 compressor over-current |
| Er 32 | Low ambient protection |
| Er 33 | Heating/cooling outlet temperature sensor failure |
| Er 34 | Cooling outlet low temperature protection |
| Er 37 | Large inlet-outlet temperature difference |
| Er 99 | Communication failure |

## Integration Notes

1. **Polling cadence**: The factory spec allows up to 16 screens with 16 devices each. Keep bus utilization below 50 percent by limiting read frames to 30-40 registers per poll and spacing polls at 500-1000 ms per device.
2. **CRC and byte order**: All numeric values use big-endian register ordering. CRC bytes are transmitted low byte first, high byte second.
3. **EEV scaling**: P4 and P5 values are multiplied by 10 before being applied on hardware; P7 values are divided by 10 when displayed to operators.
4. **Fault correlation**: Combine 0x8003 (active error) with fault sign bitfields to distinguish between present faults and latched history.
5. **Cloud ingestion**: Field gateways convert MODBUS telemetry to JSON payloads and push them to the Greenbro worker via HTTPS (or MQTT/TCP where supported). Use the provided AT command `AT+HTTPCLIENTLINE=<transport_type>,<opt>,<content-type>,<host>,<port>,<path>,<data>` for Wi-Fi modules that expose serial AT interfaces.
6. **Connectivity flow**: PLC/controller -> Wi-Fi module -> Greenbro Cloud. The module opens a TCP/IP, HTTP, or MQTT session, sends JSON encoded data, and confirms success via HTTP 2xx or ACK payloads as illustrated in the factory integration diagram.
7. **Security**: When bridging to Greenbro Cloud, terminate TLS at the gateway or module, sign payloads with device keys, and throttle command writes (function codes 0x06, 0x10) to one update per second per device.
8. **Diagnostics**: For bus troubleshooting log all exception responses, monitor Er 09 and Er 99 codes, and compare `Output sign` bitfields with commanded states to confirm action.

## Related TypeScript Definitions

The constants and helper types in `src/lib/modbus.ts` mirror this register map and bitfield layout so that workers, queues, and dashboards can validate commands and decode telemetry consistently.
