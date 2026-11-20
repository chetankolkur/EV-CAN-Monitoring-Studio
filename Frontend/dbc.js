// Minimal DBC parser and CAN signal decoder that runs entirely in the browser.
// Supports BO_, SG_ (Intel/Motorola, signed/unsigned, multiplexed), VAL_,
// SIG_VALTYPE_ (IEEE float/double) and CM_ comments.

const CAN_EFF_FLAG = 0x80000000;

export function parseDbc(text) {
    const messages = new Map();
    let current = null;

    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        let m = line.match(/^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/);
        if (m) {
            if (m[2] === "VECTOR__INDEPENDENT_SIG_MSG") {
                current = null;
                continue;
            }
            const { id, extended } = splitId(Number(m[1]));
            current = {
                id,
                extended,
                name: m[2],
                dlc: Number(m[3]),
                sender: m[4],
                signals: [],
                multiplexor: null,
                comment: ""
            };
            messages.set(messageKey(id, extended), current);
            continue;
        }

        m = line.match(
            /^SG_\s+(\w+)\s*(M|m\d+M?)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([^,]+)\s*,\s*([^)]+)\)\s*\[\s*([^|]*)\|([^\]]*)\]\s*"((?:[^"\\]|\\.)*)"/
        );
        if (m && current) {
            const signal = {
                name: m[1],
                dbcName: m[1],
                startBit: Number(m[3]),
                length: Number(m[4]),
                littleEndian: m[5] === "1",
                signed: m[6] === "-",
                factor: Number(m[7]),
                offset: Number(m[8]),
                min: Number(m[9]),
                max: Number(m[10]),
                unit: m[11],
                valueType: "int",
                choices: null,
                isMultiplexor: false,
                muxValue: null,
                comment: ""
            };
            const mux = m[2];
            if (mux === "M") {
                signal.isMultiplexor = true;
                current.multiplexor = signal;
            } else if (mux && mux.startsWith("m")) {
                signal.muxValue = parseInt(mux.slice(1), 10);
                if (mux.endsWith("M")) {
                    signal.isMultiplexor = true;
                }
            }
            current.signals.push(signal);
            continue;
        }

        if (line.startsWith("BO_") || line === "") {
            if (line === "") current = null;
            continue;
        }

        m = line.match(/^VAL_\s+(\d+)\s+(\w+)\s+(.*);\s*$/);
        if (m) {
            const signal = findSignal(messages, Number(m[1]), m[2]);
            if (signal) {
                signal.choices = new Map();
                const pairRe = /(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g;
                let pair;
                while ((pair = pairRe.exec(m[3])) !== null) {
                    signal.choices.set(Number(pair[1]), pair[2]);
                }
            }
            continue;
        }

        m = line.match(/^SIG_VALTYPE_\s+(\d+)\s+(\w+)\s*:?\s*(\d)\s*;/);
        if (m) {
            const signal = findSignal(messages, Number(m[1]), m[2]);
            if (signal) {
                signal.valueType = m[3] === "1" ? "float" : m[3] === "2" ? "double" : "int";
            }
            continue;
        }

        // Names longer than 32 characters are stored as attributes.
        m = line.match(/^BA_\s+"System(Signal|Message)LongSymbol"\s+(?:SG_\s+(\d+)\s+(\w+)|BO_\s+(\d+))\s+"([^"]*)"\s*;/);
        if (m) {
            if (m[1] === "Signal") {
                const signal = findSignal(messages, Number(m[2]), m[3]);
                if (signal) signal.name = m[5];
            } else {
                const msg = findMessage(messages, Number(m[4]));
                if (msg) msg.name = m[5];
            }
            continue;
        }

        if (/^CM_\s/.test(line)) {
            // Comments may span multiple lines until the closing `";`.
            let full = line;
            while (!/"\s*;\s*$/.test(full) && i + 1 < lines.length) {
                full += "\n" + lines[++i];
            }
            const cm = full.match(/^CM_\s+(BO_|SG_)\s+(\d+)\s+(?:(\w+)\s+)?"([\s\S]*)"\s*;\s*$/);
            if (cm) {
                if (cm[1] === "BO_") {
                    const msg = findMessage(messages, Number(cm[2]));
                    if (msg) msg.comment = cm[4];
                } else {
                    const signal = findSignal(messages, Number(cm[2]), cm[3]);
                    if (signal) signal.comment = cm[4];
                }
            }
        }
    }

    return createDbc(messages);
}

export function filterDbcMessages(dbc, shouldKeep) {
    const messages = new Map(
        [...dbc.messages].filter(([, message]) => shouldKeep(message))
    );
    return createDbc(messages);
}

function createDbc(messages) {
    const list = [...messages.values()];
    return {
        messages,
        messageCount: list.length,
        signalCount: list.reduce((sum, msg) => sum + msg.signals.length, 0),
        getMessage(id, extended) {
            return messages.get(messageKey(id, extended)) || null;
        },
        findById(id) {
            return messages.get(messageKey(id, false)) || messages.get(messageKey(id, true)) || null;
        }
    };
}

function messageKey(id, extended) {
    return `${extended ? "x" : "s"}${id}`;
}

// Some DBC files list 29-bit IDs without the 0x80000000 extended flag;
// anything above 0x7FF can only be an extended frame on the bus.
function splitId(rawId) {
    const flagged = rawId >= CAN_EFF_FLAG;
    const id = flagged ? rawId - CAN_EFF_FLAG : rawId;
    return { id, extended: flagged || id > 0x7ff };
}

function findMessage(messages, rawId) {
    const { id, extended } = splitId(rawId);
    return messages.get(messageKey(id, extended)) || null;
}

function findSignal(messages, rawId, name) {
    const msg = findMessage(messages, rawId);
    return msg ? msg.signals.find((s) => s.dbcName === name) || null : null;
}

function extractRaw(data, signal) {
    const { startBit, length, littleEndian } = signal;
    const useBigInt = length > 52;
    let value = useBigInt ? 0n : 0;

    if (littleEndian) {
        for (let i = length - 1; i >= 0; i--) {
            const pos = startBit + i;
            const byte = pos >> 3;
            const bit = byte < data.length ? (data[byte] >> (pos & 7)) & 1 : 0;
            value = useBigInt ? (value << 1n) | BigInt(bit) : value * 2 + bit;
        }
    } else {
        // Motorola: start bit is the MSB in DBC "sawtooth" numbering.
        const msbLinear = (startBit >> 3) * 8 + (7 - (startBit & 7));
        for (let i = 0; i < length; i++) {
            const pos = msbLinear + i;
            const byte = pos >> 3;
            const bit = byte < data.length ? (data[byte] >> (7 - (pos & 7))) & 1 : 0;
            value = useBigInt ? (value << 1n) | BigInt(bit) : value * 2 + bit;
        }
    }
    return value;
}

function rawToPhysical(raw, signal) {
    if (signal.valueType === "float" || signal.valueType === "double") {
        const view = new DataView(new ArrayBuffer(8));
        if (signal.valueType === "float") {
            view.setUint32(0, Number(raw) >>> 0);
            return view.getFloat32(0) * signal.factor + signal.offset;
        }
        view.setBigUint64(0, BigInt(raw));
        return view.getFloat64(0) * signal.factor + signal.offset;
    }

    let n = raw;
    if (signal.signed) {
        if (typeof n === "bigint") {
            if (n & (1n << BigInt(signal.length - 1))) n -= 1n << BigInt(signal.length);
        } else if (n >= 2 ** (signal.length - 1)) {
            n -= 2 ** signal.length;
        }
    }
    const physical = Number(n) * signal.factor + signal.offset;
    // Trim floating-point noise like 0.30000000000000004.
    return Number.isInteger(physical) ? physical : Number(physical.toPrecision(12));
}

export function decodeMessage(message, data) {
    const results = [];
    let muxValue = null;
    if (message.multiplexor) {
        muxValue = Number(extractRaw(data, message.multiplexor));
    }

    for (const signal of message.signals) {
        if (signal.muxValue !== null && signal.muxValue !== muxValue) continue;
        const raw = extractRaw(data, signal);
        const value = rawToPhysical(raw, signal);
        const label = signal.choices ? signal.choices.get(Number(raw)) : undefined;
        results.push({
            name: signal.name,
            value,
            display: label !== undefined ? label : value,
            unit: signal.unit,
            min: signal.min,
            max: signal.max
        });
    }
    return results;
}

// Builds a random payload inside each signal's range, for the simulator.
export function encodeRandom(message) {
    const data = new Uint8Array(message.dlc || 8);
    const muxChoice = message.multiplexor
        ? pickMuxValue(message)
        : null;

    for (const signal of message.signals) {
        if (signal.muxValue !== null && signal.muxValue !== muxChoice) continue;
        let raw;
        if (signal.isMultiplexor && muxChoice !== null && signal === message.multiplexor) {
            raw = muxChoice;
        } else if (signal.choices && signal.choices.size) {
            const keys = [...signal.choices.keys()];
            raw = keys[Math.floor(Math.random() * keys.length)];
        } else if (signal.valueType !== "int" || signal.length > 32) {
            raw = 0;
        } else {
            const lo = signal.min, hi = signal.max;
            const physical = hi > lo ? lo + Math.random() * (hi - lo) : Math.random() * 100;
            raw = Math.round((physical - signal.offset) / (signal.factor || 1));
            const maxRaw = 2 ** signal.length;
            if (raw < 0) raw += maxRaw;
            raw = Math.max(0, Math.min(maxRaw - 1, raw));
        }
        insertRaw(data, signal, raw);
    }
    return data;
}

function pickMuxValue(message) {
    const values = [...new Set(message.signals.filter((s) => s.muxValue !== null).map((s) => s.muxValue))];
    return values.length ? values[Math.floor(Math.random() * values.length)] : 0;
}

function insertRaw(data, signal, raw) {
    const { startBit, length, littleEndian } = signal;
    for (let i = 0; i < length; i++) {
        const bit = Math.floor(raw / 2 ** i) % 2;
        let byte, shift;
        if (littleEndian) {
            const pos = startBit + i;
            byte = pos >> 3;
            shift = pos & 7;
        } else {
            const msbLinear = (startBit >> 3) * 8 + (7 - (startBit & 7));
            const pos = msbLinear + (length - 1 - i);
            byte = pos >> 3;
            shift = 7 - (pos & 7);
        }
        if (byte >= data.length) continue;
        data[byte] = bit ? data[byte] | (1 << shift) : data[byte] & ~(1 << shift);
    }
}
