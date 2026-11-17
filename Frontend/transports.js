// Browser CAN transports. Each transport calls onFrame({id, extended, rtr, dlc, data})
// and onStatus(text, level) and exposes async open()/close().

// ---------------------------------------------------------------------------
// SLCAN (Lawicel) over Web Serial: CANable, USBtin, CANUSB and compatible.
// ---------------------------------------------------------------------------
const SLCAN_BITRATE_CODES = {
    10000: "S0", 20000: "S1", 50000: "S2", 100000: "S3", 125000: "S4",
    250000: "S5", 500000: "S6", 800000: "S7", 1000000: "S8"
};

export class SlcanTransport {
    constructor({ bitrate, listenOnly, onFrame, onStatus }) {
        this.bitrate = bitrate;
        this.listenOnly = listenOnly;
        this.onFrame = onFrame;
        this.onStatus = onStatus;
        this.port = null;
        this.reader = null;
        this.running = false;
    }

    static isSupported() {
        return "serial" in navigator;
    }

    async open() {
        const code = SLCAN_BITRATE_CODES[this.bitrate];
        if (!code) throw new Error(`Bitrate ${this.bitrate} is not supported by SLCAN.`);

        this.port = await navigator.serial.requestPort();
        await this.port.open({ baudRate: 115200 });
        this.running = true;

        await this.send("C");
        await this.send(code);
        await this.send(this.listenOnly ? "L" : "O");
        this.onStatus(`SLCAN adapter opened at ${this.bitrate} bit/s${this.listenOnly ? " (listen-only)" : ""}.`, "ok");

        this.port.addEventListener?.("disconnect", () => {
            this.onStatus("Serial adapter was unplugged.", "error");
            this.close();
        });
        this.readLoop();
    }

    async send(cmd) {
        const writer = this.port.writable.getWriter();
        try {
            await writer.write(new TextEncoder().encode(cmd + "\r"));
        } finally {
            writer.releaseLock();
        }
    }

    async readLoop() {
        const decoder = new TextDecoder();
        let buffer = "";
        while (this.running && this.port?.readable) {
            this.reader = this.port.readable.getReader();
            try {
                while (this.running) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let idx;
                    while ((idx = buffer.search(/[\r\x07]/)) >= 0) {
                        const line = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 1);
                        this.parseLine(line);
                    }
                }
            } catch (err) {
                if (this.running) this.onStatus(`Serial read error: ${err.message}`, "error");
            } finally {
                this.reader.releaseLock();
                this.reader = null;
            }
        }
    }

    parseLine(line) {
        const type = line[0];
        if (!type || !"tTrR".includes(type)) return;
        const extended = type === "T" || type === "R";
        const rtr = type === "r" || type === "R";
        const idLen = extended ? 8 : 3;
        const id = parseInt(line.substr(1, idLen), 16);
        const dlc = parseInt(line[1 + idLen], 16);
        if (Number.isNaN(id) || Number.isNaN(dlc)) return;
        const data = new Uint8Array(rtr ? 0 : Math.min(dlc, 8));
        for (let i = 0; i < data.length; i++) {
            data[i] = parseInt(line.substr(2 + idLen + i * 2, 2), 16);
        }
        this.onFrame({ id, extended, rtr, dlc, data });
    }

    async close() {
        if (!this.port) return;
        this.running = false;
        try { await this.send("C"); } catch { /* port may already be gone */ }
        try { await this.reader?.cancel(); } catch { /* ignore */ }
        try { await this.port.close(); } catch { /* ignore */ }
        this.port = null;
        this.onStatus("Adapter disconnected.", "idle");
    }
}

// ---------------------------------------------------------------------------
// PEAK PCAN-USB (classic, IPEH-002021/002022) over WebUSB.
// Requires the WinUSB driver on Windows (one-time Zadig driver swap).
// Protocol follows the Linux kernel driver drivers/net/can/usb/peak_usb/pcan_usb.c.
// ---------------------------------------------------------------------------
const PEAK_VENDOR_ID = 0x0c72;
const PCAN_USB_PRODUCT_ID = 0x000c;

const EP_CMD_OUT = 1;
const EP_MSG_IN = 2;
const CMD_LEN = 16;
const RX_BUFFER_SIZE = 64;

const CMD_BITRATE = 1;
const CMD_SET_BUS = 3;
const CMD_EXT_VCC = 10;
const FN_SET = 2;
const BUS_XCVER = 2;
const BUS_SILENT_MODE = 3;

const SL_TIMESTAMP = 0x80;
const SL_INTERNAL = 0x40;
const SL_EXT_ID = 0x20;
const SL_RTR = 0x10;
const SL_DLC = 0x0f;

const REC_ERROR = 1;
const REC_ANALOG = 2;
const REC_BUSLOAD = 3;

const ERR_BUS_LIGHT = 0x04;
const ERR_BUS_HEAVY = 0x08;
const ERR_BUS_OFF = 0x10;

// SJA1000 BTR0/BTR1 values used by PEAK (8 MHz CAN clock).
const PCAN_BTR = {
    1000000: 0x0014, 800000: 0x0016, 500000: 0x001c, 250000: 0x011c,
    125000: 0x031c, 100000: 0x432f, 50000: 0x472f, 20000: 0x532f, 10000: 0x672f
};

export class PcanUsbTransport {
    constructor({ bitrate, listenOnly, onFrame, onStatus, onLog, debug }) {
        this.bitrate = bitrate;
        this.listenOnly = listenOnly;
        this.onFrame = onFrame;
        this.onStatus = onStatus;
        this.onLog = onLog || (() => {});
        this.debugBuffers = debug ? 40 : 0;
        this.lastErrorFlags = 0;
        this.device = null;
        this.running = false;
        this.onDisconnect = (event) => {
            if (event.device === this.device) {
                this.onStatus("PCAN-USB was unplugged.", "error");
                this.running = false;
                this.device = null;
            }
        };
    }

    static isSupported() {
        return "usb" in navigator;
    }

    async open() {
        const btr = PCAN_BTR[this.bitrate];
        if (btr === undefined) throw new Error(`Bitrate ${this.bitrate} is not supported by PCAN-USB.`);

        this.device = await navigator.usb.requestDevice({
            filters: [{ vendorId: PEAK_VENDOR_ID, productId: PCAN_USB_PRODUCT_ID }]
        });
        try {
            await this.device.open();
        } catch (err) {
            throw new Error(
                "Chrome could not open the PCAN-USB. On Windows the adapter must use the WinUSB driver " +
                "(install it once with Zadig) and PEAK software such as PCAN-View must be closed. " +
                `Details: ${err.message}`
            );
        }
        if (this.device.configuration === null) await this.device.selectConfiguration(1);
        await this.device.claimInterface(0);
        navigator.usb.addEventListener("disconnect", this.onDisconnect);

        await this.sendCmd(CMD_SET_BUS, BUS_XCVER, [0]);
        await this.sendCmd(CMD_BITRATE, FN_SET, [btr & 0xff, btr >> 8]);
        const silentSupported = this.device.deviceVersionMajor > 3;
        if (silentSupported) {
            await this.sendCmd(CMD_SET_BUS, BUS_SILENT_MODE, [this.listenOnly ? 1 : 0]);
        }
        await this.sendCmd(CMD_EXT_VCC, FN_SET, [0]);
        await this.sendCmd(CMD_SET_BUS, BUS_XCVER, [1]);

        this.running = true;
        const mode = this.listenOnly
            ? silentSupported ? " (listen-only)" : " (firmware too old for listen-only; adapter will ACK frames)"
            : "";
        this.onStatus(`PCAN-USB opened at ${this.bitrate} bit/s${mode}.`, "ok");
        this.readLoop();
    }

    async sendCmd(func, num, args = []) {
        const buf = new Uint8Array(CMD_LEN);
        buf[0] = func;
        buf[1] = num;
        buf.set(args.slice(0, CMD_LEN - 2), 2);
        const result = await this.device.transferOut(EP_CMD_OUT, buf);
        if (result.status !== "ok") throw new Error(`PCAN-USB command ${func} failed: ${result.status}`);
    }

    async readLoop() {
        while (this.running && this.device) {
            try {
                const result = await this.device.transferIn(EP_MSG_IN, RX_BUFFER_SIZE);
                if (result.status === "stall") {
                    await this.device.clearHalt("in", EP_MSG_IN);
                    continue;
                }
                if (result.data && result.data.byteLength > 2) {
                    const buf = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
                    if (this.debugBuffers > 0) {
                        this.debugBuffers--;
                        this.onLog(`USB RX (${buf.length}): ${[...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
                    }
                    this.decodeBuffer(buf);
                }
            } catch (err) {
                if (this.running) this.onStatus(`PCAN-USB read error: ${err.message}`, "error");
                this.running = false;
            }
        }
    }

    decodeBuffer(buf) {
        const recordCount = buf[1];
        let p = 2;
        let tsIndex = 0;
        const end = buf.length;

        const skipTimestamp = () => {
            p += tsIndex === 0 ? 2 : 1;
            tsIndex++;
        };

        for (let r = 0; r < recordCount && p < end; r++) {
            const sl = buf[p++];
            let len = sl & SL_DLC;

            if (sl & SL_INTERNAL) {
                if (p + 2 > end) return;
                const func = buf[p];
                const num = buf[p + 1];
                p += 2;
                if (sl & SL_TIMESTAMP) skipTimestamp();
                if (func === REC_ANALOG) len = 2;
                else if (func === REC_BUSLOAD) len = 1;
                else if (func === REC_ERROR) this.reportError(num);
                p += len;
                continue;
            }

            let id;
            const extended = !!(sl & SL_EXT_ID);
            if (extended) {
                if (p + 4 > end) return;
                id = ((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 3) & 0x1fffffff;
                p += 4;
            } else {
                if (p + 2 > end) return;
                id = (buf[p] | (buf[p + 1] << 8)) >> 5;
                p += 2;
            }
            skipTimestamp();

            const rtr = !!(sl & SL_RTR);
            const dlc = len;
            const dataLen = rtr ? 0 : Math.min(len, 8);
            if (p + dataLen > end) return;
            const data = buf.slice(p, p + dataLen);
            p += dataLen;
            this.onFrame({ id, extended, rtr, dlc, data });
        }
    }

    reportError(flags) {
        const severity = flags & (ERR_BUS_OFF | ERR_BUS_HEAVY | ERR_BUS_LIGHT);
        if (severity === this.lastErrorFlags) return;
        this.lastErrorFlags = severity;
        if (!severity) this.onLog("CAN bus errors cleared.");
        else if (flags & ERR_BUS_OFF) this.onStatus("CAN bus-off. Check wiring, termination and bitrate.", "error");
        else if (flags & ERR_BUS_HEAVY) this.onStatus("CAN error-passive (heavy bus errors). Check bitrate.", "warn");
        else if (flags & ERR_BUS_LIGHT) this.onStatus("CAN error warning level reached.", "warn");
    }

    async close() {
        navigator.usb.removeEventListener("disconnect", this.onDisconnect);
        if (!this.device) return;
        this.running = false;
        try { await this.sendCmd(CMD_SET_BUS, BUS_XCVER, [0]); } catch { /* ignore */ }
        try { await this.device.releaseInterface(0); } catch { /* ignore */ }
        try { await this.device.close(); } catch { /* ignore */ }
        this.device = null;
        this.onStatus("Adapter disconnected.", "idle");
    }
}

// ---------------------------------------------------------------------------
// Simulator: generates frames from the loaded DBC so the UI can be tested
// without hardware.
// ---------------------------------------------------------------------------
export class SimulatorTransport {
    constructor({ getDbc, encodeRandom, onFrame, onStatus }) {
        this.getDbc = getDbc;
        this.encodeRandom = encodeRandom;
        this.onFrame = onFrame;
        this.onStatus = onStatus;
        this.timer = null;
    }

    static isSupported() {
        return true;
    }

    async open() {
        const dbc = this.getDbc();
        if (!dbc || !dbc.messageCount) throw new Error("Load a DBC file before starting the simulator.");
        this.timer = setInterval(() => {
            const messages = [...this.getDbc().messages.values()];
            for (let i = 0; i < 5; i++) {
                const msg = messages[Math.floor(Math.random() * messages.length)];
                const data = this.encodeRandom(msg);
                this.onFrame({ id: msg.id, extended: msg.extended, rtr: false, dlc: data.length, data });
            }
            if (Math.random() < 0.05) {
                this.onFrame({ id: 0x7ff, extended: false, rtr: false, dlc: 2, data: new Uint8Array([0xde, 0xad]) });
            }
        }, 50);
        this.onStatus("Simulator running (frames generated from the DBC).", "ok");
    }

    async close() {
        clearInterval(this.timer);
        this.timer = null;
        this.onStatus("Simulator stopped.", "idle");
    }
}
