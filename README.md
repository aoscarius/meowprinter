# 🐱 MeowPrinter

A web-based composer and controller for Bluetooth thermal printers
(GB01, GB02, GB03, MX05, MX06, MX08, MX10 and compatible).
Built entirely in vanilla HTML5 + JavaScript — no build step, no dependencies beyond QRCode.js.

---

## Features

- **Block-based layout composer** — stack text, images, QR codes, barcodes,
  tables, checklists, drawings, receipts, WiFi QR, name badges, calendars,
  ASCII art, progress bars, and more into a single print job
- **Live preview** — realistic paper-roll preview updates as you edit
- **Web Bluetooth** — connects directly to the printer from the browser,
  no app or driver required
- **Dry-run simulation** — animated paper-feed simulation with full
  protocol serialisation (packets counted, nothing transmitted)
- **Dithering engine** — Atkinson and Floyd-Steinberg algorithms for
  high-quality image rendering on thermal paper
- **Density presets** — Draft / Normal / Bold / Max with correct energy
  and speed values for each quality level
- **Dark + light themes**
- **Fully responsive** — two-row topbar below 480 px, icon-only palette
  on mobile, tab-switched blocks / preview

---

## Files

| File | Purpose |
|------|---------|
| `index.html`      | Application shell — HTML structure only, links CSS and JS |
| `style.css`       | All styles, theme variables, responsive rules, animations |
| `meowprinter.js`  | All logic — protocol, Bluetooth, block model, render engine, simulation |

No build tool required. Open `index.html` in Chrome or Edge (desktop or Android).

---

## Browser Requirements

| Browser | Support |
|---------|---------|
| Chrome 85+ (desktop) | ✅ Full support |
| Edge 85+ (desktop) | ✅ Full support |
| Chrome for Android 85+ | ✅ Full support |
| Samsung Internet 14+ | ✅ Full support |
| Safari / Firefox | ❌ Web Bluetooth not supported |

Web Bluetooth requires a secure context (HTTPS or localhost).
On Android, grant the **Nearby devices** permission when prompted.

---

## Quick Start

1. Open `meow-index.html` in Chrome.
2. Click **⚙ Printer** → choose a **Density Preset** (Normal is a good start).
3. Add blocks from the palette on the left.
4. Click **🖨 Print All**.
   - If no printer is connected the mode defaults to **Dry Run** (simulation).
   - To print for real, click the Bluetooth pill in the topbar and pair your device.

---

## Block Types

### Text blocks
| Block | Description |
|-------|-------------|
| **Text** | Word-wrapped text with font, size, weight, alignment |
| **Inverted Text** | White text on a solid black background |
| **Big Text** | Single line auto-sized to fill the full print width |
| **ASCII Art** | 5×7 pixel bitmap font with block, shadow, outline, dots, thin styles |

### Media blocks
| Block | Description |
|-------|-------------|
| **Image** | Any raster image; Atkinson / Floyd-Steinberg / threshold dithering |
| **Logo / Header** | Centred image with configurable width percentage |
| **Drawing** | Freehand canvas — pen, eraser, three stroke widths |

### Data blocks
| Block | Description |
|-------|-------------|
| **QR Code** | URL or arbitrary text, optional caption |
| **WiFi QR** | Generates the `WIFI:T:WPA;S:…;P:…;;` string — phone camera auto-connects |
| **Barcode** | Code128-B encoding, configurable bar height |

### Layout / structure blocks
| Block | Description |
|-------|-------------|
| **Table** | 2–4 columns, optional bold header row, alternating row shading |
| **Checklist** | Todo list with check boxes (pre-ticked state is preserved) |
| **Receipt** | Item list with prices, configurable tax %, currency symbol, running total |
| **Note / Box** | Text inside a border: plain box, double, rounded, shadow, or none |
| **Progress Bar** | Filled, hollow, dots, or steps (▁▃▅▇) styles |
| **Name Badge** | Three-line badge with double border frame |
| **Tags / Labels** | Comma-separated tag pills, rounded or square or inverted |
| **Grid / Graph Paper** | Configurable grid for handwritten notes |
| **Calendar** | Any month/year; today highlighted; configurable via month+year inputs |
| **Countdown** | Days remaining to a target date |
| **Date & Time** | Auto-inserted timestamp (date+time, date only, or time only) |
| **Ruler** | Measurement scale with tick marks and unit labels |
| **Separator** | Horizontal line: solid, dashed, dotted, double, wave |
| **Spacer** | Configurable blank padding |

---

## Density & Print Quality

The two parameters that control print density are **Energy** (1–65535) and **Speed** (1–8).
Higher energy and lower speed = darker, denser print.

| Preset | Energy | Speed | Use case |
|--------|--------|-------|----------|
| Draft  | 3 000  | 8 | Quick notes, receipts, low battery |
| Normal | 8 000  | 5 | Everyday printing |
| Bold   | 18 000 | 3 | Photos, dense graphics |
| Max    | 40 000 | 1 | Maximum contrast, very slow |

You can override both sliders manually in the Printer Settings drawer.

---

## Architecture Notes

### Single-canvas render engine

All blocks draw directly onto one shared `_compositeCanvas` element.
No intermediate per-block canvases are kept alive simultaneously.
This avoids the mobile browser limit of ~16 concurrent GPU-allocated canvases
and eliminates `IndexSizeError: source height is 0` on WebKit.

Async blocks (image, QR, WiFi, drawing) draw onto a small scratch canvas,
apply dithering, copy the result to the composite via `drawImage`, then
immediately shrink the scratch to 1×1 to release the GPU texture.

### composeAll() strategy

1. Allocate composite canvas at `blocks.length × 600 px` (safe oversize — never clips).
2. Render each block sequentially with `await renderOneBlock(...)`.
3. Create a fresh canvas at the exact final height.
4. Copy via `drawImage` (GPU blit — no `getImageData/putImageData` crop which corrupts data).
5. Resize composite to final height and blit the copy back.

### Android V8 fix

`await` inside `switch/case` inside an `async function` causes TurboFan
(V8's optimising compiler) to deoptimise the switch on Android and execute
case bodies synchronously, returning a pending `Promise` object instead of a
resolved number. The fix is `renderOneBlock()` — a dedicated `async function`
where every branch explicitly returns `Promise.resolve(syncResult)` or the
async function directly, so the single top-level `await` in `composeAll`
always resolves to a plain number.

---

## License
 
This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.
 
You are free to use, study, modify, and distribute this software, provided that
any derivative work is also released under the GPL-3.0 and its source code is
made available.
