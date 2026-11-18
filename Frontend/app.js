
import { parseDbc, decodeMessage, encodeRandom } from "./dbc.js";
import { SlcanTransport, PcanUsbTransport, SimulatorTransport } from "./transports.js";

const DBC_ECUS = ["BMS", "MCU", "TCU", "MiddleWare"];
const DBC_SOURCE_FOR_TAB = { Cluster: "MCU" };
const DBC_PROXY_URL = "/api/dbc-file";
const RAW_ROWS = 200;
const STALE_MS = 3000;
const MAX_SIGNAL_HISTORY = 120;
const SIGNAL_CHART_HEIGHT = 340;
const GRAPH_AXIS_WIDTH = 58;

const $ = (id) => document.getElementById(id);

const state = {
    dbc: null,
    dbcs: new Map(),
    dbcStatuses: new Map(),
    dbcVersionNotice: "",
    activeEcu: "BMS",
    dbcLoading: false,
    transport: null,
    totalFrames: 0,
    decodedFrames: 0,
    framesThisSecond: 0,
    uniqueIds: new Set(),
    signals: new Map(),
    signalRows: new Map(),
    signalHistory: new Map(),
    graphSignals: new Set(),
    graphColors: new Map(),
    nextGraphColor: 0,
    graphPaused: false,
    graphClearAfter: 0,
    graphPickerSignature: "",
    graphLegendSignature: "",
    graphDomain: null,
    graphHoverPosition: null,
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
function rebuildCombinedDbc() {
    const messages = new Map();
    let signalCount = 0;
    for (const ecu of DBC_ECUS) {
        const dbc = state.dbcs.get(ecu);
        if (!dbc) continue;
        signalCount += dbc.signalCount;
        for (const [key, message] of dbc.messages) {
            messages.set(`${ecu}:${key}`, message);
        }
    }
    state.dbc = state.dbcs.size
        ? { messages, messageCount: messages.size, signalCount }
        : null;
}

function useDbc(ecu, dbc) {
    const affectedEcus = ecu === "MCU" ? ["MCU", "Cluster"] : [ecu];
    for (const key of state.signals.keys()) {
        if (!affectedEcus.some((affectedEcu) => key.startsWith(`${affectedEcu}.`))) continue;
        state.signals.delete(key);
        state.signalHistory.delete(key);
        state.signalRows.delete(key);
        state.graphSignals.delete(key);
    }
    for (const [key, row] of state.signalRows) {
        if (affectedEcus.some((affectedEcu) => key.startsWith(`${affectedEcu}.`))) {
            row.row.remove();
            row.chartRow.remove();
            state.signalRows.delete(key);
        }
    }
    for (const message of dbc.messages.values()) {
        message.ecu = ecu;
    }
    state.dbcs.set(ecu, dbc);
    rebuildCombinedDbc();
    if (ecu === "BMS") state.ecuTestResults.clear();
    state.firstUnmatchedFrame = null;
    state.graphPickerSignature = "";
    state.graphLegendSignature = "";
    state.graphDomain = null;
    state.graphHoverPosition = null;
    state.signalRows.clear();
    $("signalGrid").innerHTML = '<div class="bc-empty">Waiting for decoded CAN frames…</div>';
    renderSignals();
    renderGraphSignalPicker(true);
    renderGraphView(true);
    renderEcuTabs();
    renderEcuTests();
    log(`${ecu} DBC loaded: ${dbc.messageCount} messages, ${dbc.signalCount} signals.`);
}

function renderEcuTabs() {
    for (const tab of $("ecuTabs").querySelectorAll("[data-ecu-tab]")) {
        const selected = tab.dataset.ecuTab === state.activeEcu;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
        const source = DBC_SOURCE_FOR_TAB[tab.dataset.ecuTab] || tab.dataset.ecuTab;
        const dbc = state.dbcs.get(source);
        const unavailable = tab.dataset.ecuTab === "Cluster" && !dbc;
        tab.disabled = unavailable;
        tab.setAttribute("aria-disabled", String(unavailable));
        tab.classList.toggle("unavailable", unavailable);
        tab.title = dbc
            ? tab.dataset.ecuTab === "Cluster"
                ? `Using MCU DBC · ${dbc.messageCount} messages · ${dbc.signalCount} signals`
                : `${dbc.messageCount} messages · ${dbc.signalCount} signals loaded`
            : tab.dataset.ecuTab === "Cluster"
                ? "Load the MCU DBC to use it for Cluster"
                : `Load the ${tab.dataset.ecuTab} DBC to decode its signals`;
    }
}

function renderDbcInfo() {
    if (state.dbcVersionNotice) {
        $("dbcInfo").textContent = state.dbcVersionNotice;
        return;
    }

    const lines = DBC_ECUS.filter((ecu) => state.dbcStatuses.has(ecu)).map((ecu) => {
        const status = state.dbcStatuses.get(ecu);
        if (status.loading) {
            return `${ecu}: Loading…${status.previous ? " (existing DBC remains active)" : ""}`;
        }
        if (status.error) {
            const previous = status.previous
                ? ` Previous DBC remains active (${status.previous.messages} messages, ${status.previous.signals} signals).`
                : "";
            return `${ecu}: Could not load — ${status.error}.${previous}`;
        }
        return `${ecu}: Loaded ${status.messages} messages, ${status.signals} signals`;
    });
    const summary = lines.length ? lines.join("\n") : "No DBC loaded.";
    $("dbcInfo").textContent = summary;
}

function parseDbcText(text) {
    const hasMessageDefinition =
        typeof text === "string" && /^\s*BO_\s+\d+\s+\w+\s*:\s*\d+\s+\w+/m.test(text);
    const hasSignalDefinition =
        typeof text === "string" && /^\s*SG_\s+\w+\s*(?:M|m\d+M?)?\s*:\s*\d+\|\d+@[01][+-]/m.test(text);
    if (!hasMessageDefinition || !hasSignalDefinition) {
        throw new Error("Downloaded content is not a valid DBC file.");
    }
    const dbc = parseDbc(text);
    if (!dbc.messageCount || !dbc.signalCount) {
        throw new Error("The DBC file must contain at least one message and one signal.");
    }
    return dbc;
}

async function fetchDbcFromServer(ecu) {
    return fetchDbcText(`${DBC_PROXY_URL}/${encodeURIComponent(ecu)}`);
}

async function fetchVersion2BmsDbc() {
    return fetchDbcText(`${DBC_PROXY_URL}/version2`);
}

async function fetchDbcText(url) {
    const response = await fetch(url);
    if (!response.ok) {
        const detail = response.headers.get("content-type")?.includes("application/json")
            ? (await response.json()).detail
            : await response.text();
        throw new Error(`Server returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response.text();
}

function setDbcLoading(loading) {
    state.dbcLoading = loading;
    $("loadAllDbcBtn").disabled = loading;
    $("version2DbcBtn").disabled = loading;
}

async function loadDbc(ecu, fetchText = () => fetchDbcFromServer(ecu)) {
    const currentDbc = state.dbcs.get(ecu);
    const previous = currentDbc
        ? { messages: currentDbc.messageCount, signals: currentDbc.signalCount }
        : null;
    state.dbcStatuses.set(ecu, { loading: true, previous });
    renderDbcInfo();
    try {
        const dbc = parseDbcText(await fetchText());
        useDbc(ecu, dbc);
        state.dbcStatuses.set(ecu, {
            messages: dbc.messageCount,
            signals: dbc.signalCount
        });
        return { ecu, dbc };
    } catch (error) {
        state.dbcStatuses.set(ecu, { error: error.message, previous });
        log(`${ecu} DBC download error: ${error.message}`);
        return { ecu, error };
    } finally {
        renderDbcInfo();
    }
}

$("loadAllDbcBtn").addEventListener("click", async () => {
    state.dbcVersionNotice = "";
    if (state.dbcLoading) {
        renderDbcInfo();
        return;
    }
    setDbcLoading(true);
    await Promise.all(DBC_ECUS.map((ecu) => loadDbc(ecu)));
    setDbcLoading(false);
});
$("version2DbcBtn").addEventListener("click", async () => {
    if (state.dbcLoading) return;
    state.dbcVersionNotice = "";
    state.dbcStatuses.clear();
    setDbcLoading(true);
    await loadDbc("BMS", fetchVersion2BmsDbc);
    setDbcLoading(false);
});
$("version3DbcBtn").addEventListener("click", () => {
    state.dbcVersionNotice = "Version-3 DBC files are not available.";
    state.dbcStatuses.clear();
    renderDbcInfo();
});
$("ecuTabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-ecu-tab]");
    if (!tab || tab.disabled) return;
    if (state.activeEcu !== tab.dataset.ecuTab) {
        state.activeEcu = tab.dataset.ecuTab;
        $("signalSearch").value = "";
        state.signalRows.clear();
        $("signalGrid").innerHTML = '<div class="bc-empty"></div>';
    }
    renderEcuTabs();
    renderSignals();
});

// ---------------------------------------------------------------- frames
function hex(n, width) {
    return n.toString(16).toUpperCase().padStart(width, "0");
}

function resolveFrameMessage(frame) {
    const sameFormat = [];
    for (const ecu of DBC_ECUS) {
        const dbc = state.dbcs.get(ecu);
        if (!dbc) continue;
        const message = dbc.getMessage(frame.id, frame.extended);
        if (message) sameFormat.push({ ecu, message });
    }
    if (!sameFormat.length) {
        const idExists = [...state.dbcs.values()].some((dbc) => dbc.findById(frame.id));
        return { error: idExists ? "CAN format mismatch" : "Not in DBC" };
    }

    const matchingDlc = sameFormat.filter(({ message }) => message.dlc === frame.dlc);
    if (matchingDlc.length === 1) return { messages: matchingDlc };
    if (matchingDlc.length > 1 && canDecodeDbcAliasesTogether(matchingDlc)) {
        return { messages: matchingDlc };
    }
    if (matchingDlc.length > 1) return { error: "Ambiguous DBC match" };
    // Keep decoding a unique ID/format match even when the reported DLC differs.
    if (sameFormat.length === 1) return { messages: sameFormat };
    return { error: "CAN DLC mismatch" };
}

function signalKeysForEcu(ecu, message, signal) {
    const key = `${ecu}.${message}.${signal}`;
    return ecu === "MCU" ? [key, `Cluster.${message}.${signal}`] : [key];
}

function signalBitPositions(signal) {
    const positions = [];
    if (signal.littleEndian) {
        for (let index = 0; index < signal.length; index++) {
            positions.push(signal.startBit + index);
        }
    } else {
        const msbLinear = (signal.startBit >> 3) * 8 + (7 - (signal.startBit & 7));
        for (let index = 0; index < signal.length; index++) {
            const position = msbLinear + index;
            positions.push((position >> 3) * 8 + (7 - (position & 7)));
        }
    }
    return new Set(positions);
}

function sameSignalEncoding(left, right) {
    if (left.startBit !== right.startBit ||
        left.length !== right.length ||
        left.littleEndian !== right.littleEndian ||
        left.signed !== right.signed ||
        left.factor !== right.factor ||
        left.offset !== right.offset ||
        left.valueType !== right.valueType ||
        left.muxValue !== right.muxValue ||
        left.isMultiplexor !== right.isMultiplexor) {
        return false;
    }
    const leftBits = signalBitPositions(left);
    const rightBits = signalBitPositions(right);
    return leftBits.size === rightBits.size &&
        [...leftBits].every((position) => rightBits.has(position));
}

function canDecodeDbcAliasesTogether(candidates) {
    // Shared IDs are decoded into both ECU namespaces only when overlapping bits agree.
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex++) {
            const leftSignals = candidates[leftIndex].message.signals;
            const rightSignals = candidates[rightIndex].message.signals;
            for (const left of leftSignals) {
                const leftBits = signalBitPositions(left);
                for (const right of rightSignals) {
                    const rightBits = signalBitPositions(right);
                    const overlaps = [...leftBits].some((position) => rightBits.has(position));
                    if (overlaps && !sameSignalEncoding(left, right)) return false;
                }
            }
        }
    }
    return true;
}

function handleFrame(frame) {
    const now = Date.now();
    state.totalFrames++;
    state.framesThisSecond++;
    state.lastFrameAt = now;

    const canId = `0x${hex(frame.id, frame.extended ? 8 : 3)}`;
    state.uniqueIds.add(`${frame.extended ? "x" : "s"}${frame.id}`);

    let messageName = "Not in DBC";
    if (state.dbcs.size && !frame.rtr) {
        const resolved = resolveFrameMessage(frame);
        if (resolved.messages) {
            messageName = resolved.messages
                .map(({ ecu, message }) => `${ecu} · ${message.name}`)
                .join(" / ");
            state.decodedFrames++;
            for (const { ecu, message } of resolved.messages) {
                for (const sig of decodeMessage(message, frame.data)) {
                    const decoded = {
                        ...sig, ecu, message: message.name, canId, updatedAt: now
                    };
                    for (const key of signalKeysForEcu(ecu, message.name, sig.name)) {
                        const aliasEcu = key.startsWith("Cluster.") ? "Cluster" : ecu;
                        state.signals.set(key, { ...decoded, ecu: aliasEcu });
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
                }
            }
        } else {
            messageName = resolved.error;
        }
    } else if (!state.dbcs.size) {
        messageName = "DBC not loaded";
    }

    const matched = messageName !== "Not in DBC" &&
        messageName !== "DBC not loaded" &&
        messageName !== "CAN format mismatch" &&
        messageName !== "CAN DLC mismatch" &&
        messageName !== "Ambiguous DBC match";

    if (!matched) {
        state.unmatchedIds.add(canId);
        if (state.dbcs.size && !state.firstUnmatchedFrame) {
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
    const bmsDbc = state.dbcs.get("BMS");
    if (!bmsDbc) return [];
    return [...bmsDbc.messages.values()].flatMap((message) =>
        message.signals
            .filter((signal) => /^cell\d+volt$/i.test(signal.name.replace(/[^a-z\d]/gi, "")))
            .map((signal) => ({
                key: `BMS.${message.name}.${signal.name}`,
                name: signal.name,
                unit: signal.unit
            }))
    );
}

function getCellVoltageReadings() {
    if (!state.dbcs.has("BMS")) {
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

function signalLabel(sig) {
    return sig.ecu ? `${sig.ecu} · ${sig.name}` : sig.name;
}

function graphHistoryFor(key) {
    return (state.signalHistory.get(key) || []).filter((point) => point.time >= state.graphClearAfter);
}

function graphColorFor(key) {
    if (!state.graphColors.has(key)) {
        const index = state.nextGraphColor++;
        state.graphColors.set(key, `hsl(${(index * 137.508) % 360} 72% 62%)`);
    }
    return state.graphColors.get(key);
}

function renderGraphSignalPicker(force = false) {
    const results = $("graphSignalResults");
    const search = $("graphSignalSearch").value.trim().toLowerCase();
    const keys = [...state.signals.keys()].sort();
    const signature = `${search}\n${keys.join("\n")}\n${[...state.graphSignals].sort().join("\n")}`;
    if (!force && signature === state.graphPickerSignature) {
        return;
    }
    state.graphPickerSignature = signature;

    if (!search) {
        results.hidden = true;
        results.replaceChildren();
        return;
    }

    results.hidden = false;
    const matches = keys.filter((key) => {
        const sig = state.signals.get(key);
        return `${sig.name} ${key}`.toLowerCase().includes(search);
    });
    if (!matches.length) {
        results.innerHTML = `<div class="bc-empty">${keys.length ? "No decoded signals match this search." : "Load a DBC and receive decoded CAN frames to select signals."}</div>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const key of matches) {
        const sig = state.signals.get(key);
        const label = document.createElement("label");
        label.className = "graph-signal-option";
        label.dataset.signalKey = key;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = state.graphSignals.has(key);
        checkbox.setAttribute("aria-label", `Plot ${signalLabel(sig)}`);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                state.graphSignals.add(key);
                graphColorFor(key);
            } else {
                state.graphSignals.delete(key);
            }
            state.graphPickerSignature = "";
            state.graphLegendSignature = "";
            renderGraphSignalPicker(true);
            renderGraphView(true);
        });
        const name = document.createElement("span");
        name.className = "graph-signal-option-name";
        name.textContent = signalLabel(sig);
        label.append(checkbox, name);
        fragment.appendChild(label);
    }
    results.replaceChildren(fragment);
}

function renderGraphLegend() {
    const legend = $("graphLegend");
    const keys = [...state.graphSignals];
    const signature = keys.join("\n");
    if (signature !== state.graphLegendSignature) {
        state.graphLegendSignature = signature;
        const fragment = document.createDocumentFragment();
        for (const key of keys) {
            const sig = state.signals.get(key);
            if (!sig) continue;
            const item = document.createElement("div");
            item.className = "graph-legend-item";
            item.dataset.signalKey = key;
            const swatch = document.createElement("span");
            swatch.className = "graph-legend-swatch";
            swatch.style.backgroundColor = graphColorFor(key);
            const name = document.createElement("span");
            name.className = "graph-legend-name";
            name.textContent = signalLabel(sig);
            const current = document.createElement("span");
            current.className = "graph-legend-current";
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "graph-legend-remove";
            remove.textContent = "×";
            remove.setAttribute("aria-label", `Remove ${signalLabel(sig)} from graph`);
            remove.addEventListener("click", () => {
                state.graphSignals.delete(key);
                state.graphPickerSignature = "";
                state.graphLegendSignature = "";
                renderGraphSignalPicker(true);
                renderGraphView(true);
            });
            item.append(swatch, name, current, remove);
            fragment.appendChild(item);
        }
        legend.replaceChildren(fragment);
    }

    const now = Date.now();
    for (const item of legend.children) {
        const key = item.dataset.signalKey;
        const sig = state.signals.get(key);
        if (!sig) continue;
        const current = item.querySelector(".graph-legend-current");
        current.textContent = `${formatValue(sig)}${sig.unit ? ` ${sig.unit}` : ""}`;
        item.classList.toggle("stale", now - sig.updatedAt > STALE_MS);
    }
}

function renderGraphView(force = false) {
    $("graphPauseBtn").disabled = state.graphSignals.size === 0;
    $("graphPauseBtn").textContent = state.graphPaused ? "Resume" : "Pause";
    $("graphPauseBtn").setAttribute("aria-pressed", String(state.graphPaused));
    $("graphClearBtn").disabled = state.graphSignals.size === 0;
    renderGraphSignalPicker();
    renderGraphLegend();

    const canvas = $("graphCanvas");
    const empty = $("graphEmpty");
    if (!state.graphSignals.size) {
        canvas.hidden = true;
        empty.hidden = false;
        empty.textContent = "Search for decoded signals and select them to start plotting.";
        state.graphDomain = null;
        $("graphTooltip").hidden = true;
        return;
    }
    if ((state.graphPaused && !force) || !$("screen-graph").classList.contains("active")) return;
    if (state.graphHoverPosition) updateGraphTooltip(state.graphHoverPosition);
    else drawGraphCanvas();
}

function drawGraphCanvas(hoverTime = null) {
    const canvas = $("graphCanvas");
    const signals = [...state.graphSignals].map((key) => ({
        key,
        sig: state.signals.get(key),
        history: graphHistoryFor(key).filter((point) =>
            Number.isFinite(point.time) && Number.isFinite(point.value)
        )
    })).filter((item) => item.sig);
    const availableHistories = signals.map((item) => item.history).filter((history) => history.length);
    const empty = $("graphEmpty");
    if (!signals.length || !availableHistories.length) {
        canvas.hidden = true;
        empty.hidden = false;
        empty.textContent = state.graphClearAfter
            ? "Waiting for new CAN samples after clearing graph history."
            : "Waiting for numeric decoded CAN samples for the selected signals.";
        state.graphDomain = null;
        return;
    }
    canvas.hidden = false;
    empty.hidden = true;

    const wrap = $("graphCanvasWrap");
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    if (!width || !height) return;
    canvas.style.height = `${height}px`;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const firstTime = Math.min(...availableHistories.map((history) => history[0].time));
    const lastTime = Math.max(...availableHistories.map((history) => history[history.length - 1].time));
    const timeSpan = lastTime - firstTime;
    const plotLeft = 88;
    const plotRight = width - 24 - Math.max(0, signals.length - 1) * GRAPH_AXIS_WIDTH;
    const plotWidth = plotRight - plotLeft;
    const plotTop = 48;
    const plotBottom = height - 46;
    const plotHeight = plotBottom - plotTop;
    if (plotWidth < 120 || plotHeight < 80) {
        canvas.hidden = true;
        empty.hidden = false;
        empty.textContent = "The graph area is too narrow for the selected signals and their value scales. Widen the window or remove signals.";
        state.graphDomain = null;
        return;
    }

    const series = signals.map(({ key, sig, history }) => {
        const color = graphColorFor(key);
        let min = null;
        let max = null;
        if (history.length) {
            min = Math.min(...history.map((point) => point.value));
            max = Math.max(...history.map((point) => point.value));
            const padding = min === max ? Math.abs(min) * 0.05 || 1 : (max - min) * 0.08;
            min -= padding;
            max += padding;
        }
        return { key, sig, history, color, min, max, plotTop, plotBottom };
    });

    context.font = "11px Inter, sans-serif";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = "#8a9199";
    context.fillText("One shared time axis · each colored Y scale matches its signal", plotLeft, 19);

    context.strokeStyle = "#33393f";
    context.lineWidth = 1;
    for (let tick = 0; tick <= 5; tick++) {
        const ratio = tick / 5;
        const y = plotBottom - ratio * plotHeight;
        context.beginPath();
        context.moveTo(plotLeft, y);
        context.lineTo(plotRight, y);
        context.stroke();
        const x = plotLeft + ratio * plotWidth;
        context.beginPath();
        context.moveTo(x, plotTop);
        context.lineTo(x, plotBottom);
        context.stroke();
        context.textAlign = "center";
        context.textBaseline = "top";
        context.fillStyle = "#8a9199";
        context.fillText(
            new Date(firstTime + ratio * timeSpan).toLocaleTimeString([], { hour12: false }),
            x,
            plotBottom + 8
        );
    }

    context.save();
    context.translate(16, plotTop + plotHeight / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#8a9199";
    context.fillText("Signal values · color-coded scales", 0, 0);
    context.restore();

    for (const [index, item] of series.entries()) {
        const axisX = index === 0 ? plotLeft : plotRight + 24 + (index - 1) * GRAPH_AXIS_WIDTH;
        context.strokeStyle = item.color;
        context.fillStyle = item.color;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(axisX, plotTop);
        context.lineTo(axisX, plotBottom);
        context.stroke();
        if (!item.history.length) continue;

        context.font = "10px Inter, sans-serif";
        context.textAlign = index === 0 ? "right" : "left";
        context.textBaseline = "middle";
        for (let tick = 0; tick <= 4; tick++) {
            const ratio = tick / 4;
            const y = plotBottom - ratio * plotHeight;
            const labelX = index === 0 ? axisX - 6 : axisX + 5;
            context.fillText(formatAxisValue(item.min + ratio * (item.max - item.min)), labelX, y, GRAPH_AXIS_WIDTH - 8);
            context.beginPath();
            context.moveTo(axisX - 3, y);
            context.lineTo(axisX + 3, y);
            context.stroke();
        }

        context.save();
        context.translate(axisX, plotTop - 8);
        context.textAlign = "center";
        context.textBaseline = "bottom";
        context.fillText(item.sig.unit || signalLabel(item.sig), 0, 0, GRAPH_AXIS_WIDTH - 8);
        context.restore();

        context.strokeStyle = item.color;
        context.lineWidth = 2;
        context.beginPath();
        let started = false;
        for (const point of item.history) {
            if (!Number.isFinite(point.time) || !Number.isFinite(point.value)) continue;
            const ratio = timeSpan ? (point.time - firstTime) / timeSpan : 1;
            const x = plotLeft + ratio * plotWidth;
            const y = plotBottom - ((point.value - item.min) / (item.max - item.min)) * plotHeight;
            if (!started) {
                context.moveTo(x, y);
                started = true;
            } else {
                context.lineTo(x, y);
            }
        }
        if (started) context.stroke();
    }
    context.font = "11px Inter, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.fillStyle = "#8a9199";
    context.fillText("Time", plotLeft + plotWidth / 2, height - 5);
    state.graphDomain = { firstTime, lastTime, plotLeft, plotRight, plotTop, plotBottom, series };

    if (hoverTime !== null) drawGraphCrosshair(hoverTime);
}

function drawGraphCrosshair(timestamp) {
    const canvas = $("graphCanvas");
    const domain = state.graphDomain;
    if (!domain || canvas.hidden) return;
    const context = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const x = domain.plotLeft + (domain.lastTime === domain.firstTime
        ? 1
        : (timestamp - domain.firstTime) / (domain.lastTime - domain.firstTime)) * (domain.plotRight - domain.plotLeft);
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.strokeStyle = "#d9dde1";
    context.lineWidth = 1;
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(x, domain.plotTop);
    context.lineTo(x, domain.plotBottom);
    context.stroke();
    context.setLineDash([]);
    for (const series of domain.series) {
        if (!series.history.length) continue;
        const point = series.history.reduce((closest, candidate) =>
            Math.abs(candidate.time - timestamp) < Math.abs(closest.time - timestamp) ? candidate : closest
        );
        const y = series.plotBottom - ((point.value - series.min) / (series.max - series.min)) * (series.plotBottom - series.plotTop);
        context.fillStyle = series.color;
        context.beginPath();
        context.arc(x, y, 4, 0, Math.PI * 2);
        context.fill();
    }
    context.restore();
}

function updateGraphTooltip(event) {
    state.graphHoverPosition = { clientX: event.clientX, clientY: event.clientY };
    const canvas = $("graphCanvas");
    const domain = state.graphDomain;
    const tooltip = $("graphTooltip");
    if (!domain || canvas.hidden || state.graphPaused) {
        tooltip.hidden = true;
        return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < domain.plotLeft || x > domain.plotRight) {
        tooltip.hidden = true;
        drawGraphCanvas();
        return;
    }
    const ratio = (x - domain.plotLeft) / (domain.plotRight - domain.plotLeft);
    const timestamp = domain.firstTime + ratio * (domain.lastTime - domain.firstTime);
    drawGraphCanvas(timestamp);

    const closestTime = (history) => history.reduce((closest, point) =>
        Math.abs(point.time - timestamp) < Math.abs(closest.time - timestamp) ? point : closest
    );
    const lines = [`Time: ${new Date(timestamp).toISOString()}`];
    for (const series of domain.series) {
        if (!series.history.length) {
            lines.push(`${signalLabel(series.sig)}: no samples`);
            continue;
        }
        const point = closestTime(series.history);
        lines.push(`${signalLabel(series.sig)}: ${formatAxisValue(point.value)}${series.sig.unit ? ` ${series.sig.unit}` : ""} (${new Date(point.time).toISOString()})`);
    }
    tooltip.textContent = lines.join("\n");
    tooltip.hidden = false;
    const wrap = $("graphCanvasWrap");
    const wrapRect = wrap.getBoundingClientRect();
    const minLeft = wrap.scrollLeft + 8;
    const maxLeft = wrap.scrollLeft + wrap.clientWidth - tooltip.offsetWidth - 8;
    const minTop = wrap.scrollTop + 8;
    const maxTop = wrap.scrollTop + wrap.clientHeight - tooltip.offsetHeight - 8;
    tooltip.style.left = `${Math.max(minLeft, Math.min(maxLeft, event.clientX - wrapRect.left + wrap.scrollLeft + 14))}px`;
    tooltip.style.top = `${Math.max(minTop, Math.min(maxTop, event.clientY - wrapRect.top + wrap.scrollTop + 14))}px`;
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

function getDbcSignalDefinitions() {
    const definitions = [];
    const ecu = state.activeEcu;
    const source = DBC_SOURCE_FOR_TAB[ecu] || ecu;
    const dbc = state.dbcs.get(source);
    if (!dbc) return definitions;

    for (const message of dbc.messages.values()) {
        for (const signal of message.signals) {
            definitions.push({
                key: `${ecu}.${message.name}.${signal.name}`,
                signal: { ...signal, ecu, sourceEcu: source, message: message.name }
            });
        }
    }
    return definitions.sort((left, right) => left.key.localeCompare(right.key));
}

function renderSignals() {
    const grid = $("signalGrid");
    const filter = $("signalSearch").value.trim().toLowerCase();
    const now = Date.now();
    const definitions = getDbcSignalDefinitions();

    if (!state.signals.size && state.firstUnmatchedFrame) {
        const { canId, extended, messageName } = state.firstUnmatchedFrame;
        const reasons = {
            "CAN format mismatch": "this ID exists in a DBC but its standard/extended format differs",
            "CAN DLC mismatch": "this ID and frame format match, but the received DLC does not match the DBC",
            "Ambiguous DBC match": "multiple loaded DBCs define this ID and frame format with the same DLC"
        };
        const reason = reasons[messageName] || "this ID is not in a loaded DBC";
        const hint = grid.querySelector(".bc-empty");
        if (hint) {
            hint.textContent =
                `CAN frames are arriving, but none match a loaded DBC. First unmatched: ${canId} ${extended ? "EXT" : "STD"} — ${reason}. Check the adapter, bus bitrate and loaded ECU DBCs.`;
        }
    }

    const keys = definitions.map(({ key }) => key);
    const table = grid.querySelector(".signal-table");
    if (!definitions.length && !table) {
        const hint = grid.querySelector(".bc-empty");
        if (hint && !state.firstUnmatchedFrame) {
            const source = DBC_SOURCE_FOR_TAB[state.activeEcu] || state.activeEcu;
            hint.textContent = state.dbcs.has(source)
                ? `Waiting for live ${state.activeEcu} signals from incoming CAN frames…`
                : state.activeEcu === "Cluster"
                    ? "Load the MCU DBC to use its signal definitions in the Cluster tab."
                    : `Load the ${state.activeEcu} DBC and connect an adapter to view its live signals.`;
        }
        return;
    }
    if (definitions.length && !table) {
        grid.innerHTML =
            '<table class="signal-table"><thead><tr>' +
            '<th scope="col">Graph View</th><th scope="col">Signal</th><th scope="col">Value</th>' +
            '<th scope="col" title="Limits defined in the DBC; not diagnostic safety thresholds.">Threshold / DBC range</th>' +
            '</tr></thead><tbody></tbody></table>';
    }
    const body = grid.querySelector(".signal-table tbody");
    if (!body) return;
    let visibleCount = 0;
    for (const { key, signal: definition } of definitions) {
        const liveSignal = state.signals.get(key);
        const sig = liveSignal ? { ...definition, ...liveSignal } : definition;
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
            graphButton.setAttribute("aria-label", `Show graph for ${signalLabel(sig)}`);
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
                graphButton.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} graph for ${signalLabel(definition)}`);
                chartRow.hidden = !expanded || row.hidden;
                if (expanded) {
                    const hasHistory = (state.signalHistory.get(key) || []).length > 0;
                    chartRow.querySelector(".signal-chart-empty").textContent =
                        hasHistory ? "" : "Waiting for data before a graph can be drawn.";
                    chartRow.querySelector(".signal-chart-empty").hidden = hasHistory;
                    chartRow.querySelector("canvas").hidden = !hasHistory;
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
        const valueCell = row.querySelector(".signal-table-value");
        valueCell.textContent = liveSignal
            ? `${formatValue(sig)}${sig.unit ? ` ${sig.unit}` : ""}`
            : "Waiting for data";
        valueCell.classList.toggle("waiting", !liveSignal);
        row.querySelector(".signal-table-range").textContent = formatSignalRange(sig);
        row.classList.toggle("stale", Boolean(liveSignal && now - liveSignal.updatedAt > STALE_MS));
        const filtered = Boolean(filter && !key.toLowerCase().includes(filter));
        row.hidden = filtered;
        chartRow.hidden = filtered || signalRow.graphButton.getAttribute("aria-expanded") !== "true";
        const chartTitle = chartRow.querySelector(".signal-chart-title");
        chartTitle.textContent = `Graph View · ${signalLabel(sig)}`;
        chartRow.querySelector(".signal-chart-current").textContent =
            liveSignal
                ? `Value: ${formatValue(sig)}${sig.unit ? ` ${sig.unit}` : ""}`
                : "Waiting for data";
        chartRow.querySelector(".signal-chart-time").textContent = liveSignal
            ? `Updated ${new Date(liveSignal.updatedAt).toLocaleTimeString([], { hour12: false })}`
            : "No CAN sample received";
        const history = state.signalHistory.get(key) || [];
        chartRow.querySelector(".signal-chart-empty").textContent =
            history.length ? "No numeric samples available for this signal." : "Waiting for data before a graph can be drawn.";
        chartRow.querySelector(".signal-chart-empty").hidden = history.length > 0;
        chartRow.querySelector("canvas").hidden = history.length === 0;
        if (!filtered) {
            visibleCount++;
            if (!chartRow.hidden && history.length) drawSignalChart(key, chartRow.querySelector("canvas"));
        }
    }
    let emptyMessage = grid.querySelector(".signal-empty-message");
    if (!emptyMessage) {
        emptyMessage = document.createElement("div");
        emptyMessage.className = "bc-empty signal-empty-message";
        grid.appendChild(emptyMessage);
    }
    emptyMessage.hidden = visibleCount > 0;
    const activeSource = DBC_SOURCE_FOR_TAB[state.activeEcu] || state.activeEcu;
    emptyMessage.textContent = !state.dbcs.has(activeSource)
        ? state.activeEcu === "Cluster"
            ? "Load the MCU DBC to use its signal definitions in the Cluster tab."
            : `Load the ${state.activeEcu} DBC to decode its signals.`
            : !definitions.length
                ? `The ${state.activeEcu} DBC contains no signal definitions.`
            : filter
                ? `No ${state.activeEcu} signals match this search.`
                : `Waiting for live ${state.activeEcu} signals from incoming CAN frames…`;
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
    renderGraphView();
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
$("graphSignalSearch").addEventListener("input", () => renderGraphSignalPicker(true));
$("graphPauseBtn").addEventListener("click", () => {
    state.graphPaused = !state.graphPaused;
    state.graphHoverPosition = null;
    $("graphTooltip").hidden = true;
    renderGraphView(true);
});
$("graphClearBtn").addEventListener("click", () => {
    state.graphClearAfter = Date.now();
    state.graphHoverPosition = null;
    $("graphTooltip").hidden = true;
    renderGraphView(true);
});
$("graphCanvas").addEventListener("mousemove", updateGraphTooltip);
$("graphCanvas").addEventListener("mouseleave", () => {
    state.graphHoverPosition = null;
    $("graphTooltip").hidden = true;
    if (!state.graphPaused) drawGraphCanvas();
});
window.addEventListener("resize", () => renderGraphView(true));
new ResizeObserver(() => {
    if ($("screen-graph").classList.contains("active") && !state.graphPaused) drawGraphCanvas();
}).observe($("graphCanvasWrap"));
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

        log("Recording started (one row per decoded CAN frame).");

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
    graph: ["Graph View", "Live decoded CAN signal trends"],
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
    if (id === "graph") renderGraphView();
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
renderGraphSignalPicker(true);
