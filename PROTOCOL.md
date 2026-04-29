# Cat Printer Bluetooth Protocol

A practical guide to the binary protocol used by GB/MX series thermal printers
(GB01, GB02, GB03, MX05, MX06, MX08, MX10) and how it was reverse-engineered.

---

## 1. Physical Layer

The printer exposes a **Bluetooth Low Energy (BLE)** GATT service.

### Primary service (most devices)

| Role | UUID |
|------|------|
| Service | `0000ae30-0000-1000-8000-00805f9b34fb` |
| TX characteristic (write) | `0000ae01-0000-1000-8000-00805f9b34fb` |
| RX characteristic (notify) | `0000ae02-0000-1000-8000-00805f9b34fb` |

### Alternate service (some older firmware)

| Role | UUID |
|------|------|
| Service | `49535343-fe7d-4ae5-8fa9-9fafd205e455` |
| TX characteristic (write) | `49535343-8841-43f4-a8d4-ecbe34729bb3` |

Commands are written to the **TX characteristic** using
`writeValueWithoutResponse`.
State notifications (paper-out, overheat, pause, busy) arrive on the **RX
characteristic** as NOTIFY packets.

### MTU and chunking

The standard ATT MTU without negotiation is **20 bytes**.
Packets larger than 20 bytes must be split and sent in consecutive 20-byte
writes with a short delay (~5 ms) between each write.
The printer reassembles them internally.

---

## 2. Packet Format

Every command follows the same framing structure:

```
Offset  Size  Value        Description
──────  ────  ───────────  ─────────────────────────────────────
0       1     0x51         Magic header byte 1
1       1     0x78         Magic header byte 2
2       1     CMD          Command opcode (see Section 4)
3       1     TYPE         Sub-type / flags (usually 0x00)
4       2     LEN          Payload length, little-endian uint16
6       N     PAYLOAD      Command-specific payload bytes
6+N     1     CRC8         CRC-8 checksum over PAYLOAD only
7+N     1     0xFF         Magic footer byte
```

Total packet size = `N + 8` bytes (where N = payload length).

### Example: set speed to 5

```
51 78  BD  00  01 00  05  A8  FF
│  │   │   │   │──┘  │   │   └─ footer
│  │   │   │   │     │   └───── CRC8([0x05]) = 0xA8
│  │   │   │   │     └───────── payload: speed value 5
│  │   │   │   └─────────────── payload length = 1 (LE uint16)
│  │   │   └─────────────────── type = 0
│  │   └─────────────────────── command = 0xBD (Set Speed)
└──┴─────────────────────────── magic header
```

---

## 3. CRC-8 Checksum

The checksum covers only the **payload bytes** (not the header, type, length,
or footer).

Algorithm: CRC-8 with polynomial `0x07` (same as CRC-8/SMBUS), no
initial value XOR, no final XOR, processed MSB-first.

```javascript
// 256-entry lookup table (pre-computed for polynomial 0x07)
const CRC8_TABLE = new Uint8Array([
    0x00,0x07,0x0e,0x09,0x1c,0x1b,0x12,0x15, // ...
    // (full table in meow-printer.js Section 1)
]);

function crc8(payload) {
    let crc = 0;
    for (const byte of payload) {
        crc = CRC8_TABLE[(crc ^ byte) & 0xff];
    }
    return crc & 0xff;
}
```

If the payload is empty (length = 0), CRC8 = `0x00`.

---

## 4. Command Opcodes

### Control commands

| Opcode | Name | Payload | Description |
|--------|------|---------|-------------|
| `0xA3` | Get Device State | `[0x00]` | Request current status; response arrives on RX |
| `0xA8` | Get Device Info | `[0x00]` | Request firmware/model info |
| `0xA9` | Update Device | `[0x00]` | Commit settings; send before starting a print job |
| `0xA4` | Set DPI | `[50]` | Set resolution; value 50 = 200 DPI (fixed on all known models) |
| `0xBC` | Prepare Camera | `[0x01, 0x02, 0x01, 0x2D]` | Init sequence; must precede every print job |

### Print quality commands

| Opcode | Name | Payload | Description |
|--------|------|---------|-------------|
| `0xBD` | Set Speed | `uint8` | 1 (slowest/darkest) … 8 (fastest/lightest) |
| `0xAF` | Set Energy | `uint16 LE` | 1 000–65 535; higher = more heat = darker print |
| `0xBE` | Apply Energy | `[0x01]` | Latch the energy value set by 0xAF |

### Bitmap data

| Opcode | Name | Payload | Description |
|--------|------|---------|-------------|
| `0xA2` | Draw Line | `N bytes` | One row of 1-bit bitmap data (MSB = leftmost pixel) |

For a 384-pixel-wide printer, each line payload is `ceil(384/8) = 48 bytes`.
Pixel bit = 1 → print dot (black); 0 → no dot (white / background).

### Paper movement

| Opcode | Name | Payload | Description |
|--------|------|---------|-------------|
| `0xA1` | Feed | `uint16 LE` | Advance paper by N dot-rows without printing |
| `0xA0` | Retract | `uint16 LE` | Reverse feed (not supported on all models) |

### Lattice framing

The lattice commands mark the start and end of a bitmap print session.
They are not well documented; the byte sequences were captured by traffic
analysis and are sent verbatim.

```
Start lattice (0xA6):
  payload = AA 55 17 38 44 5F 5F 5F 44 38 2C

End lattice (0xA6):
  payload = AA 55 17 00 00 00 00 00 00 00 17
```

---

## 5. State Notification Packet (RX)

When the printer sends a state update, the packet follows the same framing.
The status byte is at **offset 6** (first payload byte):

```
Bit  Mask  Meaning
───  ────  ─────────────────────────────
0    0x01  Out of paper
1    0x02  Cover open
2    0x04  Overheat
3    0x08  Low battery / low power
4    0x10  Paused (host should wait before sending more data)
7    0x80  Busy (print head active)
```

The host should poll the Paused bit and hold the TX queue until it clears.

---

## 6. Full Print Sequence

A complete print job uses this sequence:

```
1.  Get Device State        0xA3  [0x00]
2.  Prepare Camera          0xBC  [0x01,0x02,0x01,0x2D]
3.  Set DPI                 0xA4  [50]
4.  Set Speed               0xBD  [speed]          e.g. 5
5.  Set Energy              0xAF  [energy_lo, energy_hi]  e.g. 0x40,0x1F = 8000
6.  Apply Energy            0xBE  [0x01]
7.  Update Device           0xA9  [0x00]
8.  Start Lattice           0xA6  [AA 55 17 38 44 5F 5F 5F 44 38 2C]
    ── flush all above in one BLE write sequence ──
9.  Draw Line × H           0xA2  [48 bytes per line]   (repeat for each row)
    ── flush in chunks respecting 20-byte MTU ──
10. End Lattice             0xA6  [AA 55 17 00 00 00 00 00 00 00 17]
11. Set Speed (max)         0xBD  [0x08]            reset to fast for feed
12. Feed                    0xA1  [feed_lo, feed_hi] e.g. 80 dot-rows
13. Get Device State        0xA3  [0x00]
    ── final flush ──
```

Steps 1–8 are buffered and flushed together.
Step 9 is sent in a loop, flushing every ~200 bytes to respect the internal
buffer size.
Steps 10–13 are buffered and flushed together.

---

## 7. Bitmap Line Encoding

Each line is a packed 1-bit-per-pixel row, **MSB first** (leftmost pixel =
bit 7 of byte 0).

```
Pixel column:  0  1  2  3  4  5  6  7  8  9 10 11 ...
Byte index:    ├──── byte[0] ────┤  ├──── byte[1] ───
Bit position:  7  6  5  4  3  2  1  0  7  6  5  4 ...
```

To set pixel at column `x` to black:

```javascript
const byteIndex = Math.floor(x / 8);
const bitMask   = 0x80 >> (x % 8);   // MSB-first
row[byteIndex] |= bitMask;
```

For a 384-pixel printer, each row is exactly 48 bytes.

### Image preparation pipeline

```
Source image
    │
    ▼
Resize to print width (e.g. 384 px), maintain aspect ratio
    │
    ▼
Apply contrast adjustment (CSS filter on offscreen canvas)
    │
    ▼
Convert RGB → greyscale luminance
    luma = 0.299·R + 0.587·G + 0.114·B
    │
    ▼
Dithering (Atkinson or Floyd-Steinberg error diffusion)
    │
    ▼
Threshold: luma < 128 → black pixel (bit = 1)
           luma ≥ 128 → white pixel (bit = 0)
    │
    ▼
Pack 8 pixels per byte, MSB-first
    │
    ▼
Send as 0xA2 Draw Line packets
```

---

## 8. Reverse Engineering Notes

### Tools used

- **nRF Connect** (Android) — GATT browser and packet sniffer; used to
  enumerate services, characteristics, and capture raw HEX notifications.
- **Wireshark + Android Bluetooth HCI log** — enabled via Developer Options →
  *Enable Bluetooth HCI snoop log*. Captures the full BLE ATT traffic including
  writes to the TX characteristic.
- **Official app traffic analysis** — the vendor app (Cat Printer on Play Store)
  was run with HCI logging active. The captured `.cfa` / `.log` file was opened
  in Wireshark with the `btatt` dissector.

### Discovery process

1. **Service enumeration** — nRF Connect showed two candidate services
   (`AE30` and `495353...`). Both had a writable characteristic and a
   notify characteristic. The `AE30` service is primary on all GB models.

2. **Magic bytes** — every write started with `51 78` and ended with `FF`.
   The third byte varied with the operation type. This identified the
   header/footer framing.

3. **Length field** — bytes 4–5 were consistently `len(payload)` in
   little-endian. Confirmed by comparing packets of different payload sizes.

4. **CRC field** — the second-to-last byte (before `0xFF`) changed with
   payload content. Testing with known polynomials (`crcmod` Python library)
   identified CRC-8 / polynomial `0x07` over the payload only.

5. **Command opcodes** — by correlating app UI actions (print, feed, change
   quality) with captured traffic, each opcode was identified:
   - Tapping "print" always produced a sequence starting with `0xA3`, `0xBC`,
     `0xA4`, `0xBD`, `0xAF`, `0xBE`, `0xA9`, `0xA6`.
   - The repeating `0xA2` packets had 48-byte payloads matching the print width
     of 384 pixels (`384 / 8 = 48`).
   - After printing, `0xA6` (different payload), `0xBD`, `0xA1`, `0xA3`.

6. **Lattice payload** — the two `0xA6` payloads were captured verbatim.
   Their internal structure is unknown; they appear to be fixed configuration
   sequences for the print head controller.

7. **State notification** — the RX characteristic sent 7-byte packets after
   `0xA3` requests. Comparing captured bytes against known printer states
   (paper loaded vs. out, cover open vs. closed) identified the bit flags at
   offset 6.

8. **Energy and speed** — changing the quality slider in the app produced
   different `0xAF` and `0xBD` values. Plotting captured energy values against
   perceptual darkness of test prints confirmed the linear relationship.

### Key reference

The protocol was independently documented by
[@NaitLee](https://github.com/NaitLee/kitty-printer) whose TypeScript
implementation (`cat-protocol.ts`) provided a clean cross-reference for
the opcode table and packet framing used in Meow Printer.

---

## 9. Known Limitations and Quirks

| Issue | Notes |
|-------|-------|
| No flow control acknowledgement | The printer does not ACK individual `0xA2` lines. If you send too fast you get garbled output. The `~20 ms` flush delay between buffer flushes is empirically derived. |
| Paused bit response time | On some devices, the Paused bit in the RX notification arrives 50–200 ms after the condition is triggered. Poll with a 100 ms interval. |
| MX series lattice | The MX05/MX06/MX08/MX10 models appear to accept the same lattice bytes as the GB series, but some firmware versions require the Prepare Camera packet (`0xBC`) to use different payload values. |
| No bidirectional print status during job | State notifications only arrive in response to `0xA3` requests sent between draw lines. Inserting `0xA3` every N lines is safe but adds overhead. |
| Width variants | GB01 uses 384 px; some MX models use 203 px or 576 px. Always read the device info (`0xA8`) response to confirm the print width before building bitmap lines. |
| iOS / Safari | Web Bluetooth is not available in WebKit. An iOS wrapper using `CoreBluetooth` (e.g. a WKWebView app or a React Native bridge) is required. |

---

## 10. Quick Reference Card

```
HEADER        : 51 78
FOOTER        : FF
FRAME         : 51 78 [CMD] [TYPE] [LEN_LO] [LEN_HI] [...PAYLOAD] [CRC8] FF

CMD QUICK TABLE
  A1  Feed paper            payload: uint16 LE (dot-rows)
  A2  Draw bitmap line      payload: 48 bytes (384-px printer)
  A3  Get device state      payload: 00
  A4  Set DPI               payload: 32  (= 50, always)
  A6  Lattice start/end     payload: fixed 11-byte sequence
  A8  Get device info       payload: 00
  A9  Update device         payload: 00
  AF  Set energy            payload: uint16 LE  (1000–65535)
  BC  Prepare camera        payload: 01 02 01 2D
  BD  Set speed             payload: uint8  (1–8)
  BE  Apply energy          payload: 01

LATTICE START : AA 55 17 38 44 5F 5F 5F 44 38 2C
LATTICE END   : AA 55 17 00 00 00 00 00 00 00 17

CRC8          : polynomial 0x07, no XOR in/out, payload bytes only
MTU           : 20 bytes per BLE ATT write (chunk larger packets)
```