
import { parseDbc, decodeMessage, encodeRandom } from "./dbc.js";
import { SlcanTransport, PcanUsbTransport, SimulatorTransport } from "./transports.js";

const DBC_API_URL = "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/documents?path=version1&file=bms.dbc";
const DBC_PROXY_URL = "/api/dbc-file";
const RAW_ROWS = 200;
const STALE_MS = 3000;

const $ = (id) => document.getElementById(id);

const state = {
    dbc: null,
    transport: null,
    totalFrames: 0,
    decodedFrames: 0,
    framesThisSecond: 0,
    uniqueIds: new Set(),
    signals: new Map(),
    signalCards: new Map(),
    rawBuffer: [],
    unmatchedIds: new Set(),
    rawDirty: false,
    recording: false,
    recordRows: [],
    lastFrameAt: 0
};

// ---------------------------------------------------------------- logging
function log(text) {
    const el = $("log");
    const stamp = new Date().toLocaleTimeString();
    el.textContent += `[${stamp}] ${text}\n`;
    el.scrollTop = el.scrollHeight;
}

function setStatus(text, level = "idle") {
    $("statusText").textContent = text;
    $("statusDot").className = `bc-dot ${level}`;
    log(text);
}

// ---------------------------------------------------------------- DBC
function useDbc(text, source) {
    const dbc = parseDbc(text);
    if (!dbc.messageCount) throw new Error("No BO_ messages found. Is this a valid DBC file?");
    state.dbc = dbc;
    state.signals.clear();
    state.signalCards.clear();
    $("signalGrid").innerHTML = '<div class="bc-empty">Waiting for decoded CAN frames…</div>';
    $("dbcInfo").textContent = `Loaded ${source}: ${dbc.messageCount} messages, ${dbc.signalCount} signals.`;
    log(`DBC loaded from ${source}: ${dbc.messageCount} messages, ${dbc.signalCount} signals.`);
}

$("dbcFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
        useDbc(await file.text(), file.name);
    } catch (err) {
        $("dbcInfo").textContent = `Could not parse ${file.name}: ${err.message}`;
        log(`DBC error: ${err.message}`);
    }
});

async function fetchDbcFromAws() {
    const meta = await fetch(DBC_API_URL);
    if (!meta.ok) throw new Error(`AWS API returned ${meta.status}`);
    const json = await meta.json();
    const url = json.files?.[0]?.url;
    if (!url) throw new Error("AWS API did not return a download URL");
    const file = await fetch(url);
    if (!file.ok) throw new Error(`DBC download returned ${file.status}`);
    return file.text();
}

async function fetchDbcFromProxy() {
    const res = await fetch(DBC_PROXY_URL);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    return res.text();
}

$("dbcAwsBtn").addEventListener("click", async () => {
    const btn = $("dbcAwsBtn");
    btn.disabled = true;
    $("dbcInfo").textContent = "Downloading BMS DBC…";
    try {
        let text;
        try {
            text = await fetchDbcFromAws();
        } catch (err) {
            log(`Direct AWS download failed (${err.message}); trying the dashboard server.`);
            text = await fetchDbcFromProxy();
        }
        useDbc(text, "server (bms.dbc)");
    } catch (err) {
        $("dbcInfo").textContent = `Could not download the DBC: ${err.message}. Choose the .dbc file manually instead.`;
        log(`DBC download error: ${err.message}`);
    } finally {
        btn.disabled = false;
    }
});

// ---------------------------------------------------------------- frames
function hex(n, width) {
    return n.toString(16).toUpperCase().padStart(width, "0");
}

function handleFrame(frame) {
    const now = Date.now();
    state.totalFrames++;
    state.framesThisSecond++;
    state.lastFrameAt = now;

    const canId = `0x${hex(frame.id, frame.extended ? 8 : 3)}`;
    state.uniqueIds.add(`${frame.extended ? "x" : "s"}${frame.id}`);

    let messageName = "Not in DBC";
    if (state.dbc && !frame.rtr) {
        const message = state.dbc.getMessage(frame.id, frame.extended);
        if (message) {
            messageName = message.name;
            state.decodedFrames++;
            for (const sig of decodeMessage(message, frame.data)) {
                state.signals.set(`${message.name}.${sig.name}`, {
                    ...sig, message: message.name, canId, updatedAt: now
                });
            }
        } else if (state.dbc.findById(frame.id)) {
            messageName = "CAN format mismatch";
        }
    } else if (!state.dbc) {
        messageName = "DBC not loaded";
    }

    const matched = messageName !== "Not in DBC" &&
        messageName !== "DBC not loaded" &&
        messageName !== "CAN format mismatch";

    if (!matched) state.unmatchedIds.add(canId);

    // Record exactly once for each successfully matched DBC frame.
    if (state.recording && matched) {
        recordDecodedFrame(now);
    }

    if (!$("pauseRaw").checked && (matched || !$("onlyDbc").checked)) {
        state.rawBuffer.unshift({
            time: new Date(now).toLocaleTimeString([], { hour12: false }) + "." + String(now % 1000).padStart(3, "0"),
            canId,
            fmt: frame.extended ? "EXT" : "STD",
            dlc: frame.dlc,
            data: frame.rtr ? "RTR" : [...frame.data].map((b) => hex(b, 2)).join(" "),
            messageName,
            matched
        });
        if (state.rawBuffer.length > RAW_ROWS) state.rawBuffer.length = RAW_ROWS;
        state.rawDirty = true;
    }
}

// ---------------------------------------------------------------- rendering
function formatValue(sig) {
    if (typeof sig.display === "string") return sig.display;
    const v = sig.display;
    return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 3 : 2).replace(/\.?0+$/, "");
}

function renderSignals() {
    const grid = $("signalGrid");
    const filter = $("signalSearch").value.trim().toLowerCase();
    const now = Date.now();

    if (state.signals.size && grid.querySelector(".bc-empty")) grid.innerHTML = "";

    const keys = [...state.signals.keys()].sort();
    for (const key of keys) {
        const sig = state.signals.get(key);
        let card = state.signalCards.get(key);
        if (!card) {
            card = document.createElement("div");
            card.className = "bc-signal";
            card.innerHTML = '<div class="name"></div><div class="msg"></div><div class="value"></div>';
            card.querySelector(".name").textContent = sig.name;
            card.querySelector(".msg").textContent = `${sig.message} · ${sig.canId}`;
            state.signalCards.set(key, card);
            const next = keys.slice(keys.indexOf(key) + 1).map((k) => state.signalCards.get(k)).find(Boolean);
            grid.insertBefore(card, next || null);
        }
        const valueEl = card.querySelector(".value");
        valueEl.textContent = formatValue(sig);
        if (sig.unit) {
            const unit = document.createElement("small");
            unit.textContent = sig.unit;
            valueEl.appendChild(unit);
        }
        card.classList.toggle("stale", now - sig.updatedAt > STALE_MS);
        card.hidden = filter && !key.toLowerCase().includes(filter);
    }
}

function renderRaw() {
    if (!state.rawDirty) return;
    state.rawDirty = false;
    const body = $("rawTable");
    if (!state.rawBuffer.length) {
        body.innerHTML = '<tr><td colspan="6" class="bc-empty">No frames yet.</td></tr>';
        return;
    }
    const rows = state.rawBuffer.map((f) => {
        const tr = document.createElement("tr");
        const cells = [f.time, f.canId, f.fmt, f.dlc, f.data, f.messageName];
        cells.forEach((text, i) => {
            const td = document.createElement("td");
            td.textContent = text;
            if (i === 1 || i === 4) td.className = "mono";
            if (i === 5 && !f.matched) td.className = "unmatched";
            tr.appendChild(td);
        });
        return tr;
    });
    body.replaceChildren(...rows);
}

function renderMetrics() {
    $("mFrames").textContent = state.totalFrames.toLocaleString();
    $("mIds").textContent = state.uniqueIds.size;
    $("mDecoded").textContent = state.decodedFrames.toLocaleString();
    const hidden = state.unmatchedIds.size;
    $("unmatchedInfo").textContent = hidden && $("onlyDbc").checked
        ? `(${hidden} ID${hidden === 1 ? "" : "s"} not in DBC hidden)`
        : "";
    $("unmatchedInfo").title = [...state.unmatchedIds].sort().join(", ");
}

setInterval(() => {
    renderSignals();
    renderRaw();
    renderMetrics();
}, 250);

setInterval(() => {
    $("mRate").textContent = state.framesThisSecond;
    state.framesThisSecond = 0;
    if (state.transport && state.lastFrameAt && Date.now() - state.lastFrameAt > STALE_MS) {
        $("statusText").textContent = "Connected · no CAN traffic for 3 s (check bus power, wiring, bitrate)";
        $("statusDot").className = "bc-dot warn";
    } else if (state.transport && state.lastFrameAt) {
        $("statusText").textContent = "Connected · receiving CAN frames";
        $("statusDot").className = "bc-dot ok";
    }
}, 1000);

$("signalSearch").addEventListener("input", renderSignals);
$("clearBtn").addEventListener("click", () => {
    state.rawBuffer = [];
    state.rawDirty = true;
});
$("onlyDbc").addEventListener("change", () => {
    if ($("onlyDbc").checked) {
        state.rawBuffer = state.rawBuffer.filter((f) => f.matched);
        state.rawDirty = true;
    }
});

// ---------------------------------------------------------------- connection
function createTransport(kind) {
    const options = {
        bitrate: Number($("bitrateSelect").value),
        listenOnly: $("listenOnly").checked,
        onFrame: handleFrame,
        onLog: log,
        debug: new URLSearchParams(location.search).has("debug"),
        onStatus: (text, level) => {
            setStatus(text, level);
            if (level === "error" && state.transport) disconnect();
        }
    };
    if (kind === "pcan") return new PcanUsbTransport(options);
    if (kind === "slcan") return new SlcanTransport(options);
    return new SimulatorTransport({ ...options, getDbc: () => state.dbc, encodeRandom });
}

async function connect() {
    const kind = $("transportSelect").value;
    if (!state.dbc) log("Warning: no DBC loaded. Frames will be shown as raw data only.");
    const transport = createTransport(kind);
    $("connectBtn").disabled = true;
    try {
        await transport.open();
        state.transport = transport;
        state.lastFrameAt = 0;
        $("disconnectBtn").disabled = false;
        $("transportSelect").disabled = true;
        $("bitrateSelect").disabled = true;
    } catch (err) {
        $("connectBtn").disabled = false;
        if (err.name === "NotFoundError") {
            setStatus("No adapter selected.", "idle");
        } else {
            setStatus(`Connection failed: ${err.message}`, "error");
        }
        try { await transport.close(); } catch { /* ignore */ }
    }
}

async function disconnect() {
    const transport = state.transport;
    state.transport = null;
    if (transport) await transport.close();
    $("connectBtn").disabled = false;
    $("disconnectBtn").disabled = true;
    $("transportSelect").disabled = false;
    $("bitrateSelect").disabled = false;
}

$("connectBtn").addEventListener("click", connect);
$("disconnectBtn").addEventListener("click", disconnect);
$("transportSelect").addEventListener("change", () => {
    $("pcanHelp").hidden = $("transportSelect").value !== "pcan";
});

// ---------------------------------------------------------------- recording
function recordDecodedFrame(frameTime) {
    const row = {
        timestamp: new Date(frameTime).toISOString()
    };

    // Keep the latest known values of all decoded signals.
    for (const [key, sig] of state.signals) {
        row[key] = formatValue(sig);
    }

    state.recordRows.push(row);

    $("recordInfo").textContent =
        `${state.recordRows.length} decoded frame(s)`;
}

$("recordBtn").addEventListener("click", () => {
    const btn = $("recordBtn");

    if (!state.recording) {
        state.recording = true;
        state.recordRows = [];

        $("recordInfo").textContent = "0 decoded frame(s)";

        btn.textContent = "■ Stop recording";
        btn.classList.add("recording");

        $("exportBtn").disabled = true;

        log("Recording started (one row per decoded BMS frame).");

    } else {
        state.recording = false;

        btn.textContent = "● Start recording";
        btn.classList.remove("recording");

        $("exportBtn").disabled = !state.recordRows.length;

        log(`Recording stopped: ${state.recordRows.length} decoded frame(s).`);
    }
});

$("exportBtn").addEventListener("click", () => {
    const columns = ["timestamp", ...new Set(state.recordRows.flatMap((r) => Object.keys(r)).filter((k) => k !== "timestamp"))];
    const escape = (v) => {
        const s = v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [columns.map(escape).join(",")];
    for (const row of state.recordRows) lines.push(columns.map((c) => escape(row[c])).join(","));
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `can_signals_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------- startup
if (!PcanUsbTransport.isSupported() || !SlcanTransport.isSupported()) {
    $("browserWarning").hidden = false;
}
if (!window.isSecureContext) {
    log("Warning: this page must be opened over https:// or http://localhost for USB/Serial access.");
}
log("Ready. Load a DBC file, choose the adapter and click Connect.");
