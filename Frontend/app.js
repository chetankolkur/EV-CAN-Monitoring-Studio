
import { parseDbc, decodeMessage, encodeRandom } from "./dbc.js";
import { SlcanTransport, PcanUsbTransport, SimulatorTransport } from "./transports.js";

const DBC_API_URL = "https://ke76ricmk3.execute-api.ap-south-1.amazonaws.com/prod/documents?path=version1&file=bms.dbc";
const DBC_PROXY_URL = "/api/dbc-file";
const RAW_ROWS = 200;
const STALE_MS = 3000;
const MAX_SIGNAL_HISTORY = 120;
const SIGNAL_CHART_HEIGHT = 340;

const $ = (id) => document.getElementById(id);

const state = {
    dbc: null,
    transport: null,
    totalFrames: 0,
    decodedFrames: 0,
    framesThisSecond: 0,
    uniqueIds: new Set(),
    signals: new Map(),
    signalRows: new Map(),
    signalHistory: new Map(),
    ecuTestResults: new Map(),
    rawBuffer: [],
    unmatchedIds: new Set(),
    firstUnmatchedFrame: null,
    rawDirty: false,
    recording: false,
    recordRows: [],
    lastFrameAt: 0
};

// ---------------------------------------------------------------- logging
function log(text) {
    const stamp = new Date().toLocaleTimeString();
    console.debug(`[${stamp}] ${text}`);
}

function setStatus(text, level = "idle") {
    $("statusText").textContent = text;
    $("statusDot").className = `bc-dot ${level}`;
    updateSidebarStatus(text, level);
    log(text);
}

function updateSidebarStatus(text, level = "idle") {
    const sidebarStatus = $("canToolStatus");
    const sidebarDot = $("sidebarStatusDot");
    if (sidebarStatus) sidebarStatus.textContent = text;
    if (sidebarDot) sidebarDot.className = `dot ${level === "ok" ? "connected" : level === "error" ? "error" : ""}`;
}

// ---------------------------------------------------------------- DBC
function useDbc(text, source) {
    const dbc = parseDbc(text);
    if (!dbc.messageCount) throw new Error("No BO_ messages found. Is this a valid DBC file?");
    state.dbc = dbc;
    state.signals.clear();
    state.signalRows.clear();
    state.signalHistory.clear();
    state.ecuTestResults.clear();
    state.firstUnmatchedFrame = null;
    $("signalGrid").innerHTML = '<div class="bc-empty">Waiting for decoded CAN frames…</div>';
    $("dbcInfo").textContent = `Loaded ${source}: ${dbc.messageCount} messages, ${dbc.signalCount} signals.`;
    log(`DBC loaded from ${source}: ${dbc.messageCount} messages, ${dbc.signalCount} signals.`);
    renderEcuTests();
}

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
        $("dbcInfo").textContent = `Could not download the DBC: ${err.message}. Check the server connection and try again.`;
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
                const key = `${message.name}.${sig.name}`;
                const decoded = {
                    ...sig, message: message.name, canId, updatedAt: now
                };
                state.signals.set(key, decoded);
                let history = state.signalHistory.get(key);
                if (!history) {
                    history = [];
                    state.signalHistory.set(key, history);
                }
                if (typeof sig.value === "number" && Number.isFinite(sig.value)) {
                    history.push({ time: now, value: sig.value });
                    if (history.length > MAX_SIGNAL_HISTORY) {
                        history.splice(0, history.length - MAX_SIGNAL_HISTORY);
                    }
                }
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

    if (!matched) {
        state.unmatchedIds.add(canId);
        if (state.dbc && !state.firstUnmatchedFrame) {
            state.firstUnmatchedFrame = { canId, extended: frame.extended, messageName };
        }
    }

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

// ---------------------------------------------------------------- ECU tests
const ECU_CELL_SPREAD_LIMIT_MV = 200;
const ECU_TESTS = [
    {
        id: "cell-spread",
        name: "Cell voltage spread test",
        instructions: [
            "Ensure the vehicle is on its stand with ignition on.",
            "Confirm the CAN tool is connected and communication is established.",
            "Click Run test — cell voltage is read automatically over CAN."
        ],
        condition: "Delta voltage < 200mV across the pack",
        kind: "cell"
    },
    {
        id: "tpms",
        name: "TPMS communication check",
        instructions: [
            "Ensure TPMS sensors are fitted and the vehicle is stationary.",
            "Check for a TPMS CAN broadcast."
        ],
        condition: "TPMS CAN data received → Pass. No response → Fail when a configured observation timeout expires.",
        unavailable: "The loaded BMS DBC does not define TPMS CAN signals or an observation timeout, so communication cannot be verified."
    },
    {
        id: "imu",
        name: "IMU calibration",
        instructions: ["This test is not yet available for this vehicle model."],
        condition: "To be developed",
        unavailable: "IMU calibration is not configured for this vehicle model."
    },
    {
        id: "rpm",
        name: "RPM feedback smoothness",
        instructions: [
            "Place the vehicle on its main stand so the rear wheel spins freely.",
            "Apply controller demand at low RPM.",
            "Check for jittery RPM, motor stall or a Hall fault error code."
        ],
        condition: "Any jittery RPM, motor stall or Hall fault observed → Fail. If none are observed → Pass.",
        unavailable: "The loaded BMS DBC does not provide the required RPM/controller signals or calibrated jitter criteria."
    },
    {
        id: "odo",
        name: "Odo config",
        instructions: [
            "Confirm the new odometer reading against the job card before changing it.",
            "Enter your employee ID and the reason for the change.",
            "The employee ID and reason must be saved to the job record before an ECU write."
        ],
        condition: "Enter the employee ID, reason and new ODO value; save the employee ID and reason to the job record, then send the ODO value to the ECU.",
        unavailable: "Odometer writes are unavailable: no authorized ECU write or job-record API is configured. No CAN message will be sent.",
        inputs: [
            { label: "Employee ID", placeholder: "Required employee ID" },
            { label: "Reason for change", placeholder: "Required reason for change" },
            { label: "New ODO value (km)", placeholder: "Required odometer value" }
        ]
    },
    {
        id: "switch",
        name: "Switch pulse check",
        instructions: [
            "Ask the technician to press each switch on the vehicle in turn.",
            "The tool reads the CAN signal live and displays each switch response.",
            "If a switch shows no response, check its wiring before continuing."
        ],
        condition: "CAN response when each switch is pressed → Pass. No response → Fail; check Vehicle Management → Repair & maintenance.",
        unavailable: "Switch pulse checks are unavailable because this DBC has no configured switch-signal mapping.",
        actions: ["Horn", "Left indicator", "Right indicator", "Headlight beam switch", "Kill switch"]
    },
    {
        id: "throttle",
        name: "Throttle check",
        instructions: [
            "Ask the technician to sweep the throttle smoothly from 0% to 100% directly on the vehicle.",
            "Compare throttle percentage with signal voltage and check for noise, dead spots or sudden jumps.",
            "Check each value against the threshold limits before deciding the result."
        ],
        condition: "Check throttle input voltage, V5_Overvoltage_Fault, V5_Undervoltage_Fault, Throttle Fault, Throttle STB Error and Throttle STG Error. Out-of-limit values → Fail and display the error code. If within limits, an unsuccessful sweep → Fail; a smooth sweep → Pass.",
        unavailable: "Throttle test signals and calibrated threshold limits are not configured in the loaded BMS DBC."
    }
];

function getCellVoltageDefinitions() {
    if (!state.dbc) return [];
    return [...state.dbc.messages.values()].flatMap((message) =>
        message.signals
            .filter((signal) => /^cell\d+volt$/i.test(signal.name.replace(/[^a-z\d]/gi, "")))
            .map((signal) => ({
                key: `${message.name}.${signal.name}`,
                name: signal.name,
                unit: signal.unit
            }))
    );
}

function getCellVoltageReadings() {
    if (!state.dbc) {
        return { available: false, reason: "Load the BMS DBC before running this test." };
    }
    if (!state.transport || state.transport instanceof SimulatorTransport) {
        return { available: false, reason: "Connect a PCAN-USB or SLCAN adapter. Simulator data is not accepted for ECU tests." };
    }

    const definitions = getCellVoltageDefinitions();
    if (definitions.length < 2) {
        return { available: false, reason: "The loaded DBC does not define individual cell-voltage signals." };
    }

    const now = Date.now();
    const readings = [];
    for (const definition of definitions) {
        const signal = state.signals.get(definition.key);
        if (!signal || !Number.isFinite(signal.value) || now - signal.updatedAt > STALE_MS) {
            return {
                available: false,
                reason: `Waiting for fresh CAN readings from all ${definitions.length} cell-voltage signals.`
            };
        }

        const unit = String(signal.unit || definition.unit).trim().toLowerCase();
        if (unit !== "mv" && unit !== "v") {
            return {
                available: false,
                reason: `Cannot evaluate ${definition.name}: its DBC unit must be mV or V.`
            };
        }
        readings.push({
            name: definition.name,
            valueMv: unit === "v" ? signal.value * 1000 : signal.value
        });
    }

    return { available: true, readings };
}

function createEcuTestRows() {
    const list = $("test-list");
    if (!list) return;

    for (const test of ECU_TESTS) {
        const row = document.createElement("div");
        row.className = "test-row";
        const actions = test.actions
            ? `<div class="checklist">${test.actions.map((action) =>
                `<div class="check-item"><span class="ci-label">${action}</span><span class="pill inactive"><span class="pdot"></span>Unavailable</span></div>`
            ).join("")}</div>`
            : "";
        const inputs = test.inputs
            ? `<div class="ecu-test-inputs">${test.inputs.map((input) =>
                `<div class="field"><label>${input.label}</label><input type="text" placeholder="${input.placeholder}" disabled></div>`
            ).join("")}</div>`
            : "";
        const runButton = test.kind === "cell"
            ? `<button class="btn sm" type="button" data-ecu-run="${test.id}">Run test</button>`
            : "";

        row.innerHTML = `
            <div class="test-row-head" role="button" tabindex="0" aria-expanded="false">
                <svg class="chev" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                <div class="test-name">${test.name}</div>
                <span class="pill inactive" data-ecu-status="${test.id}"><span class="pdot"></span>Not available</span>
            </div>
            <div class="test-detail">
                <div class="test-detail-inner">
                    <div class="test-detail-col" style="flex-basis:100%;">
                        <h4>How to run this test</h4>
                        <ul>${test.instructions.map((instruction) => `<li>${instruction}</li>`).join("")}</ul>
                    </div>
                    <div class="test-detail-col">
                        <h4>${test.kind === "cell" ? "Pass condition" : "Decision logic"}</h4>
                        <p>${test.condition}</p>
                    </div>
                    <div class="test-detail-col">
                        <h4>${test.inputs ? "Required before running" : test.actions ? "Live status" : "Result"}</h4>
                        ${inputs}
                        ${actions}
                        <div class="test-result-msg" data-ecu-result="${test.id}"></div>
                        ${runButton}
                    </div>
                </div>
            </div>`;
        list.appendChild(row);

        const header = row.querySelector(".test-row-head");
        const toggle = () => {
            const detail = row.querySelector(".test-detail");
            const open = !detail.classList.contains("open");
            list.querySelectorAll(".test-detail.open").forEach((openDetail) => {
                openDetail.classList.remove("open");
                openDetail.previousElementSibling.querySelector(".chev").classList.remove("open");
                openDetail.previousElementSibling.setAttribute("aria-expanded", "false");
            });
            detail.classList.toggle("open", open);
            header.querySelector(".chev").classList.toggle("open", open);
            header.setAttribute("aria-expanded", String(open));
        };
        header.addEventListener("click", toggle);
        header.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggle();
            }
        });
    }

    list.querySelector('[data-ecu-run="cell-spread"]').addEventListener("click", runCellVoltageTest);
}

function setEcuTestResult(id, status, message) {
    state.ecuTestResults.set(id, { status, message });
    renderEcuTests();
}

function runCellVoltageTest() {
    const data = getCellVoltageReadings();
    if (!data.available) {
        setEcuTestResult("cell-spread", "idle", data.reason);
        return;
    }

    const minimum = data.readings.reduce((a, b) => a.valueMv <= b.valueMv ? a : b);
    const maximum = data.readings.reduce((a, b) => a.valueMv >= b.valueMv ? a : b);
    const spread = maximum.valueMv - minimum.valueMv;
    const passed = spread < ECU_CELL_SPREAD_LIMIT_MV;
    const format = (value) => `${Number(value.toFixed(1))}mV`;
    const measuredRange = `Lowest ${minimum.name} ${format(minimum.valueMv)}; highest ${maximum.name} ${format(maximum.valueMv)}.`;
    const message = passed
        ? `Delta voltage ${format(spread)} is within the <200mV limit. ${measuredRange} Cell voltage imbalance not predicted.`
        : `Delta voltage ${format(spread)} is not within the <200mV limit. ${measuredRange} Cell voltage imbalance predicted — flag for inspection.`;
    setEcuTestResult("cell-spread", passed ? "pass" : "fail", message);
}

function renderEcuTests() {
    const list = $("test-list");
    if (!list) return;
    if (!list.children.length) createEcuTestRows();

    const cellData = getCellVoltageReadings();
    for (const test of ECU_TESTS) {
        const result = state.ecuTestResults.get(test.id);
        const status = list.querySelector(`[data-ecu-status="${test.id}"]`);
        const resultElement = list.querySelector(`[data-ecu-result="${test.id}"]`);
        const runButton = list.querySelector(`[data-ecu-run="${test.id}"]`);

        if (result) {
            status.className = `pill ${result.status === "pass" || result.status === "fail" ? result.status : "inactive"}`;
            status.innerHTML = `<span class="pdot"></span>${result.status === "pass" ? "Pass" : result.status === "fail" ? "Fail" : "Not available"}`;
            resultElement.textContent = result.message;
            resultElement.className = `test-result-msg${result.status === "pass" || result.status === "fail" ? ` ${result.status}` : ""}`;
            if (runButton) runButton.disabled = !cellData.available;
        } else if (test.kind === "cell") {
            status.className = `pill ${cellData.available ? "idle" : "inactive"}`;
            status.innerHTML = `<span class="pdot"></span>${cellData.available ? "Not run" : "Not available"}`;
            resultElement.textContent = cellData.available
                ? "Ready. Run the test to evaluate the current live cell-voltage readings."
                : cellData.reason;
            if (runButton) runButton.disabled = !cellData.available;
        } else {
            status.className = "pill inactive";
            status.innerHTML = '<span class="pdot"></span>Not available';
            resultElement.textContent = test.unavailable;
        }
    }
}

// ---------------------------------------------------------------- rendering
function formatValue(sig) {
    if (typeof sig.display === "string") return sig.display;
    const v = sig.display;
    return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 3 : 2).replace(/\.?0+$/, "");
}

function formatAxisValue(value) {
    if (Number.isInteger(value)) return String(value);
    return Number(value.toPrecision(4)).toString();
}

function drawSignalChart(key, canvas) {
    const sig = state.signals.get(key);
    const history = state.signalHistory.get(key) || [];
    if (!sig || !history.length || canvas.closest(".signal-chart-row").hidden) return;

    const width = canvas.clientWidth;
    if (!width) return;

    const height = SIGNAL_CHART_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const margin = { left: 88, right: 24, top: 48, bottom: 42 };
    const plot = { left: margin.left, right: width - margin.right, top: margin.top, bottom: height - margin.bottom };
    const plotWidth = plot.right - plot.left;
    const plotHeight = plot.bottom - plot.top;
    if (plotWidth <= 0 || plotHeight <= 0) return;

    const firstTime = history[0].time;
    const lastTime = history[history.length - 1].time;
    const timeSpan = lastTime - firstTime;
    let min = Math.min(...history.map((point) => point.value));
    let max = Math.max(...history.map((point) => point.value));
    const padding = min === max ? Math.abs(min) * 0.05 || 1 : (max - min) * 0.08;
    min -= padding;
    max += padding;

    context.font = "12px Inter, sans-serif";
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.fillStyle = "#e7e9ea";
    context.fillText(`Graph View · ${sig.name}`, 16, 17);
    context.fillStyle = "#e8a33d";
    context.font = "600 13px Inter, sans-serif";
    context.fillText(`${formatValue(sig)}${sig.unit ? ` ${sig.unit}` : ""}`, 16, 36);

    context.lineWidth = 1;
    context.textAlign = "right";
    for (let tick = 0; tick <= 4; tick++) {
        const ratio = tick / 4;
        const y = plot.bottom - ratio * plotHeight;
        context.strokeStyle = "#33393f";
        context.beginPath();
        context.moveTo(plot.left, y);
        context.lineTo(plot.right, y);
        context.stroke();
        context.fillStyle = "#8a9199";
        context.fillText(formatAxisValue(min + ratio * (max - min)), plot.left - 8, y);
    }

    context.save();
    context.translate(14, plot.top + plotHeight / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = "center";
    context.fillStyle = "#8a9199";
    context.fillText(sig.unit ? `Value (${sig.unit})` : "Value", 0, 0);
    context.restore();

    context.strokeStyle = "#e8a33d";
    context.lineWidth = 2;
    context.beginPath();
    history.forEach((point, index) => {
        const ratio = timeSpan
            ? (point.time - firstTime) / timeSpan
            : history.length > 1 ? index / (history.length - 1) : 0.5;
        const x = plot.left + ratio * plotWidth;
        const y = plot.bottom - ((point.value - min) / (max - min)) * plotHeight;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
    });
    context.stroke();

    if (history.length === 1) {
        const y = plot.bottom - ((history[0].value - min) / (max - min)) * plotHeight;
        context.fillStyle = "#e8a33d";
        context.beginPath();
        context.arc(plot.left + plotWidth / 2, y, 4, 0, Math.PI * 2);
        context.fill();
    }

    context.font = "11px Inter, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = "#8a9199";
    for (let tick = 0; tick <= 4; tick++) {
        const ratio = tick / 4;
        const x = plot.left + ratio * plotWidth;
        const time = firstTime + ratio * timeSpan;
        context.strokeStyle = "#33393f";
        context.beginPath();
        context.moveTo(x, plot.top);
        context.lineTo(x, plot.bottom);
        context.stroke();
        context.fillText(new Date(time).toLocaleTimeString([], { hour12: false }), x, plot.bottom + 7);
    }
    context.fillText("Time", plot.left + plotWidth / 2, height - 14);
}

function formatSignalRange(sig) {
    if (!Number.isFinite(sig.min) || !Number.isFinite(sig.max)) return "—";
    const range = `${formatAxisValue(sig.min)}–${formatAxisValue(sig.max)}`;
    return sig.unit ? `${range} ${sig.unit}` : range;
}

function renderSignals() {
    const grid = $("signalGrid");
    const filter = $("signalSearch").value.trim().toLowerCase();
    const now = Date.now();

    if (!state.signals.size && state.firstUnmatchedFrame) {
        const { canId, extended, messageName } = state.firstUnmatchedFrame;
        const reason = messageName === "CAN format mismatch"
            ? "this ID is in the DBC but its standard/extended format differs"
            : "this ID is not in the DBC";
        const hint = grid.querySelector(".bc-empty");
        if (hint) {
            hint.textContent =
                `CAN frames are arriving, but none match the loaded DBC. First unmatched: ${canId} ${extended ? "EXT" : "STD"} — ${reason}. Check that the adapter is connected to the BMS CAN bus and that its bitrate matches the vehicle.`;
        }
    }

    const keys = [...state.signals.keys()].sort();
    if (keys.length && grid.querySelector(".bc-empty")) {
        grid.innerHTML =
            '<table class="signal-table"><thead><tr>' +
            '<th scope="col">Graph View</th><th scope="col">Signal</th><th scope="col">Value</th>' +
            '<th scope="col" title="Limits defined in the DBC; not diagnostic safety thresholds.">Threshold / DBC range</th>' +
            '</tr></thead><tbody></tbody></table>';
    }
    const body = grid.querySelector(".signal-table tbody");
    for (const key of keys) {
        const sig = state.signals.get(key);
        let signalRow = state.signalRows.get(key);
        if (!signalRow) {
            const row = document.createElement("tr");
            row.className = "signal-table-row";
            row.dataset.signalKey = key;
            const graphCell = document.createElement("td");
            const graphButton = document.createElement("button");
            graphButton.type = "button";
            graphButton.className = "btn ghost sm graph-view-btn";
            graphButton.textContent = "Graph View";
            graphButton.setAttribute("aria-expanded", "false");
            graphButton.setAttribute("aria-label", `Show graph for ${sig.name}`);
            graphCell.appendChild(graphButton);
            row.appendChild(graphCell);
            for (const className of ["signal-table-name", "signal-table-value", "signal-table-range"]) {
                const cell = document.createElement("td");
                cell.className = className;
                row.appendChild(cell);
            }
            const chartRow = document.createElement("tr");
            chartRow.className = "signal-chart-row";
            chartRow.dataset.signalKey = key;
            chartRow.hidden = true;
            const chartCell = document.createElement("td");
            chartCell.colSpan = 4;
            chartCell.innerHTML =
                '<div class="signal-chart-container">' +
                '<div class="signal-chart-heading"><h3 class="signal-chart-title"></h3>' +
                '<div class="signal-chart-current"></div><time class="signal-chart-time"></time></div>' +
                '<p class="signal-chart-empty">Waiting for numeric CAN samples for this signal…</p>' +
                '<canvas class="signal-chart-canvas" aria-label="Real-time decoded signal graph"></canvas>' +
                '</div>';
            chartRow.appendChild(chartCell);
            graphButton.addEventListener("click", () => {
                const expanded = graphButton.getAttribute("aria-expanded") !== "true";
                graphButton.setAttribute("aria-expanded", String(expanded));
                graphButton.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} graph for ${state.signals.get(key).name}`);
                chartRow.hidden = !expanded || row.hidden;
                if (expanded) {
                    const hasHistory = (state.signalHistory.get(key) || []).length > 0;
                    chartRow.querySelector(".signal-chart-empty").hidden = hasHistory;
                    drawSignalChart(key, chartRow.querySelector("canvas"));
                }
            });
            const nextSignal = [...state.signalRows.entries()]
                .find(([existingKey]) => existingKey.localeCompare(key) > 0)?.[1];
            body.insertBefore(row, nextSignal?.row || null);
            body.insertBefore(chartRow, nextSignal?.row || null);
            signalRow = { row, chartRow, graphButton };
            state.signalRows.set(key, signalRow);
        }
        const { row, chartRow } = signalRow;
        row.querySelector(".signal-table-name").textContent = sig.name;
        row.querySelector(".signal-table-value").textContent = `${formatValue(sig)}${sig.unit ? ` ${sig.unit}` : ""}`;
        row.querySelector(".signal-table-range").textContent = formatSignalRange(sig);
        row.classList.toggle("stale", now - sig.updatedAt > STALE_MS);
        const filtered = Boolean(filter && !key.toLowerCase().includes(filter));
        row.hidden = filtered;
        chartRow.hidden = filtered || signalRow.graphButton.getAttribute("aria-expanded") !== "true";
        const chartTitle = chartRow.querySelector(".signal-chart-title");
        chartTitle.textContent = `Graph View · ${sig.name}`;
        chartRow.querySelector(".signal-chart-current").textContent =
            `Value: ${formatValue(sig)}${sig.unit ? ` ${sig.unit}` : ""}`;
        chartRow.querySelector(".signal-chart-time").textContent =
            `Updated ${new Date(sig.updatedAt).toLocaleTimeString([], { hour12: false })}`;
        const history = state.signalHistory.get(key) || [];
        chartRow.querySelector(".signal-chart-empty").hidden = history.length > 0;
        if (!chartRow.hidden) drawSignalChart(key, chartRow.querySelector("canvas"));
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

function renderUnmatchedInfo() {
    const hidden = state.unmatchedIds.size;
    $("unmatchedInfo").textContent = hidden && $("onlyDbc").checked
        ? `(${hidden} ID${hidden === 1 ? "" : "s"} not in DBC hidden)`
        : "";
    $("unmatchedInfo").title = [...state.unmatchedIds].sort().join(", ");
}

setInterval(() => {
    renderSignals();
    renderRaw();
    renderUnmatchedInfo();
    renderEcuTests();
}, 250);

setInterval(() => {
    state.framesThisSecond = 0;
    if (state.transport && state.lastFrameAt && Date.now() - state.lastFrameAt > STALE_MS) {
        const text = "Connected · no CAN traffic for 3 s (check bus power, wiring, bitrate)";
        $("statusText").textContent = text;
        $("statusDot").className = "bc-dot warn";
        updateSidebarStatus(text, "warn");
    } else if (state.transport && state.lastFrameAt) {
        const text = "Connected · receiving CAN frames";
        $("statusText").textContent = text;
        $("statusDot").className = "bc-dot ok";
        updateSidebarStatus(text, "ok");
    }
}, 1000);

$("signalSearch").addEventListener("input", renderSignals);
window.addEventListener("resize", renderSignals);
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
    $("transportNotice").hidden = $("transportSelect").value !== "sim";
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

const screenTitles = {
    dashboard: ["Dashboard", "Live vehicle overview"],
    ecu: ["ECU Tests", "Run and review individual ECU checks"],
    live: ["Live Data", "Real-time values decoded from received CAN frames"],
    "vm-repair": ["Repair & Maintenance", "Repair workflow unavailable"],
    "vm-errors": ["Error Code Correction", "Vehicle DTC service unavailable"],
    "vm-software": ["Software Update", "Firmware service unavailable"],
    "vm-parts": ["Part Mapping", "Parts catalogue service unavailable"]
};

function goScreen(id) {
    const title = screenTitles[id];
    if (!title) return;
    document.querySelectorAll(".screen").forEach((screen) => {
        screen.classList.toggle("active", screen.id === `screen-${id}`);
    });
    document.querySelectorAll(".nav-item[data-screen], .nav-sub-item[data-screen]").forEach((item) => {
        item.classList.toggle("active", item.dataset.screen === id);
    });
    $("page-title").textContent = title[0];
    $("page-crumb").textContent = title[1];
    document.querySelector(".content").scrollTop = 0;
}

document.querySelectorAll("[data-screen]").forEach((item) => {
    item.addEventListener("click", () => goScreen(item.dataset.screen));
});

$("vm-toggle").addEventListener("click", () => {
    const open = $("vm-sub").classList.toggle("open");
    $("vm-caret").classList.toggle("open", open);
    $("vm-toggle").setAttribute("aria-expanded", String(open));
});

renderEcuTests();
updateSidebarStatus("Adapter disconnected.", "idle");
