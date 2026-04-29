/**
 * meowprinter.js
 * Meow Printer — Web Bluetooth thermal printer controller
 * 
 * Architecture:
 *   - CatPrinter class: protocol serialisation (cat-protocol.ts port)
 *   - Bluetooth layer: Web Bluetooth API connection management
 *   - Block system: composable content blocks (text, image, QR, etc.)
 *   - Render engine: direct-to-canvas rendering — NO intermediate canvases
 *   - Simulation: visual dry-run with animated paper feed
 */

'use strict';

/**
 * CRC-8 lookup table for packet checksum calculation.
 * Used to validate command payloads sent to the printer.
 */
const CRC8_TABLE = new Uint8Array([
    0x00, 0x07, 0x0e, 0x09, 0x1c, 0x1b, 0x12, 0x15,
    0x38, 0x3f, 0x36, 0x31, 0x24, 0x23, 0x2a, 0x2d,
    0x70, 0x77, 0x7e, 0x79, 0x6c, 0x6b, 0x62, 0x65,
    0x48, 0x4f, 0x46, 0x41, 0x54, 0x53, 0x5a, 0x5d,
    0xe0, 0xe7, 0xee, 0xe9, 0xfc, 0xfb, 0xf2, 0xf5,
    0xd8, 0xdf, 0xd6, 0xd1, 0xc4, 0xc3, 0xca, 0xcd,
    0x90, 0x97, 0x9e, 0x99, 0x8c, 0x8b, 0x82, 0x85,
    0xa8, 0xaf, 0xa6, 0xa1, 0xb4, 0xb3, 0xba, 0xbd,
    0xc7, 0xc0, 0xc9, 0xce, 0xdb, 0xdc, 0xd5, 0xd2,
    0xff, 0xf8, 0xf1, 0xf6, 0xe3, 0xe4, 0xed, 0xea,
    0xb7, 0xb0, 0xb9, 0xbe, 0xab, 0xac, 0xa5, 0xa2,
    0x8f, 0x88, 0x81, 0x86, 0x93, 0x94, 0x9d, 0x9a,
    0x27, 0x20, 0x29, 0x2e, 0x3b, 0x3c, 0x35, 0x32,
    0x1f, 0x18, 0x11, 0x16, 0x03, 0x04, 0x0d, 0x0a,
    0x57, 0x50, 0x59, 0x5e, 0x4b, 0x4c, 0x45, 0x42,
    0x6f, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7d, 0x7a,
    0x89, 0x8e, 0x87, 0x80, 0x95, 0x92, 0x9b, 0x9c,
    0xb1, 0xb6, 0xbf, 0xb8, 0xad, 0xaa, 0xa3, 0xa4,
    0xf9, 0xfe, 0xf7, 0xf0, 0xe5, 0xe2, 0xeb, 0xec,
    0xc1, 0xc6, 0xcf, 0xc8, 0xdd, 0xda, 0xd3, 0xd4,
    0x69, 0x6e, 0x67, 0x60, 0x75, 0x72, 0x7b, 0x7c,
    0x51, 0x56, 0x5f, 0x58, 0x4d, 0x4a, 0x43, 0x44,
    0x19, 0x1e, 0x17, 0x10, 0x05, 0x02, 0x0b, 0x0c,
    0x21, 0x26, 0x2f, 0x28, 0x3d, 0x3a, 0x33, 0x34,
    0x4e, 0x49, 0x40, 0x47, 0x52, 0x55, 0x5c, 0x5b,
    0x76, 0x71, 0x78, 0x7f, 0x6a, 0x6d, 0x64, 0x63,
    0x3e, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2c, 0x2b,
    0x06, 0x01, 0x08, 0x0f, 0x1a, 0x1d, 0x14, 0x13,
    0xae, 0xa9, 0xa0, 0xa7, 0xb2, 0xb5, 0xbc, 0xbb,
    0x96, 0x91, 0x98, 0x9f, 0x8a, 0x8d, 0x84, 0x83,
    0xde, 0xd9, 0xd0, 0xd7, 0xc2, 0xc5, 0xcc, 0xcb,
    0xe6, 0xe1, 0xe8, 0xef, 0xfa, 0xfd, 0xf4, 0xf3
]);

/** Compute CRC-8 checksum over a byte array. */
function crc8(data) {
    let crc = 0;
    for (const byte of data) {
        crc = CRC8_TABLE[(crc ^ byte) & 0xff];
    }
    return crc & 0xff;
}

/** Encode a number as little-endian bytes of the given length. */
function bytesLE(value, length = 1) {
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        result[i] = value & 0xff;
        value >>= 8;
    }
    return result;
}

/** Async delay helper. */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * CatPrinter — low-level protocol driver.
 *
 * Builds and buffers command packets, flushing them via the provided
 * writeFn when the internal MTU buffer is full or explicitly flushed.
 *
 * Packet format: [0x51, 0x78, cmd, type, len_lo, len_hi, ...payload, crc8, 0xff]
 */
class CatPrinter {
    constructor(model, writeFn, dry = false) {
        this.model     = model;
        this.writeFn   = writeFn;
        this.dry       = dry;
        this.mtu       = 200;
        this.buf       = new Uint8Array(this.mtu);
        this.bufLen    = 0;
        this.state     = { pause: 0, busy: 0 };
        this.bytesSent = 0;
    }

    /** Update internal state from a notification packet received from the printer. */
    notify(msg) {
        this.state = {
            pause: msg[6] & 16,
            busy:  msg[6] & 0x80
        };
    }

    /** Build a framed command packet. */
    makePacket(cmd, payload, type = 0) {
        return new Uint8Array([
            0x51, 0x78, cmd, type,
            payload.length & 0xff,
            payload.length >> 8,
            ...payload,
            crc8(payload),
            0xff
        ]);
    }

    /** Append bytes to the internal send buffer. */
    bufferAppend(data) {
        for (let i = 0; i < data.length; i++) {
            this.buf[this.bufLen++] = data[i];
        }
    }

    /** Flush the buffer, waiting if the printer is paused. */
    async flush() {
        while (this.state.pause) {
            await delay(100);
        }
        if (!this.bufLen) return;

        const chunk = this.buf.slice(0, this.bufLen);
        this.bytesSent += chunk.length;
        if (!this.dry) {
            await this.writeFn(chunk);
        }
        this.bufLen = 0;
        await delay(this.dry ? 2 : 20);
    }

    /** Queue a command packet, flushing first if the buffer would overflow. */
    async send(data) {
        if (this.bufLen + data.length > this.mtu) {
            await this.flush();
        }
        this.bufferAppend(data);
    }

    // ── Printer commands ────────────────────────────────────

    drawLine(bitmapLine) {
        return this.send(this.makePacket(0xa2, bitmapLine));
    }

    async prepare(speed, energy) {
        await this.flush();
        // Get device state
        await this.send(this.makePacket(0xa3, bytesLE(0)));
        // Prepare camera / init sequence
        await this.send(new Uint8Array([0x51, 0x78, 0xbc, 0x00, 0x01, 0x02, 0x01, 0x2d, 0xff]));
        // Set DPI to 200
        await this.send(this.makePacket(0xa4, bytesLE(50)));
        // Set speed (1=slow/dense … 8=fast/light)
        await this.send(this.makePacket(0xbd, bytesLE(speed)));
        // Set energy (1000–65535; higher = darker)
        await this.send(this.makePacket(0xaf, bytesLE(energy, 2)));
        // Apply energy
        await this.send(this.makePacket(0xbe, bytesLE(1)));
        // Update device
        await this.send(this.makePacket(0xa9, bytesLE(0)));
        // Start lattice (marks beginning of bitmap data)
        await this.send(this.makePacket(0xa6,
            new Uint8Array([0xaa, 0x55, 0x17, 0x38, 0x44, 0x5f, 0x5f, 0x5f, 0x44, 0x38, 0x2c])
        ));
        await this.flush();
    }

    async finish(feedPoints) {
        await this.flush();
        // End lattice
        await this.send(this.makePacket(0xa6,
            new Uint8Array([0xaa, 0x55, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x17])
        ));
        // Reset to max speed for feed
        await this.send(this.makePacket(0xbd, bytesLE(8)));
        // Feed paper forward by N points
        await this.send(this.makePacket(0xa1, bytesLE(feedPoints, 2)));
        // Final state check
        await this.send(this.makePacket(0xa3, bytesLE(0)));
        await this.flush();
    }
}


// ============================================================
//  SECTION 2 — BLUETOOTH
// ============================================================

// Primary service/characteristic UUIDs (most Cat/GB/MX printers)
const BT_SERVICE_PRIMARY = '0000ae30-0000-1000-8000-00805f9b34fb';
const BT_CHAR_TX         = '0000ae01-0000-1000-8000-00805f9b34fb';
const BT_CHAR_RX         = '0000ae02-0000-1000-8000-00805f9b34fb';

// Alternative service UUIDs (some older firmware variants)
const BT_SERVICE_ALT     = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const BT_CHAR_TX_ALT     = '49535343-8841-43f4-a8d4-ecbe34729bb3';

/** Currently connected BLE device, characteristic, and printer instance. */
let btDevice    = null;
let btCharTx    = null;
let printer     = null;

/** Toggle connect / disconnect. */
async function toggleBT() {
    if (btDevice && btDevice.gatt.connected) {
        disconnectBT();
    } else {
        await connectBT();
    }
}

/** Scan for and connect to a supported printer. */
async function connectBT() {
    if (!navigator.bluetooth) {
        toast('Web Bluetooth is not supported in this browser', 'err');
        return;
    }

    setDot('spin');
    document.getElementById('bt-lbl').textContent = 'Connecting…';

    try {
        btDevice = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: 'GB' },
                { namePrefix: 'MX' },
                { namePrefix: 'YHY' },
                { namePrefix: 'Cat' }
            ],
            optionalServices: [BT_SERVICE_PRIMARY, BT_SERVICE_ALT]
        });

        btDevice.addEventListener('gattserverdisconnected', onBTDisconnect);

        const server = await btDevice.gatt.connect();
        let service, txChar;

        // Try primary service first, fall back to alternate
        try {
            service = await server.getPrimaryService(BT_SERVICE_PRIMARY);
            txChar  = await service.getCharacteristic(BT_CHAR_TX);
        } catch (_) {
            service = await server.getPrimaryService(BT_SERVICE_ALT);
            txChar  = await service.getCharacteristic(BT_CHAR_TX_ALT);
        }

        // Subscribe to notifications for state updates (optional — some devices omit RX)
        try {
            const rxChar = await service.getCharacteristic(BT_CHAR_RX);
            await rxChar.startNotifications();
            rxChar.addEventListener('characteristicvaluechanged', (e) => {
                if (printer) {
                    printer.notify(new Uint8Array(e.target.value.buffer));
                }
            });
        } catch (_) {
            // RX not available — continue without state notifications
        }

        btCharTx = txChar;
        printer  = new CatPrinter(btDevice.name || 'GB03', writeToCharacteristic, false);

        setDot('ok');
        document.getElementById('bt-lbl').textContent = btDevice.name || 'Connected';
        document.getElementById('bt-pill').classList.add('ok');
        document.getElementById('p-dryrun').value = '0';
        toast('Connected to ' + (btDevice.name || 'printer'), 'ok');

    } catch (err) {
        setDot('');
        document.getElementById('bt-lbl').textContent = 'Disconnected';
        if (err.name !== 'NotFoundError') {
            toast('Bluetooth error: ' + err.message, 'err');
        }
    }
}

/**
 * Write data to the TX characteristic in 20-byte chunks.
 * The BLE ATT MTU for most devices is 20 bytes without negotiation.
 */
async function writeToCharacteristic(data) {
    if (!btCharTx) return;
    for (let i = 0; i < data.length; i += 20) {
        await btCharTx.writeValueWithoutResponse(data.slice(i, i + 20));
        await delay(5);
    }
}

/** Disconnect from the current device. */
function disconnectBT() {
    if (btDevice) {
        btDevice.gatt.disconnect();
    }
}

/** Handle unexpected BLE disconnection. */
function onBTDisconnect() {
    btCharTx = null;
    printer  = null;
    setDot('');
    document.getElementById('bt-pill').classList.remove('ok');
    document.getElementById('bt-lbl').textContent = 'Disconnected';
    toast('Printer disconnected', 'err');
}

/** Set the status dot CSS class ('ok', 'spin', or '' for off). */
function setDot(cls) {
    const dot = document.getElementById('bt-dot');
    dot.className = 'bt-dot' + (cls ? ' ' + cls : '');
}


// ============================================================
//  SECTION 3 — DENSITY PRESETS
//  Energy and speed are the two main levers for print quality.
//  Higher energy + lower speed = darker, denser print.
// ============================================================

const DENSITY_PRESETS = {
    draft:  { energy: 3000,  speed: 8 },  // Very fast, light print (battery-friendly)
    normal: { energy: 8000,  speed: 5 },  // Balanced
    bold:   { energy: 18000, speed: 3 },  // Dark, good for photos
    max:    { energy: 40000, speed: 1 },  // Maximum density, slowest
};

/** Apply a density preset to the printer settings sliders. */
function setDensity(key, buttonEl) {
    const preset = DENSITY_PRESETS[key];
    document.getElementById('p-energy').value   = preset.energy;
    document.getElementById('p-speed').value    = preset.speed;
    document.getElementById('ev-e').textContent = preset.energy;
    document.getElementById('ev-s').textContent = preset.speed;
    document.querySelectorAll('.density-opt').forEach(btn => btn.classList.remove('on'));
    buttonEl.classList.add('on');
}


// ============================================================
//  SECTION 4 — BLOCK DATA MODEL
// ============================================================

/** Sequence counter used to generate unique block IDs. */
let blocks = [];
let blockIdSeq = 0;

/** Returns the current print width from the settings dropdown. */
const getPrintWidth = () => parseInt(document.getElementById('p-width').value) || 384;

/**
 * Default property values for every block type.
 * When a new block is added, it gets a deep-copy of these defaults.
 */
const BLOCK_DEFAULTS = {
    text:      { text: 'Hello, Meow!', size: 28, align: 'center', font: 'monospace', bold: 'normal' },
    inverted:  { text: 'INVERTED',     size: 28, align: 'center', font: 'monospace', bold: 'bold' },
    image:     { src: null, fileName: '', dither: 'atkinson', threshold: 128, contrast: 0 },
    qr:        { content: 'https://aoscarius.github.io/', label: 'aoscarius.github.io', margin: 12 },
    barcode:   { content: '012345678905', height: 60, showText: true },
    table:     { cols: 2, rows: [['Item', 'Value'], ['A', '100'], ['B', '200']], fontSize: 14, bold_header: true },
    checklist: { items: ['Task one', 'Task two', 'Task three'], checked: [false, false, false] },
    drawing:   { dataUrl: null, height: 100 },
    logo:      { src: null, fileName: '', width: 50 },
    countdown: { target: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), label: 'Days left', size: 40, align: 'center' },
    ruler:     { unit: 'cm', width: 60, ticks: 10 },
    datetime:  { format: 'full', size: 16, align: 'center' },
    separator: { style: 'solid', thickness: 2, padding: 10 },
    spacer:    { height: 30 },
    asciiart:  { text: 'HELLO\nWORLD', font: 'block', invert: false, scale: 2 },
    bigtext:   { text: 'SALE!', font: 'banner', align: 'center' },
    receipt:   { items: [{ label: 'Item A', price: '5.00' }, { label: 'Item B', price: '12.50' }], tax: 10, currency: '€', title: 'Receipt' },
    wifi:      { ssid: 'MyNetwork', password: 'secret123', hidden: false, security: 'WPA' },
    note:      { text: 'Note text here', style: 'box', align: 'left', size: 14 },
    progress:  { label: 'Progress', value: 70, style: 'filled' },
    badge:     { line1: 'HELLO', line2: 'my name is', line3: 'AOscarIus', size1: 14, size2: 22, size3: 32 },
    grid:      { cols: 4, rows: 4, cellW: 20, label: '' },
    tags:      { items: ['tag1', 'tag2', 'tag3'], style: 'rounded' },
    calendar:  { month: 0, year: 0 },
};

/** Human-readable display names for every block type. */
const BLOCK_NAMES = {
	text: 'Text',
	inverted: 'Inverted Text',
	image: 'Image',
	qr: 'QR Code',
	barcode: 'Barcode',
	table: 'Table',
	checklist: 'Checklist',
	drawing: 'Drawing',
	logo: 'Logo / Header',
	countdown: 'Countdown',
	ruler: 'Ruler',
	datetime: 'Date & Time',
	separator: 'Separator',
	spacer: 'Spacer',
	asciiart: 'ASCII Art',
	bigtext: 'Big Text',
	receipt: 'Receipt',
	wifi: 'WiFi QR',
	note: 'Note / Box',
	progress: 'Progress Bar',
	badge: 'Name Badge',
	grid: 'Grid / Graph',
	tags: 'Tags / Labels',
	calendar: 'Calendar',
};

/** Emoji icons for every block type. */
const BLOCK_ICONS = {
    text: '✏️', 
    inverted: '◼', 
    image: '🖼', 
    qr: '◼', 
    barcode: '▦', 
    table: '📋',
    checklist: '☑', 
    drawing: '✍️', 
    logo: '🏷', 
    countdown: '⏳', 
    ruler: '📏',
    datetime: '🕐', 
    separator: '—', 
    spacer: '↕', 
    asciiart: '▓', 
    bigtext: '𝐀',
    receipt: '🧾', 
    wifi: '📶', 
    note: '📝', 
    progress: '▰', 
    badge: '🏷',
    grid: '⊞', 
    tags: '🔖', 
    calendar: '📅',
};

/** Add a new block of the given type to the end of the layout. */
function addBlock(type) {
    const id = 'b' + (++blockIdSeq);
    const defaults = BLOCK_DEFAULTS[type];
    if (!defaults) {
        console.warn('Unknown block type:', type);
        return;
    }
    blocks.push({ id, type, ...JSON.parse(JSON.stringify(defaults)) });
    renderBlockList(id);
    schedulePreview();
}

/** Remove a block by ID. */
function removeBlock(id) {
    blocks = blocks.filter(b => b.id !== id);
    renderBlockList();
    schedulePreview();
}

/** Duplicate a block, inserting the copy immediately after the original. */
function duplicateBlock(id) {
    const original = blocks.find(b => b.id === id);
    if (!original) return;
    const copy = { ...JSON.parse(JSON.stringify(original)), id: 'b' + (++blockIdSeq) };
    const index = blocks.findIndex(b => b.id === id);
    blocks.splice(index + 1, 0, copy);
    renderBlockList();
    schedulePreview();
}

/** Move a block up (-1) or down (+1) in the layout order. */
function moveBlock(id, direction) {
    const index = blocks.findIndex(b => b.id === id);
    if (index < 0) return;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= blocks.length) return;
    [blocks[index], blocks[newIndex]] = [blocks[newIndex], blocks[index]];
    renderBlockList();
    schedulePreview();
}

/** Clear all blocks after user confirmation. */
function clearAll() {
    if (!blocks.length) return;
    if (!confirm('Clear all blocks?')) return;
    blocks = [];
    renderBlockList();
    schedulePreview();
}

/** Update a single property of a block by ID. */
function updateBlock(id, key, value) {
    const block = blocks.find(b => b.id === id);
    if (block) block[key] = value;
}

/** Return a short summary string for display in the collapsed block header. */
function blockSummary(b) {
    switch (b.type) {
        case 'text':
		case 'inverted':
			return b.text.substring(0, 25) + (b.text.length > 25 ? '\u2026' : '');
		case 'qr':
			return b.content.substring(0, 25);
		case 'barcode':
			return b.content;
		case 'datetime':
			return 'auto timestamp';
		case 'separator':
			return b.style;
		case 'spacer':
			return b.height + 'px';
        case 'image':
		case 'logo':
			return b.fileName || 'no image';
		case 'table':
			return b.rows.length + ' rows';
		case 'drawing':
			return b.dataUrl ? 'has drawing' : 'empty';
		case 'checklist':
			return b.items.length + ' items';
		case 'countdown':
			return b.target;
		case 'ruler':
			return b.width + '% width';
		case 'asciiart':
			return b.text.split('\n')[0].substring(0, 20);
		case 'bigtext':
			return b.text.substring(0, 20);
		case 'receipt':
			return b.title;
		case 'wifi':
			return b.ssid;
		case 'note':
			return b.text.substring(0, 20);
		case 'progress':
			return b.label + ' ' + b.value + '%';
		case 'badge':
			return b.line3;
		case 'grid':
			return b.cols + '\xd7' + b.rows;
		case 'tags':
			return b.items.join(', ').substring(0, 20);
		case 'calendar':
			return (b.month && b.year) ? b.month + '/' + b.year : 'current month';
		default:
			return '';
    }
}

// ============================================================
//  SECTION 5 — BLOCK LIST UI
// ============================================================

/** Cache of which blocks had their body open, keyed by block ID. */
let openBodyState = {};

/**
 * Re-render the entire block list DOM.
 * @param {string|null} newId  - If set, that card gets the slide-in animation class.
 */
function renderBlockList(newId = null) {
    const list      = document.getElementById('block-list');
    const emptyMsg  = document.getElementById('empty-state');
    const countEl   = document.getElementById('blk-count');

    // Save which bodies are open before wiping the DOM
    list.querySelectorAll('.block-card').forEach(card => {
        const body = card.querySelector('.block-body');
        if (body) openBodyState[card.dataset.id] = body.classList.contains('open');
    });

    emptyMsg.style.display = blocks.length ? 'none' : 'flex';
    countEl.textContent    = blocks.length + ' block' + (blocks.length === 1 ? '' : 's');

    // Remove existing cards
    list.querySelectorAll('.block-card').forEach(c => c.remove());

    blocks.forEach(block => {
        const card = document.createElement('div');
        card.className    = 'block-card' + (block.id === newId ? ' new-block' : '');
        card.dataset.type = block.type;
        card.dataset.id   = block.id;

        const wasOpen = openBodyState[block.id] || false;

        card.innerHTML = buildCardHTML(block, wasOpen);
        list.appendChild(card);

        // Toggle body on header click — but NOT on the drag handle or action buttons
        card.querySelector('.block-head').addEventListener('click', (e) => {
            if (e.target.closest('.blk-acts') || e.target.closest('.drag-handle')) return;
            const body    = card.querySelector('.block-body');
            const opening = !body.classList.contains('open');
            body.classList.toggle('open');
            // Initialise interactive sub-editors when first opened
            if (opening) {
                if (block.type === 'drawing')   initDrawingCanvas(card, block);
                if (block.type === 'table')     renderTableEditor(card, block);
                if (block.type === 'checklist') renderChecklistEditor(card, block);
            }
        });

        // Re-init sub-editors for blocks that were already open
        if (wasOpen) {
            setTimeout(() => {
                if (block.type === 'drawing')   initDrawingCanvas(card, block);
                if (block.type === 'table')     renderTableEditor(card, block);
                if (block.type === 'checklist') renderChecklistEditor(card, block);
            }, 50);
        }

        // Drag-and-drop: only initiated from the ⠿ handle
        const handle = card.querySelector('.drag-handle');
        handle.addEventListener('mousedown',  e => { e.stopPropagation(); initDrag(e, block.id, card); });
        handle.addEventListener('touchstart', e => { e.stopPropagation(); initDrag(e, block.id, card); }, { passive: true });

        // Drop target: accept drops from other cards
        card.addEventListener('dragover',  e => { e.preventDefault(); card.classList.add('drag-over'); });
        card.addEventListener('dragleave', ()  => card.classList.remove('drag-over'));
        card.addEventListener('drop', e => {
            e.preventDefault();
            card.classList.remove('drag-over');
            const fromId  = e.dataTransfer && e.dataTransfer.getData('text/plain');
            if (!fromId) return;
            const fromIdx = blocks.findIndex(b => b.id === fromId);
            const toIdx   = blocks.findIndex(b => b.id === block.id);
            if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
            const [moved] = blocks.splice(fromIdx, 1);
            blocks.splice(toIdx, 0, moved);
            renderBlockList();
            schedulePreview();
        });
    });
}

/** Build the HTML string for one block card. */
function buildCardHTML(block, wasOpen) {
    const id = block.id;
    return `
        <div class="block-head">
            <span class="drag-handle" title="Drag to reorder">⠿</span>
            <span class="blk-icon">${BLOCK_ICONS[block.type]}</span>
            <span class="blk-label">${BLOCK_NAMES[block.type]}</span>
            <span class="blk-summary" id="bs_${id}">${blockSummary(block)}</span>
            <div class="blk-acts">
                <button class="bact" onclick="event.stopPropagation(); moveBlock('${id}', -1)" title="Move up">↑</button>
                <button class="bact" onclick="event.stopPropagation(); moveBlock('${id}', 1)"  title="Move down">↓</button>
                <button class="bact" onclick="event.stopPropagation(); duplicateBlock('${id}')" title="Duplicate">⧉</button>
                <button class="bact del" onclick="event.stopPropagation(); removeBlock('${id}')" title="Remove">✕</button>
            </div>
        </div>
        <div class="block-body${wasOpen ? ' open' : ''}">${buildBlockBodyHTML(block)}</div>
    `;
}

/** Update the summary text in the card header without re-rendering everything. */
function updateSummary(id, text) {
    const el = document.getElementById('bs_' + id);
    if (el) el.textContent = text;
}

/** Native HTML5 drag — only starts from the ⠿ handle element. */
function initDrag(e, id, card) {
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', ev => {
        ev.dataTransfer.setData('text/plain', id);
        card.classList.add('is-dragging');
    }, { once: true });
    card.addEventListener('dragend', () => {
        card.classList.remove('is-dragging');
        card.setAttribute('draggable', 'false');
    }, { once: true });
}


// ============================================================
//  SECTION 6 — BLOCK BODY HTML TEMPLATES
// ============================================================

/**
 * Returns the inner HTML for the collapsible body of a block card.
 * Each block type renders its own set of controls.
 */
function buildBlockBodyHTML(b) {
    const id = b.id;

    // ── Shared helpers ─────────────────────────────────────

    /** Range slider row. oninput is inlined to avoid closure issues across re-renders. */
    const rangeRow = (label, sliderAttr, spanId, initVal) =>
        `<div class="fr"><label>${label} — <span id="${spanId}">${initVal}</span></label>
         <div class="rr"><input type="range" ${sliderAttr}></div></div>`;

    /** Font family select options (shared by text and inverted blocks). */
    const fontOptions = (selected) => [
        ['monospace',       'Monospace'],
        ['serif',           'Serif'],
        ['sans-serif',      'Sans-serif'],
        ["'Courier New'",   'Courier New'],
        ["'Georgia'",       'Georgia'],
        ["'Impact'",        'Impact'],
        ["'Arial Black'",   'Arial Black'],
        ["'Trebuchet MS'",  'Trebuchet MS'],
        ["'Palatino'",      'Palatino'],
        ["'Lucida Console'", 'Lucida Console'],
    ].map(([v, label]) =>
        `<option value="${v}"${b.font === v ? ' selected' : ''}>${label}</option>`
    ).join('');

    const alignOptions = (current) => ['left', 'center', 'right'].map(a =>
        `<option value="${a}"${current === a ? ' selected' : ''}>${a.charAt(0).toUpperCase() + a.slice(1)}</option>`
    ).join('');

    // ── Block-specific HTML ─────────────────────────────────

    switch (b.type) {

        case 'text': return `
            <div class="fr"><label>Text</label>
                <textarea oninput="updateBlock('${id}','text',this.value); updateSummary('${id}', this.value.substring(0,25)); schedulePreview()">${b.text}</textarea>
            </div>
            <div class="fg">
                ${rangeRow('Size', `min="8" max="72" value="${b.size}" oninput="updateBlock('${id}','size',+this.value); document.getElementById('sv_${id}').textContent=this.value; schedulePreview()"`, `sv_${id}`, b.size)}
                <div class="fr"><label>Align</label>
                    <select onchange="updateBlock('${id}','align',this.value); schedulePreview()">${alignOptions(b.align)}</select>
                </div>
                <div class="fr"><label>Font</label>
                    <select onchange="updateBlock('${id}','font',this.value); schedulePreview()">${fontOptions(b.font)}</select>
                </div>
                <div class="fr"><label>Weight</label>
                    <select onchange="updateBlock('${id}','bold',this.value); schedulePreview()">
                        <option value="normal"${b.bold === 'normal' ? ' selected' : ''}>Normal</option>
                        <option value="bold"${b.bold === 'bold' ? ' selected' : ''}>Bold</option>
                    </select>
                </div>
            </div>`;

        case 'inverted': return `
            <div class="fr"><label>Text (white on black background)</label>
                <textarea oninput="updateBlock('${id}','text',this.value); updateSummary('${id}', this.value.substring(0,25)); schedulePreview()">${b.text}</textarea>
            </div>
            <div class="fg">
                ${rangeRow('Size', `min="8" max="72" value="${b.size}" oninput="updateBlock('${id}','size',+this.value); document.getElementById('sv_${id}').textContent=this.value; schedulePreview()"`, `sv_${id}`, b.size)}
                <div class="fr"><label>Align</label>
                    <select onchange="updateBlock('${id}','align',this.value); schedulePreview()">${alignOptions(b.align)}</select>
                </div>
                <div class="fr"><label>Font</label>
                    <select onchange="updateBlock('${id}','font',this.value); schedulePreview()">
                        <option value="monospace">Monospace</option>
                        <option value="serif">Serif</option>
                        <option value="sans-serif">Sans-serif</option>
                        <option value="'Courier New'">Courier New</option>
                        <option value="'Georgia'">Georgia</option>
                        <option value="'Impact'">Impact</option>
                        <option value="'Arial Black'">Arial Black</option>
                        <option value="'Trebuchet MS'">Trebuchet MS</option>
                        <option value="'Palatino'">Palatino</option>
                        <option value="'Lucida Console'">Lucida Console</option>
                    </select>
                </div>
                <div class="fr"><label>Weight</label>
                    <select onchange="updateBlock('${id}','bold',this.value); schedulePreview()">
                        <option value="normal">Normal</option>
                        <option value="bold"${b.bold === 'bold' ? ' selected' : ''}>Bold</option>
                    </select>
                </div>
            </div>`;

        case 'image': return `
            <div class="mini-dz" id="dz_${id}"
                onclick="document.getElementById('fi_${id}').click()"
                ondragover="event.preventDefault(); this.classList.add('hov')"
                ondragleave="this.classList.remove('hov')"
                ondrop="handleImageDrop(event, '${id}', 'image')">
                ${b.src ? `<img src="${b.src}"><br><small>${b.fileName}</small>` : '📁 Drag or click to load image'}
            </div>
            <input type="file" accept="image/*" id="fi_${id}" style="display:none" onchange="loadBlockImage(event, '${id}', 'image')">
            <div class="fg" style="margin-top:8px">
                <div class="fr"><label>Dithering algorithm</label>
                    <select onchange="updateBlock('${id}','dither',this.value); schedulePreview()">
                        <option value="atkinson"${b.dither === 'atkinson' ? ' selected' : ''}>Atkinson</option>
                        <option value="floyd"${b.dither === 'floyd' ? ' selected' : ''}>Floyd-Steinberg</option>
                        <option value="threshold"${b.dither === 'threshold' ? ' selected' : ''}>Threshold</option>
                        <option value="none"${b.dither === 'none' ? ' selected' : ''}>None</option>
                    </select>
                </div>
                ${rangeRow('Threshold', `min="0" max="255" value="${b.threshold}" oninput="updateBlock('${id}','threshold',+this.value); document.getElementById('tv_${id}').textContent=this.value; schedulePreview()"`, `tv_${id}`, b.threshold)}
                ${rangeRow('Contrast', `min="-100" max="100" value="${b.contrast}" oninput="updateBlock('${id}','contrast',+this.value); document.getElementById('cv_${id}').textContent=(this.value>0?'+':'')+this.value; schedulePreview()"`, `cv_${id}`, (b.contrast > 0 ? '+' : '') + b.contrast)}
            </div>`;

        case 'qr': return `
            <div class="fr"><label>Content / URL</label>
                <input type="text" value="${b.content}" oninput="updateBlock('${id}','content',this.value); updateSummary('${id}', this.value.substring(0,25)); schedulePreview()">
            </div>
            <div class="fr"><label>Caption below QR (optional)</label>
                <input type="text" value="${b.label}" placeholder="e.g. scan here" oninput="updateBlock('${id}','label',this.value); schedulePreview()">
            </div>
            ${rangeRow('Margin', `min="0" max="60" value="${b.margin}" oninput="updateBlock('${id}','margin',+this.value); document.getElementById('mv_${id}').textContent=this.value; schedulePreview()"`, `mv_${id}`, b.margin)}`;

        case 'barcode': return `
            <div class="fr"><label>Code value (Code128 encoding)</label>
                <input type="text" value="${b.content}" oninput="updateBlock('${id}','content',this.value); updateSummary('${id}', this.value); schedulePreview()">
            </div>
            <div class="fg">
                ${rangeRow('Bar height', `min="20" max="120" value="${b.height}" oninput="updateBlock('${id}','height',+this.value); document.getElementById('bh_${id}').textContent=this.value; schedulePreview()"`, `bh_${id}`, b.height)}
                <div class="fr"><label>Show text below bars</label>
                    <select onchange="updateBlock('${id}','showText',this.value==='1'); schedulePreview()">
                        <option value="1"${b.showText ? ' selected' : ''}>Yes</option>
                        <option value="0"${!b.showText ? ' selected' : ''}>No</option>
                    </select>
                </div>
            </div>`;

        case 'table': return `
            <div class="fg">
                <div class="fr"><label>Number of columns</label>
                    <select onchange="updateBlock('${id}','cols',+this.value); adjustTableColumns('${id}'); schedulePreview()">
                        ${[2, 3, 4].map(n => `<option value="${n}"${b.cols === n ? ' selected' : ''}>${n}</option>`).join('')}
                    </select>
                </div>
                <div class="fr"><label>Bold first row (header)</label>
                    <select onchange="updateBlock('${id}','bold_header',this.value==='1'); schedulePreview()">
                        <option value="1"${b.bold_header ? ' selected' : ''}>Yes</option>
                        <option value="0"${!b.bold_header ? ' selected' : ''}>No</option>
                    </select>
                </div>
                ${rangeRow('Font size', `min="9" max="24" value="${b.fontSize}" oninput="updateBlock('${id}','fontSize',+this.value); document.getElementById('tf_${id}').textContent=this.value; schedulePreview()"`, `tf_${id}`, b.fontSize)}
            </div>
            <div class="table-grid" id="tg_${id}"></div>`;

        case 'checklist': return `
            <div class="check-editor" id="ce_${id}"></div>
            <button class="add-row-btn" style="margin-top:6px" onclick="addChecklistItem('${id}')">+ Add item</button>`;

        case 'drawing': return `
            ${rangeRow('Canvas height', `min="60" max="400" value="${b.height}" oninput="updateBlock('${id}','height',+this.value); resizeDrawingCanvas('${id}', +this.value); document.getElementById('dh_${id}').textContent=this.value"`, `dh_${id}`, b.height)}
            <canvas class="draw-cvs" id="dc_${id}" width="384" height="${b.height}"></canvas>
            <div class="draw-tools">
                <button class="dtool on" id="dp_${id}" onclick="setDrawingTool('${id}','pen',this)">✏ Pen</button>
                <button class="dtool" onclick="setDrawingTool('${id}','eraser',this)">⬜ Eraser</button>
                <button class="dtool" onclick="setDrawingWidth('${id}', 1)">Thin</button>
                <button class="dtool" onclick="setDrawingWidth('${id}', 3)">Medium</button>
                <button class="dtool" onclick="setDrawingWidth('${id}', 6)">Thick</button>
                <button class="dtool" onclick="clearDrawingCanvas('${id}')">✕ Clear</button>
            </div>`;

        case 'logo': return `
            <div class="mini-dz" id="ldz_${id}"
                onclick="document.getElementById('lfi_${id}').click()"
                ondragover="event.preventDefault(); this.classList.add('hov')"
                ondragleave="this.classList.remove('hov')"
                ondrop="handleImageDrop(event, '${id}', 'logo')">
                ${b.src ? `<img src="${b.src}"><br><small>${b.fileName}</small>` : '🏷 Logo or header image'}
            </div>
            <input type="file" accept="image/*" id="lfi_${id}" style="display:none" onchange="loadBlockImage(event, '${id}', 'logo')">
            ${rangeRow('Width percentage', `min="10" max="100" value="${b.width}" oninput="updateBlock('${id}','width',+this.value); document.getElementById('lw_${id}').textContent=this.value; schedulePreview()"`, `lw_${id}`, b.width)}`;

        case 'countdown': return `
            <div class="fr"><label>Target date (YYYY-MM-DD)</label>
                <input type="text" value="${b.target}" placeholder="2025-12-31"
                    oninput="updateBlock('${id}','target',this.value); updateSummary('${id}', this.value); schedulePreview()">
            </div>
            <div class="fr"><label>Label text below the number</label>
                <input type="text" value="${b.label}" oninput="updateBlock('${id}','label',this.value); schedulePreview()">
            </div>
            <div class="fg">
                ${rangeRow('Number size', `min="20" max="80" value="${b.size}" oninput="updateBlock('${id}','size',+this.value); document.getElementById('cs_${id}').textContent=this.value; schedulePreview()"`, `cs_${id}`, b.size)}
                <div class="fr"><label>Align</label>
                    <select onchange="updateBlock('${id}','align',this.value); schedulePreview()">${alignOptions(b.align)}</select>
                </div>
            </div>`;

        case 'ruler': return `
            <div class="fg">
                <div class="fr"><label>Unit label</label>
                    <select onchange="updateBlock('${id}','unit',this.value); schedulePreview()">
                        <option value="cm"${b.unit === 'cm' ? ' selected' : ''}>cm</option>
                        <option value="mm"${b.unit === 'mm' ? ' selected' : ''}>mm</option>
                        <option value="in"${b.unit === 'in' ? ' selected' : ''}>inch</option>
                    </select>
                </div>
                ${rangeRow('Width %', `min="20" max="100" value="${b.width}" oninput="updateBlock('${id}','width',+this.value); document.getElementById('rw_${id}').textContent=this.value; schedulePreview()"`, `rw_${id}`, b.width)}
                ${rangeRow('Tick count', `min="2" max="20" value="${b.ticks}" oninput="updateBlock('${id}','ticks',+this.value); document.getElementById('rt_${id}').textContent=this.value; schedulePreview()"`, `rt_${id}`, b.ticks)}
            </div>`;

        case 'datetime': return `
            <div class="fg">
                <div class="fr"><label>Format</label>
                    <select onchange="updateBlock('${id}','format',this.value); schedulePreview()">
                        <option value="full"${b.format === 'full' ? ' selected' : ''}>Date + Time</option>
                        <option value="date"${b.format === 'date' ? ' selected' : ''}>Date only</option>
                        <option value="time"${b.format === 'time' ? ' selected' : ''}>Time only</option>
                    </select>
                </div>
                ${rangeRow('Font size', `min="10" max="40" value="${b.size}" oninput="updateBlock('${id}','size',+this.value); document.getElementById('dts_${id}').textContent=this.value; schedulePreview()"`, `dts_${id}`, b.size)}
                <div class="fr"><label>Align</label>
                    <select onchange="updateBlock('${id}','align',this.value); schedulePreview()">${alignOptions(b.align)}</select>
                </div>
            </div>`;

        case 'separator': return `
            <div class="fg">
                <div class="fr"><label>Line style</label>
                    <select onchange="updateBlock('${id}','style',this.value); schedulePreview()">
                        <option value="solid"${b.style === 'solid' ? ' selected' : ''}>— Solid</option>
                        <option value="dashed"${b.style === 'dashed' ? ' selected' : ''}>- - Dashed</option>
                        <option value="dotted"${b.style === 'dotted' ? ' selected' : ''}>· · Dotted</option>
                        <option value="double"${b.style === 'double' ? ' selected' : ''}>═ Double</option>
                        <option value="wave"${b.style === 'wave' ? ' selected' : ''}>~ Wave</option>
                    </select>
                </div>
                ${rangeRow('Thickness', `min="1" max="8" value="${b.thickness}" oninput="updateBlock('${id}','thickness',+this.value); document.getElementById('st_${id}').textContent=this.value; schedulePreview()"`, `st_${id}`, b.thickness)}
                ${rangeRow('Padding', `min="0" max="50" value="${b.padding}" oninput="updateBlock('${id}','padding',+this.value); document.getElementById('sp_${id}').textContent=this.value; schedulePreview()"`, `sp_${id}`, b.padding)}
            </div>`;

        case 'spacer': return `
            ${rangeRow('Blank height', `min="4" max="200" value="${b.height}" oninput="updateBlock('${id}','height',+this.value); document.getElementById('spv_${id}').textContent=this.value; schedulePreview()"`, `spv_${id}`, b.height)}`;

        case 'asciiart': return `
            <div class="fr"><label>Text — one word per line works best</label>
                <textarea rows="3" oninput="updateBlock('${id}','text',this.value); updateSummary('${id}', this.value.split('\\n')[0]); schedulePreview()">${b.text}</textarea>
            </div>
            <div class="fg">
                <div class="fr"><label>Render style</label>
                    <select onchange="updateBlock('${id}','font',this.value); schedulePreview()">
                        <option value="block"${b.font === 'block' ? ' selected' : ''}>Block ▓</option>
                        <option value="shadow"${b.font === 'shadow' ? ' selected' : ''}>Shadow</option>
                        <option value="outline"${b.font === 'outline' ? ' selected' : ''}>Outline □</option>
                        <option value="thin"${b.font === 'thin' ? ' selected' : ''}>Thin lines</option>
                        <option value="dots"${b.font === 'dots' ? ' selected' : ''}>Dots ●</option>
                    </select>
                </div>
                ${rangeRow('Scale', `min="1" max="4" step="1" value="${b.scale}" oninput="updateBlock('${id}','scale',+this.value); document.getElementById('asc_${id}').textContent=this.value; schedulePreview()"`, `asc_${id}`, b.scale)}
                <div class="fr"><label>Invert (white on black)</label>
                    <select onchange="updateBlock('${id}','invert',this.value==='1'); schedulePreview()">
                        <option value="0"${!b.invert ? ' selected' : ''}>No</option>
                        <option value="1"${b.invert ? ' selected' : ''}>Yes</option>
                    </select>
                </div>
            </div>`;

        case 'bigtext': return `
            <div class="fr"><label>Text (auto-sized to full width)</label>
                <input type="text" value="${b.text}" oninput="updateBlock('${id}','text',this.value); updateSummary('${id}', this.value); schedulePreview()">
            </div>
            <div class="fg">
                <div class="fr"><label>Style</label>
                    <select onchange="updateBlock('${id}','font',this.value); schedulePreview()">
                        <option value="banner"${b.font === 'banner' ? ' selected' : ''}>Banner (Impact)</option>
                        <option value="block"${b.font === 'block' ? ' selected' : ''}>Bold Block</option>
                        <option value="outline"${b.font === 'outline' ? ' selected' : ''}>Outline stroke</option>
                    </select>
                </div>
                <div class="fr"><label>Align</label>
                    <select onchange="updateBlock('${id}','align',this.value); schedulePreview()">${alignOptions(b.align)}</select>
                </div>
            </div>`;

        case 'receipt': return `
            <div class="fr"><label>Receipt title</label>
                <input type="text" value="${b.title}" oninput="updateBlock('${id}','title',this.value); schedulePreview()">
            </div>
            <div class="fg">
                <div class="fr"><label>Currency symbol</label>
                    <input type="text" value="${b.currency}" oninput="updateBlock('${id}','currency',this.value); schedulePreview()">
                </div>
                ${rangeRow('Tax %', `min="0" max="30" value="${b.tax}" oninput="updateBlock('${id}','tax',+this.value); document.getElementById('rx_${id}').textContent=this.value; schedulePreview()"`, `rx_${id}`, b.tax)}
            </div>
            <div id="ri_${id}" style="margin-top:8px; display:flex; flex-direction:column; gap:3px">
                ${b.items.map((item, i) => `
                    <div style="display:grid; grid-template-columns:1fr 64px 22px; gap:3px">
                        <input class="tce" value="${item.label}" placeholder="Item name"
                            oninput="receiptItemUpdate('${id}', ${i}, 'label', this.value)">
                        <input class="tce" value="${item.price}" placeholder="0.00"
                            oninput="receiptItemUpdate('${id}', ${i}, 'price', this.value)">
                        <button class="bact del" onclick="receiptItemRemove('${id}', ${i})">✕</button>
                    </div>`).join('')}
            </div>
            <button class="add-row-btn" style="margin-top:4px" onclick="receiptItemAdd('${id}')">+ Add item</button>`;

        case 'wifi': return `
            <div class="fr"><label>Network name (SSID)</label>
                <input type="text" value="${b.ssid}"
                    oninput="updateBlock('${id}','ssid',this.value); updateSummary('${id}', this.value); schedulePreview()">
            </div>
            <div class="fr"><label>Password</label>
                <input type="text" value="${b.password}" oninput="updateBlock('${id}','password',this.value); schedulePreview()">
            </div>
            <div class="fg">
                <div class="fr"><label>Security type</label>
                    <select onchange="updateBlock('${id}','security',this.value); schedulePreview()">
                        <option value="WPA"${b.security === 'WPA' ? ' selected' : ''}>WPA / WPA2</option>
                        <option value="WEP"${b.security === 'WEP' ? ' selected' : ''}>WEP</option>
                        <option value="nopass"${b.security === 'nopass' ? ' selected' : ''}>Open (no password)</option>
                    </select>
                </div>
                <div class="fr"><label>Hidden network</label>
                    <select onchange="updateBlock('${id}','hidden',this.value==='1'); schedulePreview()">
                        <option value="0"${!b.hidden ? ' selected' : ''}>No</option>
                        <option value="1"${b.hidden ? ' selected' : ''}>Yes</option>
                    </select>
                </div>
            </div>`;

        case 'note': return `
            <div class="fr"><label>Content</label>
                <textarea oninput="updateBlock('${id}','text',this.value); schedulePreview()">${b.text}</textarea>
            </div>
            <div class="fg">
                <div class="fr"><label>Border style</label>
                    <select onchange="updateBlock('${id}','style',this.value); schedulePreview()">
                        <option value="box"${b.style === 'box' ? ' selected' : ''}>Box ┌─┐</option>
                        <option value="double"${b.style === 'double' ? ' selected' : ''}>Double ╔═╗</option>
                        <option value="round"${b.style === 'round' ? ' selected' : ''}>Rounded ╭─╮</option>
                        <option value="shadow"${b.style === 'shadow' ? ' selected' : ''}>Shadow</option>
                        <option value="none"${b.style === 'none' ? ' selected' : ''}>None</option>
                    </select>
                </div>
                ${rangeRow('Font size', `min="10" max="28" value="${b.size}" oninput="updateBlock('${id}','size',+this.value); document.getElementById('ns_${id}').textContent=this.value; schedulePreview()"`, `ns_${id}`, b.size)}
                <div class="fr"><label>Align</label>
                    <select onchange="updateBlock('${id}','align',this.value); schedulePreview()">${alignOptions(b.align)}</select>
                </div>
            </div>`;

        case 'progress': return `
            <div class="fr"><label>Label text</label>
                <input type="text" value="${b.label}" oninput="updateBlock('${id}','label',this.value); schedulePreview()">
            </div>
            <div class="fg">
                ${rangeRow('Value %', `min="0" max="100" value="${b.value}" oninput="updateBlock('${id}','value',+this.value); document.getElementById('pv_${id}').textContent=this.value; schedulePreview()"`, `pv_${id}`, b.value)}
                <div class="fr"><label>Bar style</label>
                    <select onchange="updateBlock('${id}','style',this.value); schedulePreview()">
                        <option value="filled"${b.style === 'filled' ? ' selected' : ''}>Filled ████</option>
                        <option value="hollow"${b.style === 'hollow' ? ' selected' : ''}>Hollow [████  ]</option>
                        <option value="dots"${b.style === 'dots' ? ' selected' : ''}>Dots ●●●○○</option>
                        <option value="steps"${b.style === 'steps' ? ' selected' : ''}>Steps ▁▃▅▇</option>
                    </select>
                </div>
            </div>`;

        case 'badge': return `
            <div class="fr"><label>Small top line</label>
                <input type="text" value="${b.line1}" oninput="updateBlock('${id}','line1',this.value); schedulePreview()">
            </div>
            <div class="fr"><label>Medium middle line</label>
                <input type="text" value="${b.line2}" oninput="updateBlock('${id}','line2',this.value); schedulePreview()">
            </div>
            <div class="fr"><label>Large name line</label>
                <input type="text" value="${b.line3}" oninput="updateBlock('${id}','line3',this.value); updateSummary('${id}', this.value); schedulePreview()">
            </div>
            <div class="fg">
                ${rangeRow('Line 1 size', `min="8" max="30" value="${b.size1}" oninput="updateBlock('${id}','size1',+this.value); document.getElementById('b1_${id}').textContent=this.value; schedulePreview()"`, `b1_${id}`, b.size1)}
                ${rangeRow('Line 2 size', `min="14" max="40" value="${b.size2}" oninput="updateBlock('${id}','size2',+this.value); document.getElementById('b2_${id}').textContent=this.value; schedulePreview()"`, `b2_${id}`, b.size2)}
                ${rangeRow('Line 3 size', `min="20" max="60" value="${b.size3}" oninput="updateBlock('${id}','size3',+this.value); document.getElementById('b3_${id}').textContent=this.value; schedulePreview()"`, `b3_${id}`, b.size3)}
            </div>`;

        case 'grid': return `
            <div class="fg">
                ${rangeRow('Columns', `min="2" max="16" value="${b.cols}" oninput="updateBlock('${id}','cols',+this.value); document.getElementById('gc_${id}').textContent=this.value; schedulePreview()"`, `gc_${id}`, b.cols)}
                ${rangeRow('Rows', `min="2" max="20" value="${b.rows}" oninput="updateBlock('${id}','rows',+this.value); document.getElementById('gr_${id}').textContent=this.value; schedulePreview()"`, `gr_${id}`, b.rows)}
                ${rangeRow('Cell size (px)', `min="8" max="48" value="${b.cellW}" oninput="updateBlock('${id}','cellW',+this.value); document.getElementById('gcs_${id}').textContent=this.value; schedulePreview()"`, `gcs_${id}`, b.cellW)}
                <div class="fr"><label>Label (optional)</label>
                    <input type="text" value="${b.label}" oninput="updateBlock('${id}','label',this.value); schedulePreview()">
                </div>
            </div>`;

        case 'tags': return `
            <div class="fr"><label>Tags — comma separated</label>
                <input type="text" value="${b.items.join(', ')}"
                    oninput="updateBlock('${id}','items', this.value.split(',').map(s=>s.trim()).filter(Boolean)); schedulePreview()">
            </div>
            <div class="fr"><label>Style</label>
                <select onchange="updateBlock('${id}','style',this.value); schedulePreview()">
                    <option value="rounded"${b.style === 'rounded' ? ' selected' : ''}>Rounded pill</option>
                    <option value="square"${b.style === 'square' ? ' selected' : ''}>Square</option>
                    <option value="inverted"${b.style === 'inverted' ? ' selected' : ''}>Inverted</option>
                </select>
            </div>`;

        case 'calendar': return `
            <div class="fg">
                <div class="fr"><label>Month (0 = current)</label>
                    <input type="number" min="0" max="12" value="${b.month || 0}"
                        oninput="updateBlock('${id}','month',+this.value); schedulePreview()">
                </div>
                <div class="fr"><label>Year (0 = current)</label>
                    <input type="number" min="0" max="2099" value="${b.year || 0}"
                        oninput="updateBlock('${id}','year',+this.value); schedulePreview()">
                </div>
            </div>`;

        default: return `<div class="fr" style="color:var(--muted);font-size:.7rem">No settings for this block type.</div>`;
    }
}


// ============================================================
//  SECTION 7 — SUB-EDITORS (Table, Checklist, Drawing)
// ============================================================

/** Re-render the table row/cell editor grid inside a card. */
function renderTableEditor(card, block) {
    const container = card.querySelector('#tg_' + block.id);
    if (!container) return;
    container.innerHTML = '';

    block.rows.forEach((row, rowIndex) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'table-row-e';
        rowDiv.style.gridTemplateColumns = `repeat(${block.cols}, 1fr) 22px`;

        row.slice(0, block.cols).forEach((cell, colIndex) => {
            const input = document.createElement('input');
            input.className = 'tce';
            input.value     = cell;
            if (rowIndex === 0 && block.bold_header) input.style.fontWeight = '700';
            input.oninput = () => {
                block.rows[rowIndex][colIndex] = input.value;
                schedulePreview();
            };
            rowDiv.appendChild(input);
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'bact del';
        delBtn.textContent = '✕';
        delBtn.title = 'Remove row';
        delBtn.onclick = () => {
            block.rows.splice(rowIndex, 1);
            renderTableEditor(card, block);
            schedulePreview();
        };
        rowDiv.appendChild(delBtn);
        container.appendChild(rowDiv);
    });

    const addBtn = document.createElement('button');
    addBtn.className   = 'add-row-btn';
    addBtn.textContent = '+ Add row';
    addBtn.onclick = () => {
        block.rows.push(new Array(block.cols).fill(''));
        renderTableEditor(card, block);
        schedulePreview();
    };
    container.appendChild(addBtn);
}

/** Adjust all rows to match the new column count when cols selector changes. */
function adjustTableColumns(id) {
    const block = blocks.find(b => b.id === id);
    if (!block) return;
    block.rows = block.rows.map(row => {
        while (row.length < block.cols) row.push('');
        return row.slice(0, block.cols);
    });
    const card = document.querySelector(`[data-id="${id}"]`);
    if (card) renderTableEditor(card, block);
}

/** Re-render the checklist item editor inside a card. */
function renderChecklistEditor(card, block) {
    const container = card.querySelector('#ce_' + block.id);
    if (!container) return;
    container.innerHTML = '';

    block.items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'check-row';

        const checkbox = document.createElement('div');
        checkbox.className = 'chk-pre';
        checkbox.style.background = block.checked[i] ? 'var(--ink)' : 'transparent';
        checkbox.style.cursor = 'pointer';
        checkbox.onclick = () => {
            block.checked[i] = !block.checked[i];
            checkbox.style.background = block.checked[i] ? 'var(--ink)' : 'transparent';
            schedulePreview();
        };

        const input = document.createElement('input');
        input.type  = 'text';
        input.value = item;
        input.oninput = () => {
            block.items[i] = input.value;
            schedulePreview();
        };

        const delBtn = document.createElement('button');
        delBtn.className   = 'bact del';
        delBtn.textContent = '✕';
        delBtn.onclick = () => {
            block.items.splice(i, 1);
            block.checked.splice(i, 1);
            renderChecklistEditor(card, block);
            schedulePreview();
        };

        row.append(checkbox, input, delBtn);
        container.appendChild(row);
    });
}

/** Append a new empty item to a checklist block. */
function addChecklistItem(id) {
    const block = blocks.find(b => b.id === id);
    if (!block) return;
    block.items.push('New item');
    block.checked.push(false);
    const card = document.querySelector(`[data-id="${id}"]`);
    if (card) renderChecklistEditor(card, block);
    schedulePreview();
}

// ── Drawing canvas ──────────────────────────────────────────────────

/** Per-block drawing tool state (tool type and stroke width). */
const drawingState = {};

/**
 * Attach mouse/touch event listeners to a drawing canvas.
 * Skips re-binding if the block already has a state entry.
 */
function initDrawingCanvas(card, block) {
    const canvas = card.querySelector('#dc_' + block.id);
    if (!canvas) return;

    canvas.width  = getPrintWidth();
    canvas.height = block.height;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Restore saved drawing if any
    if (block.dataUrl) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        img.src = block.dataUrl;
    }

    // Don't re-bind listeners if already set up
    if (drawingState[block.id]) return;
	drawingState[block.id] = {
		tool: 'pen',
		strokeWidth: 2,
		drawing: false,
		lastX: 0,
		lastY: 0
	};
    const state = drawingState[block.id];

    function getPosition(e) {
        const rect = canvas.getBoundingClientRect();
        const src  = e.touches ? e.touches[0] : e;
        return {
            x: (src.clientX - rect.left) * canvas.width  / rect.width,
            y: (src.clientY - rect.top)  * canvas.height / rect.height,
        };
    }

    function startDraw(e) {
        e.preventDefault();
        state.drawing = true;
        const pos = getPosition(e);
        state.lastX = pos.x;
        state.lastY = pos.y;
    }

    function moveDraw(e) {
        e.preventDefault();
        if (!state.drawing) return;
        const pos = getPosition(e);
        ctx.beginPath();
        ctx.strokeStyle = state.tool === 'eraser' ? '#fff' : '#000';
        ctx.lineWidth   = state.tool === 'eraser' ? 20 : state.strokeWidth;
        ctx.lineCap     = 'round';
        ctx.moveTo(state.lastX, state.lastY);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
        state.lastX    = pos.x;
        state.lastY    = pos.y;
        block.dataUrl  = canvas.toDataURL();
        schedulePreview();
    }

    function endDraw() { state.drawing = false; }

    canvas.addEventListener('mousedown',  startDraw);
    canvas.addEventListener('mousemove',  moveDraw);
    canvas.addEventListener('mouseup',    endDraw);
    canvas.addEventListener('mouseleave', endDraw);
    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove',  moveDraw,  { passive: false });
    canvas.addEventListener('touchend',   endDraw);
}

function setDrawingTool(id, tool, buttonEl) {
    if (drawingState[id]) drawingState[id].tool = tool;
    const card = document.querySelector(`[data-id="${id}"]`);
    if (card) card.querySelectorAll('.dtool').forEach(b => b.classList.remove('on'));
    buttonEl.classList.add('on');
}

function setDrawingWidth(id, width) {
    if (drawingState[id]) drawingState[id].strokeWidth = width;
}

function clearDrawingCanvas(id) {
    const canvas = document.getElementById('dc_' + id);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const block = blocks.find(b => b.id === id);
    if (block) block.dataUrl = null;
    schedulePreview();
}

function resizeDrawingCanvas(id, height) {
    const canvas = document.getElementById('dc_' + id);
    if (!canvas) return;
    // Preserve existing content by copying to a temp canvas
    const tmp = document.createElement('canvas');
    tmp.width  = canvas.width;
    tmp.height = canvas.height;
    tmp.getContext('2d').drawImage(canvas, 0, 0);
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, height);
    ctx.drawImage(tmp, 0, 0);
}

// ── Image loading ──────────────────────────────────────────────────

/**
 * Load an image file from a file input into a block.
 * @param {Event}  e     - The file input change event
 * @param {string} id    - Block ID
 * @param {string} kind  - 'image' or 'logo'
 */
function loadBlockImage(e, id, kind) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
	reader.onload = ev => {
        const block = blocks.find(b => b.id === id);
        if (!block) return;
		block.src = ev.target.result;
        block.fileName = file.name;
		const dz = document.getElementById((kind === 'logo' ? 'ldz_' : 'dz_') + id);
        if (dz) dz.innerHTML = `<img src="${ev.target.result}"><br><small>${file.name}</small>`;
        updateSummary(id, file.name);
        schedulePreview();
    };
    reader.readAsDataURL(file);
}

function handleImageDrop(e, id, kind) {
    e.preventDefault();
	const dz = document.getElementById((kind === 'logo' ? 'ldz_' : 'dz_') + id);
    if (dz) dz.classList.remove('hov');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
		const inp = document.getElementById((kind === 'logo' ? 'lfi_' : 'fi_') + id);
		const dt = new DataTransfer();
        dt.items.add(file);
		inp.files = dt.files;
		loadBlockImage({
			target: inp
		}, id, kind);
    }
}

// ── Receipt helpers ───────────────────────────────────────────────

function receiptItemUpdate(id, index, key, value) {
    const block = blocks.find(b => b.id === id);
    if (block) block.items[index][key] = value;
    schedulePreview();
}

function receiptItemRemove(id, index) {
    const block = blocks.find(b => b.id === id);
    if (!block) return;
    block.items.splice(index, 1);
    renderBlockList();
    schedulePreview();
}

function receiptItemAdd(id) {
    const block = blocks.find(b => b.id === id);
    if (!block) return;
	block.items.push({
		label: 'New item',
		price: '0.00'
	});
    renderBlockList();
    schedulePreview();
}


// ============================================================
//  SECTION 8 — RENDER ENGINE
//
//  KEY DESIGN: All rendering writes directly onto a single
//  reusable canvas (`_compositeCanvas`). No intermediate
//  per-block canvases are created. This avoids the mobile
//  WebGL canvas limit (typically 8–16 simultaneous canvases)
//  and eliminates memory leaks from abandoned canvas elements.
//
//  Async blocks (image, QR, wifi) return a Promise that
//  resolves with the height drawn. Sync blocks return the
//  height as a plain number.
//
//  composeAll() first measures total height, resizes the
//  composite canvas once, then renders each block in sequence.
// ============================================================

/** The single shared canvas used for all preview rendering. */
// const pCanvas = document.getElementById('preview-canvas');
// const _compositeCanvas = new OffscreenCanvas(pCanvas.width, pCanvas.height);
const _compositeCanvas =  document.createElement('canvas');
const _compositeCtx    = _compositeCanvas.getContext('2d', { willReadFrequently: true });

/**
 * Shared offscreen measurement canvas.
 * Used only for measureText — never displayed.
 */
const _measureCanvas = document.createElement('canvas');
const _measureCtx    = _measureCanvas.getContext('2d', { willReadFrequently: true });

// ── Dithering ──────────────────────────────────────────────────────

/**
 * Apply a dithering algorithm to an ImageData object in-place.
 * Converts the image to 1-bit black/white suitable for thermal printing.
 *
 * @param {ImageData} imgData   - Source image data (modified in place)
 * @param {string}    mode      - 'atkinson', 'floyd', 'threshold', or 'none'
 * @param {number}    threshold - Luminance threshold (0–255)
 * @returns {ImageData}         - The modified image data
 */
function ditherImageData(imgData, mode, threshold) {
    const w = imgData.width;
    const h = imgData.height;
    const count = w * h;

    // Convert RGB to greyscale luminance values in a Float32 buffer for error diffusion
    const luma = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        luma[i] = 0.299 * imgData.data[i * 4]
                + 0.587 * imgData.data[i * 4 + 1]
                + 0.114 * imgData.data[i * 4 + 2];
    }

    if (mode === 'threshold' || mode === 'none') {
        for (let i = 0; i < count; i++) {
            const v = luma[i] < threshold ? 0 : 255;
            imgData.data[i * 4]     = v;
            imgData.data[i * 4 + 1] = v;
            imgData.data[i * 4 + 2] = v;
            imgData.data[i * 4 + 3] = 255;
        }
        return imgData;
    }

    if (mode === 'floyd') {
        // Floyd-Steinberg error diffusion
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i    = y * w + x;
                const old  = luma[i];
                const nw   = old < threshold ? 0 : 255;
                luma[i]    = nw;
                const err  = old - nw;
                if (x + 1 < w)              luma[i + 1]         += err * 7 / 16;
                if (y + 1 < h && x > 0)     luma[(y+1)*w + x-1] += err * 3 / 16;
                if (y + 1 < h)              luma[(y+1)*w + x]   += err * 5 / 16;
                if (y + 1 < h && x + 1 < w) luma[(y+1)*w + x+1] += err * 1 / 16;
            }
        }
    } else {
        // Atkinson dithering (lighter, retains highlights better)
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i   = y * w + x;
                const old = luma[i];
                const nw  = old < threshold ? 0 : 255;
                luma[i]   = nw;
                const err = (old - nw) / 8;
                const neighbours = [[0,1],[0,2],[1,-1],[1,0],[1,1],[2,0]];
                for (const [dy, dx] of neighbours) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                        luma[ny * w + nx] += err;
                    }
                }
            }
        }
    }

    // Write quantised luma back to RGBA
    for (let i = 0; i < count; i++) {
        const v = Math.max(0, Math.min(255, luma[i]));
        imgData.data[i * 4]     = v;
        imgData.data[i * 4 + 1] = v;
        imgData.data[i * 4 + 2] = v;
        imgData.data[i * 4 + 3] = 255;
    }
    return imgData;
}

// ── Text measurement helper ────────────────────────────────────────

/**
 * Word-wrap `text` to fit within `maxWidth` pixels using the given font string.
 * Returns an array of line strings.
 */
function wrapText(text, fontStr, maxWidth) {
    _measureCtx.font = fontStr;
    const lines = [];
    for (const paragraph of text.split('\n')) {
        if (paragraph === '') { lines.push(''); continue; }
        const words = paragraph.split(' ');
        let current = '';
        for (const word of words) {
            const candidate = current ? current + ' ' + word : word;
            if (_measureCtx.measureText(candidate).width > maxWidth && current) {
                lines.push(current);
                current = word;
            } else {
                current = candidate;
            }
        }
        if (current) lines.push(current);
    }
    return lines;
}

// ── Direct-draw render functions ───────────────────────────────────
//
// Each drawBlock_XXX function accepts:
//   ctx    — the shared composite canvas 2D context
//   block  — the block data object
//   y      — the Y offset to start drawing at
//   W      — the print width in pixels
//
// It draws directly into ctx and returns the height of the drawn content.
// Async variants return a Promise<number>.

function drawBlock_text(ctx, block, y, W, invert = false) {
    const fontStr = `${block.bold} ${block.size}px ${block.font}`;
    const lines   = wrapText(block.text, fontStr, W - 4);
    const lineH   = block.size * 1.38;
    const height  = Math.max(lines.length * lineH + 6, block.size + 6);

    ctx.fillStyle = invert ? '#000' : '#fff';
    ctx.fillRect(0, y, W, height);
    ctx.fillStyle = invert ? '#fff' : '#000';
    ctx.font      = fontStr;
    ctx.textAlign = block.align;
    const x = block.align === 'left' ? 2 : block.align === 'right' ? W - 2 : W / 2;
    let lineY = y + block.size;
    for (const line of lines) {
        ctx.fillText(line, x, lineY);
        lineY += lineH;
    }
    return height;
}

function drawBlock_separator(ctx, block, y, W) {
    const height = block.padding * 2 + block.thickness + 2;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = block.thickness;
    const lineY = y + height / 2;

    ctx.setLineDash([]);
    if (block.style === 'solid') {
        ctx.beginPath();
        ctx.moveTo(4, lineY);
        ctx.lineTo(W - 4, lineY);
        ctx.stroke();
    } else if (block.style === 'dashed') {
        ctx.setLineDash([10, 6]);
        ctx.beginPath(); ctx.moveTo(4, lineY); ctx.lineTo(W - 4, lineY); ctx.stroke();
        ctx.setLineDash([]);
    } else if (block.style === 'dotted') {
        ctx.setLineDash([2, 6]);
        ctx.beginPath(); ctx.moveTo(4, lineY); ctx.lineTo(W - 4, lineY); ctx.stroke();
        ctx.setLineDash([]);
    } else if (block.style === 'double') {
        const d = block.thickness + 3;
        ctx.lineWidth = Math.max(1, block.thickness / 2);
        ctx.beginPath(); ctx.moveTo(4, lineY - d/2); ctx.lineTo(W - 4, lineY - d/2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(4, lineY + d/2); ctx.lineTo(W - 4, lineY + d/2); ctx.stroke();
    } else if (block.style === 'wave') {
        ctx.beginPath();
        ctx.moveTo(0, lineY);
        for (let x = 0; x < W; x += 8) {
            ctx.quadraticCurveTo(
                x + 4, lineY + (x % 16 < 8 ? -4 * block.thickness : 4 * block.thickness),
                x + 8, lineY
            );
        }
        ctx.stroke();
    }
    return height;
}

function drawBlock_spacer(ctx, block, y, W) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, block.height);
    return block.height;
}

function drawBlock_datetime(ctx, block, y, W) {
    const now = new Date();
    let str;
    if      (block.format === 'full') str = now.toLocaleString('en-US');
    else if (block.format === 'date') str = now.toLocaleDateString('en-US');
    else                              str = now.toLocaleTimeString('en-US');
    const fakeBlock = { text: str, size: block.size, align: block.align, font: 'monospace', bold: 'normal' };
    return drawBlock_text(ctx, fakeBlock, y, W, false);
}

function drawBlock_countdown(ctx, block, y, W) {
    const target = new Date(block.target);
    const days   = Math.max(0, Math.ceil((target - new Date()) / 864e5));
    const height = block.size * 1.5 + 30;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);
    ctx.fillStyle = '#000';
    ctx.textAlign = block.align;
    const x = block.align === 'left' ? 4 : block.align === 'right' ? W - 4 : W / 2;
    ctx.font = `bold ${block.size}px monospace`;
    ctx.fillText(String(days), x, y + block.size + 2);
    ctx.font = '14px monospace';
    ctx.fillText(block.label, x, y + block.size + 22);
    return height;
}

function drawBlock_ruler(ctx, block, y, W) {
    const ruleW  = Math.floor(W * block.width / 100);
    const originX = Math.floor((W - ruleW) / 2);
    const height  = 40;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(originX, y + 8);
    ctx.lineTo(originX + ruleW, y + 8);
    ctx.stroke();

    for (let i = 0; i <= block.ticks; i++) {
        const tx     = originX + Math.round(i * ruleW / block.ticks);
        const bigTick = i % 5 === 0 || block.ticks <= 5;
        const tickH  = bigTick ? 16 : 10;
        ctx.beginPath();
        ctx.moveTo(tx, y + 8);
        ctx.lineTo(tx, y + 8 + tickH);
        ctx.stroke();
        if (bigTick) {
            ctx.font      = '9px monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#000';
            ctx.fillText(`${i}${block.unit}`, tx, y + 36);
        }
    }
    return height;
}

function drawBlock_table(ctx, block, y, W) {
    const fs   = block.fontSize || 14;
    const lineH = fs * 1.6;
    const colW = Math.floor(W / block.cols);
    const height = block.rows.length * lineH + 4;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);

    block.rows.forEach((row, rowIndex) => {
        const isHeader = rowIndex === 0 && block.bold_header;
        const rowY     = y + rowIndex * lineH;
        if (isHeader) {
            ctx.fillStyle = '#111';
            ctx.fillRect(0, rowY, W, lineH);
        } else if (rowIndex % 2 === 1) {
            ctx.fillStyle = '#efefef';
            ctx.fillRect(0, rowY, W, lineH);
        }

        row.slice(0, block.cols).forEach((cell, colIndex) => {
            ctx.font      = `${isHeader ? 'bold ' : ''}${fs}px monospace`;
            ctx.fillStyle = isHeader ? '#fff' : '#111';
            ctx.textAlign = 'left';
            ctx.fillText(String(cell).substring(0, Math.floor(colW / fs * 1.6)), colIndex * colW + 4, rowY + fs + 2);
            if (colIndex > 0) {
                ctx.fillStyle = '#ccc';
                ctx.fillRect(colIndex * colW, rowY, 1, lineH);
            }
        });
    });
    return height;
}

function drawBlock_checklist(ctx, block, y, W) {
    const fs     = 15;
    const lineH  = fs * 1.7;
    const height = block.items.length * lineH + 8;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);

    block.items.forEach((item, i) => {
        const itemY = y + i * lineH + 4;
        ctx.strokeStyle = '#000';
        ctx.lineWidth   = 1.5;
        ctx.strokeRect(4, itemY + 2, fs - 4, fs - 4);

        if (block.checked[i]) {
            ctx.beginPath();
            ctx.lineWidth = 2;
            ctx.moveTo(5, itemY + fs / 2);
            ctx.lineTo(fs / 2 - 2, itemY + fs - 6);
            ctx.lineTo(fs + 2, itemY);
            ctx.stroke();
        }

        ctx.font      = `${fs}px monospace`;
        ctx.textAlign = 'left';
        if (block.checked[i]) {
            ctx.fillStyle = '#888';
            ctx.fillText(item, fs + 8, itemY + fs - 2);
            ctx.fillRect(fs + 8, itemY + fs / 2 - 1, ctx.measureText(item).width, 1.5);
        } else {
            ctx.fillStyle = '#000';
            ctx.fillText(item, fs + 8, itemY + fs - 2);
        }
    });
    return height;
}

function drawBlock_barcode(ctx, block, y, W) {
    const bars = buildCode128Bars(block.content);
    const moduleW  = 2;
    const totalBar = bars.reduce((s, b) => s + b.w, 0) * moduleW;
    const textH    = block.showText ? 16 : 0;
    const height   = block.height + textH + 8;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);

    let barX = Math.floor((W - totalBar) / 2);
    for (const bar of bars) {
        if (bar.black) {
            ctx.fillStyle = '#000';
            ctx.fillRect(barX, y + 4, bar.w * moduleW, block.height);
        }
        barX += bar.w * moduleW;
    }

    if (block.showText) {
        ctx.fillStyle = '#000';
        ctx.font      = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(block.content, W / 2, y + block.height + 18);
    }
    return height;
}

function drawBlock_progress(ctx, block, y, W) {
    const fs     = 13;
    const pad    = 8;
    const barH   = 20;
    const height = fs + pad + barH + pad;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);
    ctx.fillStyle = '#000';
    ctx.font      = `${fs}px monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(block.label, pad, y + fs + 2);
    ctx.textAlign = 'right';
    ctx.fillText(block.value + '%', W - pad, y + fs + 2);

    const barX   = pad;
    const barY   = y + fs + pad;
    const barW   = W - pad * 2;
    const filled = Math.round(barW * block.value / 100);

    if (block.style === 'hollow') {
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
        ctx.strokeRect(barX, barY, barW, barH);
        ctx.fillStyle = '#000';
        ctx.fillRect(barX + 2, barY + 2, Math.max(0, filled - 4), barH - 4);
    } else if (block.style === 'dots') {
        const dotD  = barH - 4;
        const step  = dotD + 4;
        const total = Math.floor(barW / step);
        for (let i = 0; i < total; i++) {
            ctx.beginPath();
            ctx.arc(barX + i * step + dotD / 2, barY + barH / 2, dotD / 2, 0, Math.PI * 2);
            ctx.fillStyle = (i / total <= block.value / 100) ? '#000' : '#ccc';
            ctx.fill();
        }
    } else if (block.style === 'steps') {
        const steps = ['▁','▂','▃','▄','▅','▆','▇','█'];
        const step  = barW / steps.length;
        ctx.font      = `${barH}px monospace`;
        ctx.textAlign = 'left';
        for (let i = 0; i < steps.length; i++) {
            ctx.fillStyle = ((i + 1) / steps.length <= block.value / 100) ? '#000' : '#ccc';
            ctx.fillText(steps[i], barX + i * step, barY + barH - 2);
        }
    } else {
        // Filled (default)
        ctx.fillStyle = '#ddd'; ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = '#000'; ctx.fillRect(barX, barY, filled, barH);
    }
    return height;
}

function drawBlock_badge(ctx, block, y, W) {
    const pad    = 10;
    const height = block.size1 + block.size2 + block.size3 + pad * 4 + 16;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.strokeRect(4,         y + 4,         W - 8,  height - 8);
    ctx.strokeRect(7,         y + 7,         W - 14, height - 14);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    let lineY = y + pad;
    ctx.font = `${block.size1}px sans-serif`;
    ctx.fillText(block.line1, W / 2, lineY + block.size1);
    lineY += block.size1 + 6;
    ctx.font = `${block.size2}px sans-serif`;
    ctx.fillText(block.line2, W / 2, lineY + block.size2);
    lineY += block.size2 + 6;
    ctx.font = `bold ${block.size3}px sans-serif`;
    ctx.fillText(block.line3, W / 2, lineY + block.size3);

    return height;
}

function drawBlock_grid(ctx, block, y, W) {
    const cW     = block.cellW;
    const gridW  = block.cols * cW;
    const gridH  = block.rows * cW;
    const labelH = block.label ? 16 : 0;
    const height = gridH + labelH + 8;
    const originX = Math.floor((W - gridW) / 2);

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);

    ctx.strokeStyle = '#aaa';
    ctx.lineWidth   = 0.5;
    for (let col = 0; col <= block.cols; col++) {
        ctx.beginPath();
        ctx.moveTo(originX + col * cW, y + 4);
        ctx.lineTo(originX + col * cW, y + 4 + gridH);
        ctx.stroke();
    }
    for (let row = 0; row <= block.rows; row++) {
        ctx.beginPath();
        ctx.moveTo(originX,          y + 4 + row * cW);
        ctx.lineTo(originX + gridW,  y + 4 + row * cW);
        ctx.stroke();
    }
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(originX, y + 4, gridW, gridH);

    if (block.label) {
        ctx.fillStyle = '#000';
        ctx.font      = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(block.label, W / 2, y + gridH + labelH + 2);
    }
    return height;
}

function drawBlock_tags(ctx, block, y, W) {
    const fs    = 12;
    const pad   = 5;
    const gap   = 6;
    const tagH  = fs + pad * 2;

    _measureCtx.font = `${fs}px monospace`;
    const maxLineW = W - 10;

    // Wrap tags into lines
    const tagLines = [];
    let currentLine = [], currentWidth = 0;
    for (const tag of block.items) {
        const tagW = _measureCtx.measureText(tag).width + pad * 2 + gap;
        if (currentWidth + tagW > maxLineW && currentLine.length) {
            tagLines.push(currentLine);
            currentLine  = [];
            currentWidth = 0;
        }
        currentLine.push(tag);
        currentWidth += tagW;
    }
    if (currentLine.length) tagLines.push(currentLine);

    const height = tagLines.length * (tagH + gap) + gap * 2;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);

    ctx.font = `${fs}px monospace`;
    let tagY = y + gap;

    for (const line of tagLines) {
        const totalW = line.reduce((s, t) => s + _measureCtx.measureText(t).width + pad * 2 + gap, 0) - gap;
        let tagX = Math.floor((W - totalW) / 2);

        for (const tag of line) {
            const tagW = _measureCtx.measureText(tag).width + pad * 2;
            const r    = block.style === 'rounded' ? 9 : 2;

            if (block.style === 'inverted') {
                ctx.fillStyle = '#000';
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(tagX, tagY, tagW, tagH, r);
                else               ctx.rect(tagX, tagY, tagW, tagH);
                ctx.fill();
                ctx.fillStyle = '#fff';
            } else {
                ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(tagX, tagY, tagW, tagH, r);
                else               ctx.rect(tagX, tagY, tagW, tagH);
                ctx.stroke();
                ctx.fillStyle = '#000';
            }
            ctx.textAlign = 'left';
            ctx.fillText(tag, tagX + pad, tagY + fs + pad - 1);
            tagX += tagW + gap;
        }
        tagY += tagH + gap;
    }
    return height;
}

function drawBlock_note(ctx, block, y, W) {
    const fs      = block.size || 14;
    const lineH   = fs * 1.4;
    const pad     = 12;
    const border  = 2;
    const innerW  = W - pad * 2 - border * 2 - 8;

    const lines  = wrapText(block.text, `${fs}px monospace`, innerW);
    // Replace empty paragraphs
    const finalLines = block.text.split('\n').reduce((acc, para) => {
        if (para === '') { acc.push(''); return acc; }
        const wrapped = wrapText(para, `${fs}px monospace`, innerW);
        return acc.concat(wrapped);
    }, []);

    const height = pad * 2 + border * 2 + finalLines.length * lineH + 8;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);

    const bx = pad, by = y + pad, bw = W - pad * 2, bh = height - pad * 2;
    ctx.strokeStyle = '#000'; ctx.lineWidth = border;

    if (block.style === 'box') {
        ctx.strokeRect(bx, by, bw, bh);
    } else if (block.style === 'double') {
        ctx.strokeRect(bx,     by,     bw,     bh);
        ctx.strokeRect(bx + 3, by + 3, bw - 6, bh - 6);
    } else if (block.style === 'round') {
        const r = 8;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);        ctx.lineTo(bx + bw - r, by);
        ctx.arcTo(bx + bw, by,         bx + bw, by + r,     r);
        ctx.lineTo(bx + bw, by + bh - r);
        ctx.arcTo(bx + bw, by + bh,    bx + bw - r, by + bh, r);
        ctx.lineTo(bx + r, by + bh);
        ctx.arcTo(bx, by + bh,         bx, by + bh - r,   r);
        ctx.lineTo(bx, by + r);
        ctx.arcTo(bx, by,              bx + r, by,         r);
        ctx.closePath(); ctx.stroke();
    } else if (block.style === 'shadow') {
        ctx.fillStyle = '#bbb'; ctx.fillRect(bx + 4, by + 4, bw, bh);
        ctx.fillStyle = '#fff'; ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);
    }

    ctx.fillStyle = '#000';
    ctx.font      = `${fs}px monospace`;
    const textX   = block.align === 'center' ? W / 2 : block.align === 'right' ? W - pad - border - 4 : pad + border + 4;
    ctx.textAlign = block.align;
    let textY     = y + pad + border + fs + 2;
    for (const line of finalLines) {
        ctx.fillText(line, textX, textY);
        textY += lineH;
    }
    return height;
}

function drawBlock_receipt(ctx, block, y, W) {
    const fs       = 13;
    const lineH    = fs * 1.55;
    const pad      = 8;
    const subtotal = block.items.reduce((s, it) => s + parseFloat(it.price || 0), 0);
    const taxAmt   = subtotal * block.tax / 100;
    const total    = subtotal + taxAmt;
    const lineCount = 4 + block.items.length + (block.tax > 0 ? 1 : 0);
    const height   = pad * 2 + (fs + 4) + 8 + lineCount * lineH + pad;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);

    const dash = '─'.repeat(Math.floor((W - pad * 2) / 8));
    let drawY = y + pad;

    ctx.font = `bold ${fs + 2}px monospace`; ctx.fillStyle = '#000'; ctx.textAlign = 'center';
    ctx.fillText(block.title || 'Receipt', W / 2, drawY + fs + 2); drawY += fs + 8;

    ctx.font = `${fs}px monospace`; ctx.textAlign = 'left';
    ctx.fillText(dash, pad, drawY); drawY += lineH;

    ctx.font = `bold ${fs}px monospace`;
    ctx.fillText('Item', pad, drawY); ctx.textAlign = 'right'; ctx.fillText('Price', W - pad, drawY); drawY += lineH;

    ctx.textAlign = 'left'; ctx.font = `${fs}px monospace`;
    ctx.fillText(dash, pad, drawY); drawY += lineH;

    block.items.forEach(item => {
        ctx.textAlign = 'left';
        ctx.fillText(String(item.label).substring(0, 22), pad, drawY);
        ctx.textAlign = 'right';
        ctx.fillText(`${block.currency}${parseFloat(item.price || 0).toFixed(2)}`, W - pad, drawY);
        drawY += lineH;
    });

    ctx.textAlign = 'left'; ctx.fillText(dash, pad, drawY); drawY += lineH;

    if (block.tax > 0) {
        ctx.fillText(`Tax (${block.tax}%)`, pad, drawY);
        ctx.textAlign = 'right'; ctx.fillText(`${block.currency}${taxAmt.toFixed(2)}`, W - pad, drawY);
        drawY += lineH;
    }

    ctx.font = `bold ${fs + 2}px monospace`;
    ctx.textAlign = 'left';  ctx.fillText('TOTAL', pad, drawY);
    ctx.textAlign = 'right'; ctx.fillText(`${block.currency}${total.toFixed(2)}`, W - pad, drawY);

    return height;
}

function drawBlock_calendar(ctx, block, y, W) {
    const now   = new Date();
    const month = (block.month && block.month > 0) ? block.month - 1 : now.getMonth();
    const year  = (block.year  && block.year  > 0) ? block.year      : now.getFullYear();

    const firstDay     = new Date(year, month, 1).getDay();
    const daysInMonth  = new Date(year, month + 1, 0).getDate();
    const DAYS         = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const MONTHS       = ['January','February','March','April','May','June',
                          'July','August','September','October','November','December'];

    const fs         = 11;
    const cellW      = Math.floor(W / 7);
    const cellH      = fs + 7;
    const pad        = 4;
    const totalRows  = Math.ceil((firstDay + daysInMonth) / 7);
    const height     = pad + (fs + 4) + cellH + totalRows * cellH + pad;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);

    // Month + year header
    ctx.font = `bold ${fs + 2}px monospace`; ctx.fillStyle = '#000'; ctx.textAlign = 'center';
    ctx.fillText(`${MONTHS[month]} ${year}`, W / 2, y + pad + fs + 2);

    // Day name row
    let rowY = y + pad + fs + 6;
    ctx.font = `bold ${fs}px monospace`;
    DAYS.forEach((d, i) => {
        ctx.fillStyle = i === 0 ? '#888' : '#000';
        ctx.textAlign = 'center';
        ctx.fillText(d, i * cellW + cellW / 2, rowY + fs);
    });
    rowY += cellH;

    // Day numbers
    ctx.font = `${fs}px monospace`;
    let day = 1, col = firstDay;
    for (let row = 0; row < totalRows; row++) {
        for (let c = col; c < 7 && day <= daysInMonth; c++) {
            const isToday = day === now.getDate() && month === now.getMonth() && year === now.getFullYear();
            if (isToday) {
                ctx.fillStyle = '#000';
                ctx.fillRect(c * cellW, rowY, cellW, cellH);
                ctx.fillStyle = '#fff';
            } else {
                ctx.fillStyle = c === 0 ? '#aaa' : '#000';
            }
            ctx.textAlign = 'center';
            ctx.fillText(String(day), c * cellW + cellW / 2, rowY + fs + 2);
            day++;
        }
        col = 0;
        rowY += cellH;
    }
    return height;
}

function drawBlock_bigtext(ctx, block, y, W) {
    const text = block.text || '';
    if (!text.trim()) return 0;
    const sz      = Math.min(Math.floor(W / Math.max(text.length, 1) * 0.88), 90);
    const fontStr = block.font === 'block'
        ? `bold ${sz}px monospace`
        : `bold ${sz}px Impact, Arial Black, sans-serif`;
    const lines   = [text]; // bigtext is always single line
    const lineH   = sz * 1.38;
    const height  = lineH + 8;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y, W, height);
    ctx.fillStyle = '#000';
    ctx.font      = fontStr;
    ctx.textAlign = block.align;
    const x = block.align === 'left' ? 2 : block.align === 'right' ? W - 2 : W / 2;
    ctx.fillText(text, x, y + sz + 2);

    if (block.font === 'outline') {
        ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
        ctx.strokeText(text, x, y + sz + 2);
    }
    return height;
}

// ── Async draw functions ───────────────────────────────────
// These create a scratch canvas, draw, copy to composite, then
// shrink the scratch to 1x1 immediately to release GPU memory.

/**
 * Safe helper: create a scratch canvas, draw imgEl into it with optional
 * contrast filter, dither it, copy to the composite ctx at offsetY,
 * then release the scratch canvas memory.
 *
 * Prevents IndexSizeError on WebKit by clamping dimensions to minimum 1.
 */
function drawImageToComposite(ctx, imgEl, offsetY, W, drawH, contrastPct, dither, threshold) {
	// Clamp to minimum 1 — WebKit throws on zero-size canvas operations.
	const safeW = Math.max(1, Math.round(W));
	const safeH = Math.max(1, Math.round(drawH));

	const scratch = document.createElement('canvas');
	scratch.width = safeW;
	scratch.height = safeH;
	const sc = scratch.getContext('2d');

	// Apply contrast filter before drawing the source image.
	if (contrastPct !== 0) sc.filter = `contrast(${100 + contrastPct}%)`;
	sc.drawImage(imgEl, 0, 0, safeW, safeH);
	sc.filter = 'none';

	// On some GPU-accelerated browsers (Android Chrome, desktop Chrome with
	// hardware acceleration) sc.drawImage() queues the blit on the GPU command
	// buffer but has not necessarily flushed it to CPU-readable memory by the
	// time getImageData() is called.  The result is getImageData() reads a
	// partially-written buffer — you see the image in colour for the bottom
	// half because those rows hadn't been written yet.
	//
	// Fix: read a single pixel first.  getImageData on a 1x1 region forces the
	// browser to flush the GPU command buffer before returning.  This is a
	// documented workaround for the "GPU readback hazard" in 2D canvas.
	sc.getImageData(0, 0, 1, 1); // force GPU→CPU flush before full read
    
    let imgData = sc.getImageData(0, 0, safeW, safeH);
    imgData = ditherImageData(imgData, dither, threshold);
    sc.putImageData(imgData, 0, 0);

    ctx.drawImage(scratch, 0, offsetY);

	// Shrink to 1×1 immediately to release the GPU texture allocation.
	// Critical on mobile where the canvas limit is ~16 simultaneous textures.
	scratch.width = 1;
	scratch.height = 1;

	return safeH;
}

async function drawBlock_image(ctx, block, y, W) {
    if (!block.src) return 0;
    return new Promise(resolve => {
        const img = new Image();

		const doRender = () => {
			// Guard: naturalWidth must be set before we can compute aspect ratio.
			// On Android WebView, img.complete can be true but naturalWidth still 0
			// for a brief moment — retry once via rAF in that case.
			if (!img.naturalWidth || !img.naturalHeight) {
				resolve(0);
				return;
			}
			const h = Math.max(1, Math.round(W * img.naturalHeight / img.naturalWidth));
			const drawn = drawImageToComposite(ctx, img, y, W, h, block.contrast, block.dither, block.threshold);
			resolve(drawn);
		};

		img.onload = doRender;
        img.onerror = () => resolve(0);
        img.src = block.src;

		// If the browser already has the image decoded (base64
		// data URIs are often synchronously decoded), img.complete is true
		// immediately and onload never fires. Force the render path here.
		if (img.complete && img.naturalWidth) {
			doRender();
		}
    });
}

async function drawBlock_logo(ctx, block, y, W) {
    if (!block.src) return 0;
    return new Promise(resolve => {
        const img = new Image();

		const doRender = () => {
			if (!img.naturalWidth || !img.naturalHeight) {
				resolve(0);
				return;
			}
			const dw = Math.max(1, Math.round(W * block.width / 100));
			const dh = Math.max(1, Math.round(dw * img.naturalHeight / img.naturalWidth));
            const scratch = document.createElement('canvas');
			scratch.width = Math.max(1, W);
			scratch.height = Math.max(1, dh + 8);
            const sc = scratch.getContext('2d');
			sc.fillStyle = '#fff';
			sc.fillRect(0, 0, scratch.width, scratch.height);
            sc.drawImage(img, Math.floor((W - dw) / 2), 4, dw, dh);
			let imgData = sc.getImageData(0, 0, scratch.width, scratch.height);
			imgData = ditherImageData(imgData, 'atkinson', 128);
            sc.putImageData(imgData, 0, 0);
            ctx.drawImage(scratch, 0, y);
			const h = scratch.height;
			scratch.width = 1;
			scratch.height = 1;
			resolve(h);
        };

		img.onload = doRender;
        img.onerror = () => resolve(0);
        img.src = block.src;

		// Same as drawBlock_image — handle already-decoded data URIs.
		if (img.complete && img.naturalWidth) {
			doRender();
		}
    });
}

async function drawBlock_drawing(ctx, block, y, W) {
    if (!block.dataUrl) return 0;
    return new Promise(resolve => {
        const img = new Image();

		const doRender = () => {
			if (!img.naturalWidth || !img.naturalHeight) {
				resolve(0);
				return;
			}
			const h = Math.max(1, Math.round(img.naturalHeight * (W / img.naturalWidth)));
			const drawn = drawImageToComposite(ctx, img, y, W, h, 0, 'threshold', 200);
			resolve(drawn);
		};

		img.onload = doRender;
        img.onerror = () => resolve(0);
        img.src = block.dataUrl;

		// ANDROID FIX: drawing canvas data-URLs are often already decoded.
		if (img.complete && img.naturalWidth) {
			doRender();
		}
    });
}

/**
 * Render a QR code using the qrcodejs library.
 *
 * WebKit fix: the library can return either an <img> (Safari) or a <canvas>
 * (Chrome/Firefox). We handle both. We also clamp the output size to at least
 * 1px and copy via drawImage rather than getImageData to avoid zero-size errors.
 */
async function drawBlock_qr(ctx, block, y, W) {
    return new Promise(resolve => {
        const scratch = document.getElementById('qr-scratch');
        scratch.innerHTML = '';
        try {
            new QRCode(scratch, {
				text: block.content || ' ',
				width: 256,
				height: 256,
				colorDark: '#000',
				colorLight: '#fff',
                correctLevel: QRCode.CorrectLevel.M,
            });
			// ANDROID FIX: poll every 50ms up to 20 attempts (1 s total).
			// 150ms was too short for slow Android WebViews; polling avoids
			// an arbitrary fixed delay while still being fast on quick devices.
			let _qrAttempts = 0;
			const _qrDraw = () => {
				_qrAttempts++;
				const el = scratch.querySelector('canvas') || scratch.querySelector('img');
				if (!el) {
					if (_qrAttempts < 20) {
						setTimeout(_qrDraw, 50);
						return;
					}
					scratch.innerHTML = '';
					resolve(0);
					return;
				}

				// For <img> elements on Android WebView, the src may not be
				// decoded yet even after the element exists in DOM. Wait for
				// the image to report a non-zero naturalWidth before drawing.
				if (el.tagName === 'IMG' && !el.complete) {
					if (_qrAttempts < 20) {
						setTimeout(_qrDraw, 50);
						return;
					}
					scratch.innerHTML = '';
					resolve(0);
					return;
				}

				const margin = Math.max(0, block.margin || 10);
				const qrSize = Math.max(1, Math.min(W - margin * 2, 290));
                    const labelH = block.label ? 22 : 0;
				const height = Math.max(1, margin + qrSize + Math.ceil(margin / 2) + labelH);

                    ctx.fillStyle = '#fff';
                    ctx.fillRect(0, y, W, height);
                    ctx.imageSmoothingEnabled = false;
				ctx.drawImage(el, Math.floor((W - qrSize) / 2), y + margin, qrSize, qrSize);
				ctx.imageSmoothingEnabled = true;

                    if (block.label) {
                        ctx.fillStyle = '#000';
					ctx.font = 'bold 14px monospace';
                        ctx.textAlign = 'center';
                        ctx.fillText(block.label, W / 2, y + margin + qrSize + 18);
                    }

                    scratch.innerHTML = '';
                    resolve(height);
                };
			setTimeout(_qrDraw, 50);
        } catch (_) {
            scratch.innerHTML = '';
            resolve(0);
        }
    });
}

async function drawBlock_wifi(ctx, block, y, W) {
	const sec = block.security || 'WPA';
	const wifiStr = `WIFI:T:${sec==='nopass'?'nopass':sec};S:${block.ssid};P:${block.password};H:${block.hidden?'true':'false'};;`;
	return drawBlock_qr(ctx, {
		content: wifiStr,
		margin: 10,
		label: block.ssid
	}, y, W);
}

// ============================================================
//  SECTION 9 — ASCII ART ENGINE
//  5×7 pixel bitmap font drawn directly to canvas ImageData.
// ============================================================

/**
 * 5×7 pixel bitmap font.
 * Each character is an array of 7 rows, each row an array of 5 bits.
 * Bit 1 = foreground pixel, 0 = background.
 */
const ASCII_FONT_5X7 = {
    ' ':[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],
    'A':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1]],
    'B':[[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0]],
    'C':[[0,1,1,1,1],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[0,1,1,1,1]],
    'D':[[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0]],
    'E':[[1,1,1,1,1],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,1]],
    'F':[[1,1,1,1,1],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0]],
    'G':[[0,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,1,1,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    'H':[[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1]],
    'I':[[1,1,1,1,1],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[1,1,1,1,1]],
    'J':[[0,0,0,1,1],[0,0,0,0,1],[0,0,0,0,1],[0,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    'K':[[1,0,0,0,1],[1,0,0,1,0],[1,0,1,0,0],[1,1,0,0,0],[1,0,1,0,0],[1,0,0,1,0],[1,0,0,0,1]],
    'L':[[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,1]],
    'M':[[1,0,0,0,1],[1,1,0,1,1],[1,0,1,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1]],
    'N':[[1,0,0,0,1],[1,1,0,0,1],[1,0,1,0,1],[1,0,0,1,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1]],
    'O':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    'P':[[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0]],
    'Q':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,1,0,1],[1,0,0,1,0],[0,1,1,0,1]],
    'R':[[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0],[1,0,1,0,0],[1,0,0,1,0],[1,0,0,0,1]],
    'S':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,0],[0,1,1,1,0],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    'T':[[1,1,1,1,1],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]],
    'U':[[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    'V':[[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,0,1,0],[0,1,0,1,0],[0,1,0,1,0],[0,0,1,0,0]],
    'W':[[1,0,0,0,1],[1,0,0,0,1],[1,0,1,0,1],[1,0,1,0,1],[1,0,1,0,1],[1,1,0,1,1],[1,0,0,0,1]],
    'X':[[1,0,0,0,1],[0,1,0,1,0],[0,1,0,1,0],[0,0,1,0,0],[0,1,0,1,0],[0,1,0,1,0],[1,0,0,0,1]],
    'Y':[[1,0,0,0,1],[1,0,0,0,1],[0,1,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]],
    'Z':[[1,1,1,1,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,0,0,0,0],[1,1,1,1,1]],
    '0':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,1,1],[1,0,1,0,1],[1,1,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    '1':[[0,0,1,0,0],[0,1,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[1,1,1,1,1]],
    '2':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]],
    '3':[[1,1,1,1,0],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,1,0],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    '4':[[0,0,0,1,0],[0,0,1,1,0],[0,1,0,1,0],[1,0,0,1,0],[1,1,1,1,1],[0,0,0,1,0],[0,0,0,1,0]],
    '5':[[1,1,1,1,1],[1,0,0,0,0],[1,1,1,1,0],[0,0,0,0,1],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    '6':[[0,0,1,1,0],[0,1,0,0,0],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    '7':[[1,1,1,1,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[0,1,0,0,0],[0,1,0,0,0]],
    '8':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
    '9':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,1],[0,0,0,0,1],[0,0,0,1,0],[0,1,1,0,0]],
    '!':[[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,1,0,0]],
    '?':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,0,0,0,0],[0,0,1,0,0]],
    '.':[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,1,0,0]],
    ',':[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,1,0,0,0]],
    '-':[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[1,1,1,1,1],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],
    '+':[[0,0,0,0,0],[0,0,1,0,0],[0,0,1,0,0],[1,1,1,1,1],[0,0,1,0,0],[0,0,1,0,0],[0,0,0,0,0]],
    '*':[[0,0,0,0,0],[1,0,1,0,1],[0,1,1,1,0],[1,1,1,1,1],[0,1,1,1,0],[1,0,1,0,1],[0,0,0,0,0]],
    '/':[[0,0,0,0,1],[0,0,0,1,0],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[0,1,0,0,0],[1,0,0,0,0]],
    ':':[[0,0,0,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,0,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,0,0,0]],
    '#':[[0,1,0,1,0],[0,1,0,1,0],[1,1,1,1,1],[0,1,0,1,0],[1,1,1,1,1],[0,1,0,1,0],[0,1,0,1,0]],
    '@':[[0,1,1,1,0],[1,0,0,0,1],[1,0,1,1,1],[1,0,1,0,1],[1,0,1,1,0],[1,0,0,0,0],[0,1,1,1,0]],
    '(':[[0,0,1,0,0],[0,1,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[0,1,0,0,0],[0,0,1,0,0]],
    ')':[[0,0,1,0,0],[0,0,0,1,0],[0,0,0,0,1],[0,0,0,0,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0]],
    '_':[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[1,1,1,1,1]],
    '=':[[0,0,0,0,0],[0,0,0,0,0],[1,1,1,1,1],[0,0,0,0,0],[1,1,1,1,1],[0,0,0,0,0],[0,0,0,0,0]],
    '<':[[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[0,0,1,0,0],[0,0,0,1,0],[0,0,0,0,1]],
    '>':[[1,0,0,0,0],[0,1,0,0,0],[0,0,1,0,0],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,0,0,0,0]],
};

/**
 * Render ASCII art bitmap text directly onto the composite canvas.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} block   - asciiart block data
 * @param {number} y       - Y offset in the composite canvas
 * @param {number} W       - print width
 * @returns {number}       - height drawn
 */
function drawBlock_asciiart(ctx, block, y, W) {
    const px   = Math.max(1, block.scale * 2);   // output pixels per font pixel
    const charW = 5 * px + px;                    // character width including 1-col gap
    const charH = 7 * px + px;                    // character height including 1-row gap
    const pad   = px * 2;

    const lines  = block.text.toUpperCase().split('\n').filter(l => l.length > 0);
    const height = lines.length * charH + pad * 2;

    // We need pixel-level access, so draw into a temporary ImageData for this block
    // then copy the result to the composite canvas. This is ONE small scratch buffer,
    // not a full canvas per block.
    const imgData = ctx.createImageData(W, height);
    const d       = imgData.data;
    const fg      = block.invert ? 255 : 0;
    const bg      = block.invert ? 0   : 255;

    // Fill background
    for (let i = 0; i < W * height; i++) {
        d[i * 4]     = bg;
        d[i * 4 + 1] = bg;
        d[i * 4 + 2] = bg;
        d[i * 4 + 3] = 255;
    }

    function setPixel(px2, py2, value) {
        if (px2 < 0 || px2 >= W || py2 < 0 || py2 >= height) return;
        const idx    = (py2 * W + px2) * 4;
        d[idx]       = value;
        d[idx + 1]   = value;
        d[idx + 2]   = value;
        d[idx + 3]   = 255;
    }

    lines.forEach((line, lineIndex) => {
        const linePixelW = line.length * charW;
        const originX    = Math.floor((W - linePixelW) / 2);
        const originY    = pad + lineIndex * charH;

        for (let charIdx = 0; charIdx < line.length; charIdx++) {
            const glyph  = ASCII_FONT_5X7[line[charIdx]] || ASCII_FONT_5X7[' '];
            const charOX = originX + charIdx * charW;

            for (let gy = 0; gy < 7; gy++) {
                for (let gx = 0; gx < 5; gx++) {
                    if (!glyph[gy][gx]) continue;

                    // Shadow: draw dim offset pixel first
                    if (block.font === 'shadow') {
                        for (let sy = 0; sy < px; sy++) {
                            for (let sx = 0; sx < px; sx++) {
                                setPixel(charOX + gx * px + sx + 1, originY + gy * px + sy + 1,
                                         block.invert ? 200 : 80);
                            }
                        }
                    }

                    // Foreground pixels
                    for (let py2 = 0; py2 < px; py2++) {
                        for (let px2 = 0; px2 < px; px2++) {
                            // Dots: round pixels
                            if (block.font === 'dots') {
                                const cx = px2 - px / 2 + 0.5;
                                const cy = py2 - px / 2 + 0.5;
                                if (cx * cx + cy * cy > (px / 2) * (px / 2)) continue;
                            }
                            // Outline: only edge pixels of each glyph bitmap cell
                            if (block.font === 'outline') {
                                const edgeX = gx === 0 || gx === 4;
                                const edgeY = gy === 0 || gy === 6;
                                if (!edgeX && !edgeY) continue;
                            }
                            // Thin: only top-left pixel of each scaled pixel
                            if (block.font === 'thin') {
                                if (px2 !== 0 && py2 !== 0) continue;
                            }
                            setPixel(charOX + gx * px + px2, originY + gy * px + py2, fg);
                        }
                    }
                }
            }
        }
    });

    ctx.putImageData(imgData, 0, y);
    return height;
}

// ── Code128 barcode generator ──────────────────────────────────────

/**
 * Build a bar pattern for a Code128-B encoded string.
 * Returns an array of { w: moduleWidth, black: boolean } objects.
 */
function buildCode128Bars(text) {
    const CODE128_PATTERNS = [
        [2,1,2,2,2,2],[2,2,2,1,2,2],[2,2,2,2,2,1],[1,2,1,2,2,3],[1,2,1,3,2,2],[1,3,1,2,2,2],
        [1,2,2,2,1,3],[1,2,2,3,1,2],[1,3,2,2,1,2],[2,2,1,2,1,3],[2,2,1,3,1,2],[2,3,1,2,1,2],
        [1,1,2,2,3,2],[1,2,2,1,3,2],[1,2,2,2,3,1],[1,1,3,2,2,2],[1,2,3,1,2,2],[1,2,3,2,2,1],
        [2,2,3,2,1,1],[2,2,1,1,3,2],[2,2,1,2,3,1],[2,1,3,2,1,2],[2,2,3,1,1,2],[3,1,2,1,3,1],
        [3,1,1,2,2,2],[3,2,1,1,2,2],[3,2,1,2,2,1],[3,1,2,2,1,2],[3,2,2,1,1,2],[3,2,2,2,1,1],
        [2,1,2,1,2,3],[2,1,2,3,2,1],[2,3,2,1,2,1],[1,1,1,3,2,3],[1,3,1,1,2,3],[1,3,1,3,2,1],
        [1,1,2,3,1,3],[1,3,2,1,1,3],[1,3,2,3,1,1],[2,1,1,3,1,3],[2,3,1,1,1,3],[2,3,1,3,1,1],
        [1,1,3,1,2,3],[1,1,3,3,2,1],[1,3,3,1,2,1],[1,1,2,1,3,3],[1,1,2,3,3,1],[1,3,2,1,3,1],
        [1,1,3,2,1,3],[1,1,3,2,3,1],[2,1,3,2,3,1],[1,3,1,2,3,1],[3,1,1,1,2,3],[3,1,1,3,2,1],
        [3,3,1,1,2,1],[3,1,2,1,1,3],[3,1,2,3,1,1],[3,3,2,1,1,1],[3,1,4,1,1,1],[2,2,1,4,1,1],
        [4,3,1,1,1,1],[1,1,1,2,2,4],[1,1,1,4,2,2],[1,2,1,1,2,4],[1,2,1,4,2,1],[1,4,1,1,2,2],
        [1,4,1,2,2,1],[1,1,2,2,1,4],[1,1,2,4,1,2],[1,2,2,1,1,4],[1,2,2,4,1,1],[1,4,2,1,1,2],
        [1,4,2,2,1,1],[2,4,1,2,1,1],[2,2,1,1,1,4],[4,1,3,1,1,1],[2,4,1,1,1,2],[1,3,4,1,1,1],
        [1,1,1,2,4,2],[1,2,1,1,4,2],[1,2,1,2,4,1],[1,1,4,2,1,2],[1,2,4,1,1,2],[1,2,4,2,1,1],
        [4,1,1,2,1,2],[4,2,1,1,1,2],[4,2,1,2,1,1],[2,1,2,1,4,1],[2,1,4,1,2,1],[4,1,2,1,2,1],
        [1,1,1,1,4,3],[1,1,1,3,4,1],[1,3,1,1,4,1],[1,1,4,1,1,3],[1,1,4,3,1,1],[4,1,1,1,1,3],
        [4,1,1,3,1,1],[1,1,3,1,4,1],[1,1,4,1,3,1],[3,1,1,1,4,1],[4,1,1,1,3,1],[2,1,1,4,1,2],
        [2,1,1,2,1,4],[2,1,1,2,3,2],[2,3,3,1,1,1,2]
    ];

    const START_CODE_B = 104;
    const STOP_CODE    = 106;

    const valueArray = [START_CODE_B];
    let checksum = START_CODE_B;
    for (let i = 0; i < text.length; i++) {
        const v = text.charCodeAt(i) - 32;
        valueArray.push(v);
        checksum += (i + 1) * v;
    }
    valueArray.push(checksum % 103);
    valueArray.push(STOP_CODE);

    const bars = [];
    for (const value of valueArray) {
        const pattern = CODE128_PATTERNS[value];
        if (!pattern) continue;
        for (let i = 0; i < pattern.length; i++) {
            bars.push({ w: pattern[i], black: i % 2 === 0 });
        }
    }
    bars.push({ w: 2, black: false }); // terminating quiet zone
    return bars;
}


// ============================================================
//  SECTION 10 — COMPOSE (single-canvas pipeline)
// ============================================================

/**
 * Compute the height of a block without drawing it.
 * Used in the two-pass approach: first measure, then resize canvas, then draw.
 *
 * Async blocks (image, qr, wifi, logo, drawing) cannot be pre-measured without
 * loading assets, so they return null (handled by drawing them incrementally
 * and growing the canvas as needed).
 *
 * Sync blocks return a numeric height estimate.
 */
function estimateBlockHeight(block, W) {
    switch (block.type) {
        case 'text':
        case 'inverted': {
			const lines = wrapText(block.text, `${block.bold} ${block.size}px ${block.font}`, W - 4);
            return Math.max(lines.length * block.size * 1.38 + 6, block.size + 6);
        }
		case 'separator':
			return block.padding * 2 + block.thickness + 2;
		case 'spacer':
			return block.height;
		case 'datetime':
			return Math.max(block.size * 1.38 + 6, block.size + 6);
		case 'countdown':
			return block.size * 1.5 + 30;
		case 'ruler':
			return 40;
		case 'table':
			return block.rows.length * ((block.fontSize || 14) * 1.6) + 4;
		case 'checklist':
			return block.items.length * 15 * 1.7 + 8;
		case 'barcode':
			return block.height + (block.showText ? 16 : 0) + 8;
		case 'progress':
			return 13 + 8 + 20 + 8;
		case 'badge':
			return block.size1 + block.size2 + block.size3 + 56;
		case 'grid':
			return block.rows * block.cellW + (block.label ? 16 : 0) + 8;
        case 'receipt': {
			const lH = 13 * 1.55;
			return 8 * 2 + 17 + 8 + (3 + block.items.length + (block.tax > 0 ? 1 : 0)) * lH + 8;
        }
        case 'note': {
			const lines = wrapText(block.text, `${block.size||14}px monospace`, W - 36);
			return 12 * 2 + 2 * 2 + lines.length * (block.size || 14) * 1.4 + 8;
        }
        case 'asciiart': {
			const px = Math.max(1, block.scale * 2);
			return block.text.split('\n').filter(l => l).length * (7 * px + px) + px * 4;
        }
        case 'bigtext': {
			const sz = Math.min(Math.floor(W / Math.max(block.text.length, 1) * 0.88), 90);
            return sz * 1.38 + 8;
        }
		case 'tags':
			return Math.ceil(block.items.length / 4) * (12 + 10 + 6) + 12;
        case 'calendar': {
			const m = (block.month && block.month > 0) ? block.month - 1 : new Date().getMonth();
			const y2 = (block.year && block.year > 0) ? block.year : new Date().getFullYear();
			const totalRows = Math.ceil((new Date(y2, m, 1).getDay() + new Date(y2, m + 1, 0).getDate()) / 7);
            return 4 + 15 + 18 + totalRows * 18 + 4;
        }
		// Async — unknown until asset is loaded
        case 'image':
        case 'logo':
        case 'drawing':
        case 'qr':
		case 'wifi':
			return null;
		default:
			return 0;
    }
}

/**
 * Dispatch one block to its draw function, returning a Promise<number> with
 * the pixel height drawn.
 *  Using `await` directly inside `switch/case` inside an `async` function
 * causes V8's TurboFan compiler on Android to deoptimise the switch and
 * execute case bodies synchronously, returning a pending Promise object
 * instead of a resolved number. The `(drawn || 0)` guard then always
 * evaluates to 0 because a Promise is truthy but NaN-as-number.
 *
 * Fix: each branch uses `return Promise.resolve(syncResult)` for sync
 * blocks and `return asyncFn(...)` for async ones, so the single top-level
 * `await renderOneBlock(...)` in composeAll always receives a plain number.
 */
async function renderOneBlock(ctx, block, y, W) {
	switch (block.type) {
		// ── Sync blocks — wrap in Promise.resolve so caller awaits a number ──
		case 'text':
			return Promise.resolve(drawBlock_text(ctx, block, y, W, false));
		case 'inverted':
			return Promise.resolve(drawBlock_text(ctx, block, y, W, true));
		case 'separator':
			return Promise.resolve(drawBlock_separator(ctx, block, y, W));
		case 'spacer':
			return Promise.resolve(drawBlock_spacer(ctx, block, y, W));
		case 'datetime':
			return Promise.resolve(drawBlock_datetime(ctx, block, y, W));
		case 'countdown':
			return Promise.resolve(drawBlock_countdown(ctx, block, y, W));
		case 'ruler':
			return Promise.resolve(drawBlock_ruler(ctx, block, y, W));
		case 'table':
			return Promise.resolve(drawBlock_table(ctx, block, y, W));
		case 'checklist':
			return Promise.resolve(drawBlock_checklist(ctx, block, y, W));
		case 'barcode':
			return Promise.resolve(drawBlock_barcode(ctx, block, y, W));
		case 'progress':
			return Promise.resolve(drawBlock_progress(ctx, block, y, W));
		case 'badge':
			return Promise.resolve(drawBlock_badge(ctx, block, y, W));
		case 'grid':
			return Promise.resolve(drawBlock_grid(ctx, block, y, W));
		case 'tags':
			return Promise.resolve(drawBlock_tags(ctx, block, y, W));
		case 'note':
			return Promise.resolve(drawBlock_note(ctx, block, y, W));
		case 'receipt':
			return Promise.resolve(drawBlock_receipt(ctx, block, y, W));
		case 'calendar':
			return Promise.resolve(drawBlock_calendar(ctx, block, y, W));
		case 'asciiart':
			return Promise.resolve(drawBlock_asciiart(ctx, block, y, W));
		case 'bigtext':
			return Promise.resolve(drawBlock_bigtext(ctx, block, y, W));
	    // ── Async blocks — already return Promise<number> ─────────────────
		case 'image':
			return drawBlock_image(ctx, block, y, W);
		case 'logo':
			return drawBlock_logo(ctx, block, y, W);
		case 'drawing':
			return drawBlock_drawing(ctx, block, y, W);
		case 'qr':
			return drawBlock_qr(ctx, block, y, W);
		case 'wifi':
			return drawBlock_wifi(ctx, block, y, W);
		default:
			return Promise.resolve(0);
	}
}

/**
 * Render all blocks onto _compositeCanvas and return it.
 *
 * Strategy (two-pass, corruption-free):
 *
 *   Pass 1 — draw every block onto an OVERSIZED scratch canvas whose height
 *             is a safe upper bound.  We never clip during drawing because the
 *             canvas is always taller than the content.  Each block reports the
 *             exact pixel height it consumed, so `y` is the true content height
 *             when the loop ends.
 *
 *   Pass 2 — create a FRESH canvas at the exact final height and copy the
 *             scratch into it via drawImage (GPU blit, no pixel readback).
 *             This avoids the getImageData → resize → putImageData pattern
 *             which corrupts data when the canvas is already clipped or when
 *             the ImageData spans a different height than the destination.
 */
async function composeAll() {
    const W = getPrintWidth();

	// ── Empty state ───────────────────────────────────────────────────────────
	if (!blocks.length) {
	    _compositeCanvas.width = Math.max(1, W);
		_compositeCanvas.height = 80;
        _compositeCtx.fillStyle = '#fff';
		_compositeCtx.fillRect(0, 0, W, 80);
        _compositeCtx.fillStyle = '#ccc';
		_compositeCtx.font = '12px monospace';
        _compositeCtx.textAlign = 'center';
		_compositeCtx.fillText('Empty \u2014 add blocks from the palette', W / 2, 44);
        return _compositeCanvas;
    }

	// ── Pass 1: draw on an oversized scratch canvas ───────────────────────────
	//
	// Upper bound for height: each block is at most MAX_BLOCK_H pixels tall.
	// We pick a generous constant so that no async block (image, QR) can ever
	// draw beyond the canvas edge and get silently clipped.
	// 4000 px covers a full-page A4 equivalent at 384 px wide.
	// If there are many blocks we scale up proportionally.
	const MAX_BLOCK_H = 600; // max realistic height of any single block
	const oversizedH = Math.max(400, blocks.length * MAX_BLOCK_H);

	// Reuse _compositeCanvas as the scratch.  Set it once to the oversize
	// height so drawImage never clips.
	_compositeCanvas.width = Math.max(1, W);
	_compositeCanvas.height = Math.max(1, oversizedH);
	_compositeCtx.fillStyle = '#fff';
	_compositeCtx.fillRect(0, 0, W, oversizedH);

	let y = 0;
    for (const block of blocks) {
        _compositeCtx.save();

		// renderOneBlock wraps every branch in an explicit Promise so
		// `await` always resolves to a plain number — not a pending Promise.
		// (See the comment on renderOneBlock for the Android V8 JIT fix.)
		const drawn = await renderOneBlock(_compositeCtx, block, y, W);

        _compositeCtx.restore();
		y += (typeof drawn === 'number' && drawn > 0) ? drawn : 0;
    }

	// ── Pass 2: copy to a fresh canvas at the exact content height ────────────
	//
	// We create a NEW offscreen canvas at the true height and use drawImage
	// to blit from the oversized scratch.  The scratch is then repurposed
	// as the final composite (swap references).
	//
	// This is safe because:
	//   a) The scratch was NEVER resized after drawing — all pixels are intact.
	//   b) drawImage clips to the destination rect, so we get exactly `y` rows.
	//   c) No getImageData/putImageData → no readback corruption.
	const finalH = Math.max(1, Math.ceil(y));
	const finalCanvas = document.createElement('canvas');
	finalCanvas.width = Math.max(1, W);
	finalCanvas.height = finalH;
	const finalCtx = finalCanvas.getContext('2d');
	finalCtx.drawImage(_compositeCanvas, 0, 0); // blit top `finalH` rows

	// Replace the scratch with the correctly-sized canvas.
	// We reassign the module-level references so all subsequent callers
	// (refreshPreview, canvasToBitmapLines, simStartFeed) see the right canvas.
	_compositeCanvas.width = Math.max(1, W);
	_compositeCanvas.height = finalH;
	_compositeCtx.drawImage(finalCanvas, 0, 0);

	// Release the temporary canvas memory immediately.
	finalCanvas.width = 1;
	finalCanvas.height = 1;

    return _compositeCanvas;
}

let previewTimer = null;

/** Schedule a preview refresh, debounced by 350ms. */
function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 350);
}

/**
 * Render all blocks and copy the result to the visible preview canvas.
 * The preview canvas is resized to match the composite exactly.
 */
async function refreshPreview() {
    await composeAll();

    const previewCanvas = document.getElementById('preview-canvas');
    previewCanvas.width  = _compositeCanvas.width;
    previewCanvas.height = _compositeCanvas.height;
    previewCanvas.getContext('2d', { willReadFrequently: true }).drawImage(_compositeCanvas, 0, 0);
}


// ============================================================
//  SECTION 11 — PRINT & SIMULATION
// ============================================================

/**
 * Convert the composite canvas to an array of 1-bit bitmap rows.
 * Each row is a Uint8Array of ceil(width/8) bytes.
 * A pixel is black (printed) when its luminance is below 128.
 */
function canvasToBitmapLines(canvas) {
    const ctx         = canvas.getContext('2d', { willReadFrequently: true });
    const W           = canvas.width;
    const H           = canvas.height;
    const imageData   = ctx.getImageData(0, 0, W, H);
    const bytesPerRow = Math.ceil(W / 8);
    const lines       = [];

    for (let rowY = 0; rowY < H; rowY++) {
        const row = new Uint8Array(bytesPerRow);
        for (let x = 0; x < W; x++) {
            const base  = (rowY * W + x) * 4;
            const luma  = 0.299 * imageData.data[base]
                        + 0.587 * imageData.data[base + 1]
                        + 0.114 * imageData.data[base + 2];
            if (luma < 128) {
                row[Math.floor(x / 8)] |= (0x80 >> (x % 8));
            }
        }
        lines.push(row);
    }
    return lines;
}

// ── Simulation ─────────────────────────────────────────────────────

let simulationRaf = null; // requestAnimationFrame handle for the paper feed animation

function simSetProgress(fraction) {
    const pct = Math.round(fraction * 100);
    document.getElementById('sim-prog-fill').style.width  = pct + '%';
    document.getElementById('sim-prog-pct').textContent   = pct + '%';
}

/**
 * Start the paper-feed animation in the simulation overlay.
 *
 * Physics:
 *   - Paper strip is anchored bottom:0 of the viewing window.
 *   - Starts translateY(100%) — fully hidden below (inside the printer body).
 *   - Animates to translateY(0%) — fully emerged above the roller.
 *   - The canvas is pre-drawn so the image scrolls into view from the top,
 *     mirroring real thermal printer output direction.
 */
function simStartFeed(composedCanvas, totalLines, durationMs) {
    const SIM_W = 200;
    const SIM_H = Math.round(totalLines * (SIM_W / getPrintWidth()));

    // Draw the full output onto the simulation canvas (scaled down)
    const simCanvas  = document.getElementById('sim-canvas');
    simCanvas.width  = SIM_W;
    simCanvas.height = SIM_H;
    const simCtx = simCanvas.getContext('2d');
    simCtx.fillStyle = '#fff';
    simCtx.fillRect(0, 0, SIM_W, SIM_H);
    simCtx.drawImage(composedCanvas, 0, 0, SIM_W, SIM_H);

    // Reset strip position: fully hidden below the viewing window
    const strip = document.getElementById('sim-paper-strip');
    strip.classList.remove('feed-out');
    strip.style.transform = 'translateX(-50%) translateY(100%)';

    const startTime = performance.now();

    function tick(now) {
        const elapsed  = now - startTime;
        const fraction = Math.min(elapsed / durationMs, 1);
        // Linear feed: translateY 100% → 0% (paper rises into view)
        const ty = 100 - fraction * 100;
        strip.style.transform = `translateX(-50%) translateY(${ty}%)`;
        if (fraction < 1) {
            simulationRaf = requestAnimationFrame(tick);
        }
    }
    simulationRaf = requestAnimationFrame(tick);
}

function simStopFeed() {
    if (simulationRaf) {
        cancelAnimationFrame(simulationRaf);
        simulationRaf = null;
    }
    document.getElementById('sim-roller').classList.remove('spinning');
    document.getElementById('sim-led').className = 'sim-led done';
}

/** Trigger the feed-out animation (paper exits upward). */
function simFeedOut() {
    const strip = document.getElementById('sim-paper-strip');
    // Read current Y position so the animation starts smoothly from where it stopped
    const match  = strip.style.transform.match(/translateY\(([^)]+)\)/);
    const currentY = match ? match[1] : '0%';
    strip.style.setProperty('--strip-y', currentY);
    strip.classList.add('feed-out');
}

/** Close the simulation overlay and reset its state. */
function closeSim() {
    if (simulationRaf) {
        cancelAnimationFrame(simulationRaf);
        simulationRaf = null;
    }
    document.getElementById('sim-overlay').classList.remove('on');
    document.getElementById('sim-roller').classList.remove('spinning');
    document.getElementById('sim-led').className = 'sim-led';
    toast('Simulation complete ✓', 'ok');
}

/**
 * Print all blocks.
 *
 * If mode is Dry Run: renders to the simulation overlay with animated paper feed.
 * If mode is Real Print: sends bitmap data to the connected Bluetooth printer.
 */
async function printAll() {
    if (!blocks.length) {
        toast('Add at least one block first', 'err');
        return;
    }

    const isDryRun = document.getElementById('p-dryrun').value === '1';

    if (!printer && !isDryRun) {
        toast('⚠ Connect a printer first, or enable Dry Run in settings', 'err');
        return;
    }

    // Compose the final output
    const composed   = await composeAll();
    const bitmapRows = canvasToBitmapLines(composed);
    const totalRows  = bitmapRows.length;
    const speed      = parseInt(document.getElementById('p-speed').value);
    const energy     = parseInt(document.getElementById('p-energy').value);
    const feedPts    = parseInt(document.getElementById('p-feed').value);

    // Use connected printer or a dummy dry-run instance
    let activePrinter = printer;
    if (!activePrinter || isDryRun) {
        activePrinter = new CatPrinter('GB03', async () => {}, true);
    }
    activePrinter.dry       = isDryRun;
    activePrinter.bytesSent = 0;

    setProg(0, 'Preparing…');
    showProg(true);

    // ── Set up simulation UI ─────────────────────────────────────────
    if (isDryRun) {
        const strip = document.getElementById('sim-paper-strip');
        strip.classList.remove('feed-out');
        strip.style.transform = 'translateX(-50%) translateY(100%)';
        strip.style.removeProperty('--strip-y');

        document.getElementById('sim-stats').textContent    = '';
        document.getElementById('sim-prog-fill').style.width = '0%';
        document.getElementById('sim-prog-pct').textContent  = '0%';

        const closeBtn      = document.getElementById('sim-close-btn');
        closeBtn.disabled   = true;
        closeBtn.textContent = 'Printing…';

        document.getElementById('sim-led').className = 'sim-led active';
        document.getElementById('sim-overlay').classList.add('on');

        // Calculate feed animation duration based on print speed setting.
        // Speed 1 (dense/slow) → ~34 lines/sec; Speed 8 (light/fast) → ~132 lines/sec.
        const linesPerSecond    = 20 + speed * 14;
        const rawDurationMs     = (totalRows / linesPerSecond) * 1000;
        const feedDurationMs    = Math.min(Math.max(rawDurationMs, 800), 8000);

        simStartFeed(composed, totalRows, feedDurationMs);
        document.getElementById('sim-roller').classList.add('spinning');
    }

    // ── Send print data ──────────────────────────────────────────────
    try {
        await activePrinter.prepare(speed, energy);

        for (let rowIndex = 0; rowIndex < totalRows; rowIndex++) {
            await activePrinter.drawLine(bitmapRows[rowIndex]);

            // Update progress every 8 rows to avoid excessive DOM operations
            if (rowIndex % 8 === 0) {
                const fraction = rowIndex / totalRows;
                setProg(fraction, `Line ${rowIndex} / ${totalRows}`);
                if (isDryRun) simSetProgress(fraction);
            }
        }

        await activePrinter.finish(feedPts);

        setProg(1, 'Done! ✓');
        setTimeout(() => showProg(false), 3000);

        if (isDryRun) {
            simSetProgress(1);
            simStopFeed();
            // Short pause before the feed-out animation
            setTimeout(() => {
                simFeedOut();
                document.getElementById('sim-stats').textContent =
                    `${totalRows} lines · ${activePrinter.bytesSent.toLocaleString()} bytes · E:${energy} S:${speed}`;
                const closeBtn       = document.getElementById('sim-close-btn');
                closeBtn.disabled    = false;
                closeBtn.textContent = 'Close';
            }, 400);
        } else {
            toast('Print complete ✓', 'ok');
        }

    } catch (err) {
        simStopFeed();
        showProg(false);
        if (isDryRun) {
            document.getElementById('sim-overlay').classList.remove('on');
        }
        toast('Error: ' + err.message, 'err');
    }
}

function showProg(visible) {
    document.getElementById('prog-bar').classList.toggle('on', visible);
}

function setProg(fraction, text) {
    document.getElementById('prog-fill').style.width   = (fraction * 100) + '%';
    document.getElementById('prog-txt').textContent    = text;
}


// ============================================================
//  SECTION 12 — UI HELPERS
// ============================================================

function openDrawer() {
    document.getElementById('drawer-bg').classList.add('on');
}

function closeDrawer() {
    document.getElementById('drawer-bg').classList.remove('on');
}

function downloadPreview() {
    const canvas = document.getElementById('preview-canvas');
    const link   = document.createElement('a');
    link.href     = canvas.toDataURL('image/png');
    link.download = 'meow-print.png';
    link.click();
}

function toggleTheme() {
    const html  = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    document.getElementById('theme-btn').textContent = isDark ? '🌙' : '☀';
}

/** Switch between the Blocks and Preview tabs on mobile. */
function showMobileTab(tab, buttonEl) {
    document.querySelectorAll('.mobile-tabs button').forEach(btn => btn.classList.remove('on'));
    buttonEl.classList.add('on');

    const composer   = document.getElementById('composer');
    const previewCol = document.getElementById('preview-col');

    if (tab === 'blocks') {
        composer.classList.add('mob-visible');
        previewCol.classList.remove('mob-visible');
    } else {
        composer.classList.remove('mob-visible');
        previewCol.classList.add('mob-visible');
        refreshPreview();
    }
}

let toastTimer = null;

function toast(message, type = '') {
    const el      = document.getElementById('toast');
    el.textContent = message;
    el.className   = 'on' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 3400);
}


// ============================================================
//  SECTION 13 — INITIALISATION
// ============================================================

renderBlockList();
refreshPreview();
// Set initial theme icon
document.getElementById('theme-btn').textContent = '☀';