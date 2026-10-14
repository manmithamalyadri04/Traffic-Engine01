// OmniFlow Dynamic Traffic Controller
// Supports both Backend WebSocket Sync and Fallback In-Browser Simulation Engine

const canvas = document.getElementById("traffic-canvas");
const ctx = canvas.getContext("2d");

const CX = canvas.width / 2; // 375
const CY = canvas.height / 2; // 375
const ROAD_HALF = 70; // 140px wide roads
const STOP_OFFSET = 75; // pixels from center to stop line
const PIXELS_PER_METER = 2.4; // 100m ~ 240px

// State
let ws = null;
let isConnectedToBackend = false;
let currentMode = "ELASTIC_AI";
let trafficDensity = "OFF_PEAK";

// Local Simulation Engine (Fallback if backend is offline)
class ClientEngine {
    constructor() {
        this.mode = "ELASTIC_AI";
        this.activeAxis = "NS"; // "NS" or "EW"
        this.signalState = "GREEN"; // "GREEN", "YELLOW", "ALL_RED"
        this.phaseTimer = 0.0;
        this.vehicles = [];
        this.nextId = 1;
        this.density = "OFF_PEAK";
        this.spawnTimer = 0.0;
        this.metrics = {
            total_passed: 0,
            total_wait_time: 0.0,
            empty_red_wait_time: 0.0,
            co2_saved_kg: 0.0,
            avg_wait_time: 0.0,
            throughput_per_min: 0.0,
            gap_out_triggers: 0,
            emergency_preemptions: 0
        };
        this.startTime = Date.now();
    }

    spawn(lane, isEmergency = false) {
        const vid = (isEmergency ? "EMG-" : "V-") + this.nextId++;
        const vehicle = {
            id: vid,
            lane: lane,
            distance: 135.0,
            speed: isEmergency ? 14.0 : 10.0,
            current_speed: isEmergency ? 14.0 : 10.0,
            is_emergency: isEmergency,
            wait_time: 0.0,
            empty_red_wait: 0.0,
            has_crossed: false,
            color: isEmergency ? "#ef4444" : ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#06b6d4"][Math.floor(Math.random() * 5)]
        };
        // Avoid initial overlap
        const sameLane = this.vehicles.filter(v => v.lane === lane && v.distance > 115);
        if (sameLane.length > 0) {
            vehicle.distance = Math.max(...sameLane.map(v => v.distance)) + 16.0;
        }
        this.vehicles.push(vehicle);
    }

    update(dt) {
        this.phaseTimer += dt;
        this.spawnTimer += dt;

        const spawnIntervals = { "OFF_PEAK": 4.5, "MEDIUM": 2.2, "RUSH_HOUR": 1.2 };
        if (this.spawnTimer >= (spawnIntervals[this.density] || 2.5)) {
            this.spawnTimer = 0.0;
            let lane;
            if (this.density === "OFF_PEAK") {
                lane = Math.random() < 0.8 ? (Math.random() < 0.5 ? "N" : "S") : (Math.random() < 0.5 ? "E" : "W");
            } else {
                lane = ["N", "S", "E", "W"][Math.floor(Math.random() * 4)];
            }
            this.spawn(lane, false);
        }

        // Emergency Check
        const emg = this.vehicles.find(v => v.is_emergency && v.distance > -10.0);
        if (emg) {
            const emgAxis = (emg.lane === "N" || emg.lane === "S") ? "NS" : "EW";
            if (this.activeAxis !== emgAxis && this.signalState === "GREEN") {
                this.signalState = "YELLOW";
                this.phaseTimer = 0.0;
                this.metrics.emergency_preemptions++;
                triggerGapToast("🚨 Emergency Siren Detected! Instant Corridor Preemption");
            }
        }

        // Signal Logic
        if (this.signalState === "YELLOW") {
            if (this.phaseTimer >= 3.5) {
                this.signalState = "ALL_RED";
                this.phaseTimer = 0.0;
            }
        } else if (this.signalState === "ALL_RED") {
            if (this.phaseTimer >= 1.5) {
                this.activeAxis = this.activeAxis === "NS" ? "EW" : "NS";
                this.signalState = "GREEN";
                this.phaseTimer = 0.0;
            }
        } else if (this.signalState === "GREEN") {
            if (this.mode === "FIXED_TIME") {
                if (this.phaseTimer >= 30.0) {
                    this.signalState = "YELLOW";
                    this.phaseTimer = 0.0;
                }
            } else {
                // ELASTIC AI
                if (this.phaseTimer >= 5.0) { // Min green
                    if (this.phaseTimer >= 45.0) { // Max green
                        this.signalState = "YELLOW";
                        this.phaseTimer = 0.0;
                    } else {
                        const activeLanes = this.activeAxis === "NS" ? ["N", "S"] : ["E", "W"];
                        const oppLanes = this.activeAxis === "NS" ? ["E", "W"] : ["N", "S"];

                        const activeApproaching = this.vehicles.filter(v => activeLanes.includes(v.lane) && v.distance > 0 && v.distance <= 80.0);
                        const oppWaiting = this.vehicles.filter(v => oppLanes.includes(v.lane) && v.distance > 0 && v.distance <= 80.0);

                        let hasIncoming = false;
                        for (const v of activeApproaching) {
                            const tti = v.distance / Math.max(v.current_speed, 1.0);
                            if (tti <= 2.8) {
                                hasIncoming = true;
                                break;
                            }
                        }

                        if (!hasIncoming && oppWaiting.length > 0) {
                            this.signalState = "YELLOW";
                            this.phaseTimer = 0.0;
                            this.metrics.gap_out_triggers++;
                            triggerGapToast("⚡ 2-Second Gap-Out: Empty Green Early-Terminated!");
                        }
                    }
                }
            }
        }

        // Vehicles update
        const activeLanes = this.activeAxis === "NS" ? ["N", "S"] : ["E", "W"];
        const lanesMap = { "N": [], "S": [], "E": [], "W": [] };
        this.vehicles.forEach(v => lanesMap[v.lane].push(v));
        Object.keys(lanesMap).forEach(k => lanesMap[k].sort((a, b) => a.distance - b.distance));

        Object.values(lanesMap).forEach(list => {
            list.forEach((v, idx) => {
                const lead = idx > 0 ? list[idx - 1] : null;
                const isGreen = activeLanes.includes(v.lane) && this.signalState === "GREEN";
                const isYellow = activeLanes.includes(v.lane) && this.signalState === "YELLOW";

                let canProceed = false;
                if (v.distance <= 0) canProceed = true;
                else if (isGreen) canProceed = true;
                else if (isYellow && v.distance < 12.0 && v.current_speed > 6.0) canProceed = true;

                let desired = v.speed;
                if (!canProceed && v.distance > 0) {
                    const stopDist = v.distance - 2.0;
                    if (stopDist > 0) {
                        desired = Math.min(desired, Math.sqrt(Math.max(0, 2 * 3.0 * stopDist)));
                    } else {
                        desired = 0.0;
                    }
                }

                if (lead) {
                    const gap = lead.distance - v.distance - 7.0;
                    if (gap > 0) {
                        const followSpeed = Math.sqrt(Math.max(0, 2 * 3.5 * gap));
                        desired = Math.min(desired, followSpeed, lead.current_speed + 2.0);
                    } else {
                        desired = 0.0;
                    }
                }

                if (v.current_speed < desired) {
                    v.current_speed = Math.min(desired, v.current_speed + (v.is_emergency ? 3.0 : 2.2) * dt);
                } else if (v.current_speed > desired) {
                    v.current_speed = Math.max(desired, v.current_speed - (v.is_emergency ? 4.5 : 3.5) * dt);
                }

                v.distance -= v.current_speed * dt;

                if (!v.has_crossed && v.distance < -15.0) {
                    v.has_crossed = true;
                    this.metrics.total_passed++;
                }

                if (v.current_speed < 0.6 && v.distance > 0) {
                    v.wait_time += dt;
                    this.metrics.total_wait_time += dt;

                    const oppAxis = v.lane === "N" || v.lane === "S" ? "EW" : "NS";
                    if (this.signalState === "GREEN" && this.activeAxis === oppAxis) {
                        const activeOpp = this.vehicles.filter(ov => (oppAxis === "NS" ? (ov.lane === "N" || ov.lane === "S") : (ov.lane === "E" || ov.lane === "W")) && ov.distance > -10.0 && ov.distance < 60.0);
                        if (activeOpp.length === 0) {
                            v.empty_red_wait += dt;
                            this.metrics.empty_red_wait_time += dt;
                        }
                    }
                }
            });
        });

        this.vehicles = this.vehicles.filter(v => v.distance > -60.0);

        // Metrics
        const elapsed = Math.max(1, (Date.now() - this.startTime) / 1000);
        this.metrics.throughput_per_min = ((this.metrics.total_passed / elapsed) * 60).toFixed(1);
        this.metrics.avg_wait_time = this.metrics.total_passed > 0 ? (this.metrics.total_wait_time / this.metrics.total_passed).toFixed(1) : 0.0;
        this.metrics.co2_saved_kg = (this.metrics.gap_out_triggers * 0.018 * 4.0).toFixed(3);
    }

    getState() {
        return {
            mode: this.mode,
            active_axis: this.activeAxis,
            signal_state: this.signalState,
            phase_timer: this.phaseTimer.toFixed(1),
            traffic_density: this.density,
            vehicles: this.vehicles.map(v => ({
                id: v.id,
                lane: v.lane,
                distance: v.distance,
                speed: (v.current_speed * 3.6).toFixed(1),
                is_emergency: v.is_emergency,
                wait_time: v.wait_time.toFixed(1),
                color: v.color,
                has_crossed: v.has_crossed
            })),
            metrics: { ...this.metrics }
        };
    }

    resetMetrics() {
        this.metrics = {
            total_passed: 0,
            total_wait_time: 0.0,
            empty_red_wait_time: 0.0,
            co2_saved_kg: 0.0,
            avg_wait_time: 0.0,
            throughput_per_min: 0.0,
            gap_out_triggers: 0,
            emergency_preemptions: 0
        };
        this.startTime = Date.now();
    }
}

const localEngine = new ClientEngine();
let latestState = localEngine.getState();

// Connect WebSocket
function initWebSocket() {
    const wsUrl = `ws://${window.location.hostname || "localhost"}:8765`;
    const statusBadge = document.getElementById("connection-status");
    const statusText = statusBadge.querySelector(".status-text");

    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            isConnectedToBackend = true;
            statusBadge.className = "status-badge connected";
            statusText.textContent = "Connected to Python Edge-AI";
            console.log("Connected to Python Traffic Engine backend.");
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            const prevGapouts = latestState?.metrics?.gap_out_triggers || 0;
            latestState = data;
            
            // Trigger toast if new gapout occurred
            if (data.metrics.gap_out_triggers > prevGapouts) {
                triggerGapToast("⚡ 2-Second Gap-Out: Empty Green Early-Terminated!");
            }
        };

        ws.onclose = () => {
            isConnectedToBackend = false;
            statusBadge.className = "status-badge standalone";
            statusText.textContent = "Standalone Browser Engine";
            setTimeout(initWebSocket, 4000); // retry connect
        };

        ws.onerror = () => {
            isConnectedToBackend = false;
            statusBadge.className = "status-badge standalone";
            statusText.textContent = "Standalone Browser Engine";
        };
    } catch (e) {
        isConnectedToBackend = false;
        statusBadge.className = "status-badge standalone";
        statusText.textContent = "Standalone Browser Engine";
    }
}

// User Actions
function setControllerMode(mode) {
    currentMode = mode;
    document.getElementById("btn-mode-ai").classList.toggle("active", mode === "ELASTIC_AI");
    document.getElementById("btn-mode-fixed").classList.toggle("active", mode === "FIXED_TIME");

    const modePill = document.getElementById("active-mode-pill");
    const modeText = document.getElementById("active-mode-text");
    if (mode === "ELASTIC_AI") {
        modePill.className = "mode-pill";
        modeText.textContent = "Elastic AI Mode";
    } else {
        modePill.className = "mode-pill fixed-mode";
        modeText.textContent = "Fixed-Timer (30s)";
    }

    if (isConnectedToBackend && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SET_MODE", mode: mode }));
    } else {
        localEngine.mode = mode;
    }
}

function spawnCar(lane) {
    if (isConnectedToBackend && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SPAWN_VEHICLE", lane: lane }));
    } else {
        localEngine.spawn(lane, false);
    }
}

function spawnEmergency() {
    const lane = ["N", "S", "E", "W"][Math.floor(Math.random() * 4)];
    if (isConnectedToBackend && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SPAWN_EMERGENCY", lane: lane }));
    } else {
        localEngine.spawn(lane, true);
    }
    triggerGapToast("🚨 Emergency Siren Detected on Lane " + lane + "! Preempting Signal...");
}

function setTrafficDensity(density) {
    trafficDensity = density;
    document.querySelectorAll(".density-btn").forEach(b => b.classList.remove("active"));
    const idMap = { "OFF_PEAK": "btn-den-offpeak", "MEDIUM": "btn-den-medium", "RUSH_HOUR": "btn-den-rush" };
    if (idMap[density]) document.getElementById(idMap[density]).classList.add("active");

    if (isConnectedToBackend && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SET_DENSITY", density: density }));
    } else {
        localEngine.density = density;
    }
}

function resetBenchmarks() {
    if (isConnectedToBackend && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "RESET_METRICS" }));
    } else {
        localEngine.resetMetrics();
    }
}

let toastTimeout = null;
function triggerGapToast(msg) {
    const toast = document.getElementById("horizon-banner");
    const toastMsg = document.getElementById("toast-message");
    toastMsg.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove("show");
    }, 2800);
}

// -------------------------------------------------------------
// Canvas Rendering Engine (60 FPS)
// -------------------------------------------------------------
let radarAngle = 0;

function drawIntersection(state) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Terrain Grass Background
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Asphalt Roads
    ctx.fillStyle = "#161d2d";
    // Vertical road (North-South)
    ctx.fillRect(CX - ROAD_HALF, 0, ROAD_HALF * 2, canvas.height);
    // Horizontal road (East-West)
    ctx.fillRect(0, CY - ROAD_HALF, canvas.width, ROAD_HALF * 2);

    // 3. Lane Dividers
    ctx.strokeStyle = "#27354f";
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 12]);
    // N-S center divider
    ctx.beginPath();
    ctx.moveTo(CX, 0); ctx.lineTo(CX, CY - ROAD_HALF);
    ctx.moveTo(CX, CY + ROAD_HALF); ctx.lineTo(CX, canvas.height);
    // E-W center divider
    ctx.moveTo(0, CY); ctx.lineTo(CX - ROAD_HALF, CY);
    ctx.moveTo(CX + ROAD_HALF, CY); ctx.lineTo(canvas.width, CY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 4. White Stop Lines
    ctx.fillStyle = "#ffffff";
    // North stop line (for cars driving South)
    ctx.fillRect(CX - ROAD_HALF, CY - STOP_OFFSET - 4, ROAD_HALF, 4);
    // South stop line (for cars driving North)
    ctx.fillRect(CX, CY + STOP_OFFSET, ROAD_HALF, 4);
    // East stop line (for cars driving West)
    ctx.fillRect(CX + STOP_OFFSET, CY - ROAD_HALF, 4, ROAD_HALF);
    // West stop line (for cars driving East)
    ctx.fillRect(CX - STOP_OFFSET - 4, CY, 4, ROAD_HALF);

    // 5. Zebra Crosswalks
    drawCrosswalk(CX - ROAD_HALF, CY - STOP_OFFSET + 6, ROAD_HALF * 2, 16, true);
    drawCrosswalk(CX - ROAD_HALF, CY + STOP_OFFSET - 22, ROAD_HALF * 2, 16, true);
    drawCrosswalk(CX - STOP_OFFSET + 6, CY - ROAD_HALF, 16, ROAD_HALF * 2, false);
    drawCrosswalk(CX + STOP_OFFSET - 22, CY - ROAD_HALF, 16, ROAD_HALF * 2, false);

    // 6. Upstream Radar & Vision Horizon Arc
    drawHorizonRadar(state);

    // 7. Render Vehicles
    if (state.vehicles) {
        state.vehicles.forEach(v => drawVehicle(v));
    }

    // 8. Traffic Signal Lanterns at corners
    drawTrafficSignals(state);
}

function drawCrosswalk(x, y, w, h, isHorizontal) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    const stripes = 6;
    for (let i = 0; i < stripes; i++) {
        if (isHorizontal) {
            const sx = x + (i * (w / stripes)) + 3;
            ctx.fillRect(sx, y, (w / stripes) - 6, h);
        } else {
            const sy = y + (i * (h / stripes)) + 3;
            ctx.fillRect(x, sy, w, (h / stripes) - 6);
        }
    }
}

function drawHorizonRadar(state) {
    radarAngle += 0.04;
    const horizonPx = 90.0 * PIXELS_PER_METER; // ~216px

    ctx.save();
    ctx.strokeStyle = "rgba(6, 182, 212, 0.25)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);

    // Active detection zone markers
    ctx.beginPath();
    ctx.arc(CX, CY, horizonPx, 0, Math.PI * 2);
    ctx.stroke();

    // Radar scan beam
    const scanX = CX + Math.cos(radarAngle) * horizonPx;
    const scanY = CY + Math.sin(radarAngle) * horizonPx;
    const grad = ctx.createRadialGradient(CX, CY, 10, CX, CY, horizonPx);
    grad.addColorStop(0, "rgba(6, 182, 212, 0.08)");
    grad.addColorStop(1, "rgba(6, 182, 212, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, horizonPx, radarAngle - 0.35, radarAngle);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
}

function getVehicleCoordinates(v) {
    const distPx = v.distance * PIXELS_PER_METER;
    let x = 0, y = 0, angle = 0;

    if (v.lane === "N") {
        x = CX - ROAD_HALF / 2;
        y = (CY - STOP_OFFSET) - distPx;
        angle = Math.PI / 2;
    } else if (v.lane === "S") {
        x = CX + ROAD_HALF / 2;
        y = (CY + STOP_OFFSET) + distPx;
        angle = -Math.PI / 2;
    } else if (v.lane === "E") {
        x = (CX + STOP_OFFSET) + distPx;
        y = CY - ROAD_HALF / 2;
        angle = Math.PI;
    } else if (v.lane === "W") {
        x = (CX - STOP_OFFSET) - distPx;
        y = CY + ROAD_HALF / 2;
        angle = 0;
    }

    return { x, y, angle };
}

function drawVehicle(v) {
    const { x, y, angle } = getVehicleCoordinates(v);
    const carLength = 26;
    const carWidth = 14;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Headlight cones
    const isNight = trafficDensity === "OFF_PEAK";
    const lightGrad = ctx.createLinearGradient(carLength / 2, 0, carLength / 2 + 50, 0);
    lightGrad.addColorStop(0, isNight ? "rgba(254, 240, 138, 0.45)" : "rgba(254, 240, 138, 0.2)");
    lightGrad.addColorStop(1, "rgba(254, 240, 138, 0)");
    ctx.fillStyle = lightGrad;
    ctx.beginPath();
    ctx.moveTo(carLength / 2, -carWidth / 2);
    ctx.lineTo(carLength / 2 + 45, -carWidth * 1.5);
    ctx.lineTo(carLength / 2 + 45, carWidth * 1.5);
    ctx.lineTo(carLength / 2, carWidth / 2);
    ctx.closePath();
    ctx.fill();

    // Car Body Shadow
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(-carLength / 2 + 2, -carWidth / 2 + 2, carLength, carWidth);

    // Car Body
    ctx.fillStyle = v.color;
    roundRect(ctx, -carLength / 2, -carWidth / 2, carLength, carWidth, 4);
    ctx.fill();

    // Windshield
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(-carLength / 4, -carWidth / 2 + 2, carLength / 2.5, carWidth - 4);

    // Brake Lights (glowing red when stopped)
    if (parseFloat(v.speed) < 2.0) {
        ctx.fillStyle = "#ef4444";
        ctx.shadowColor = "#ef4444";
        ctx.shadowBlur = 8;
        ctx.fillRect(-carLength / 2 - 2, -carWidth / 2 + 1, 3, 3);
        ctx.fillRect(-carLength / 2 - 2, carWidth / 2 - 4, 3, 3);
        ctx.shadowBlur = 0;
    }

    // Emergency Flashing Beacon
    if (v.is_emergency) {
        const flash = Math.floor(Date.now() / 150) % 2 === 0;
        ctx.fillStyle = flash ? "#ef4444" : "#3b82f6";
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    ctx.restore();

    // Vehicle Telemetry Tag (Speed & Distance)
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillStyle = v.is_emergency ? "#fca5a5" : "#94a3b8";
    const tag = `${Math.round(v.speed)} km/h`;
    ctx.fillText(tag, x - 15, y - 16);
}

function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function drawTrafficSignals(state) {
    const isNsGreen = state.active_axis === "NS" && state.signal_state === "GREEN";
    const isNsYellow = state.active_axis === "NS" && state.signal_state === "YELLOW";
    const isNsRed = state.active_axis === "EW" || state.signal_state === "ALL_RED";

    const isEwGreen = state.active_axis === "EW" && state.signal_state === "GREEN";
    const isEwYellow = state.active_axis === "EW" && state.signal_state === "YELLOW";
    const isEwRed = state.active_axis === "NS" || state.signal_state === "ALL_RED";

    // North Signal Head (Top-Left corner of intersection)
    drawSignalHead(CX - ROAD_HALF - 20, CY - STOP_OFFSET - 35, isNsGreen, isNsYellow, isNsRed);
    // South Signal Head
    drawSignalHead(CX + ROAD_HALF + 5, CY + STOP_OFFSET + 10, isNsGreen, isNsYellow, isNsRed);
    // East Signal Head
    drawSignalHead(CX + STOP_OFFSET + 10, CY - ROAD_HALF - 25, isEwGreen, isEwYellow, isEwRed);
    // West Signal Head
    drawSignalHead(CX - STOP_OFFSET - 35, CY + ROAD_HALF + 5, isEwGreen, isEwYellow, isEwRed);
}

function drawSignalHead(x, y, isGreen, isYellow, isRed) {
    ctx.fillStyle = "#0a0a0c";
    ctx.strokeStyle = "#374151";
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, y, 16, 36, 4);
    ctx.fill();
    ctx.stroke();

    // Red lens
    drawLens(x + 8, y + 7, isRed ? "#ef4444" : "#450a0a", isRed);
    // Yellow lens
    drawLens(x + 8, y + 18, isYellow ? "#f59e0b" : "#451a03", isYellow);
    // Green lens
    drawLens(x + 8, y + 29, isGreen ? "#10b981" : "#022c22", isGreen);
}

function drawLens(cx, cy, color, glow) {
    ctx.save();
    ctx.fillStyle = color;
    if (glow) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

// -------------------------------------------------------------
// UI Telemetry Sync
// -------------------------------------------------------------
function updateUI(state) {
    if (!state || !state.metrics) return;

    // Hero Metric: Empty Red Waste
    const emptyRedEl = document.getElementById("metric-empty-red");
    const emptyDescEl = document.getElementById("metric-empty-desc");
    emptyRedEl.textContent = Number(state.metrics.empty_red_wait_time).toFixed(1);

    if (state.mode === "FIXED_TIME") {
        emptyDescEl.innerHTML = `⚠️ <strong>Fixed-Timer Waste:</strong> Vehicles sitting at red light even though crossroad is empty!`;
    } else {
        emptyDescEl.innerHTML = `✨ <strong>Zero waste:</strong> Elastic AI detects empty gap and terminates phase early.`;
    }

    // Grid Metrics
    document.getElementById("metric-avg-wait").textContent = state.metrics.avg_wait_time;
    document.getElementById("metric-throughput").textContent = state.metrics.throughput_per_min;
    document.getElementById("metric-co2").textContent = state.metrics.co2_saved_kg;
    document.getElementById("metric-gapouts").textContent = state.metrics.gap_out_triggers;

    // Signal Telemetry
    const isNsGreen = state.active_axis === "NS" && state.signal_state === "GREEN";
    const isNsYellow = state.active_axis === "NS" && state.signal_state === "YELLOW";
    const isNsRed = state.active_axis === "EW" || state.signal_state === "ALL_RED";

    const isEwGreen = state.active_axis === "EW" && state.signal_state === "GREEN";
    const isEwYellow = state.active_axis === "EW" && state.signal_state === "YELLOW";
    const isEwRed = state.active_axis === "NS" || state.signal_state === "ALL_RED";

    updateLamps("lamps-ns", isNsRed, isNsYellow, isNsGreen);
    updateLamps("lamps-ew", isEwRed, isEwYellow, isEwGreen);

    document.getElementById("phase-timer-display").textContent = `${state.phase_timer}s`;

    const maxPhase = state.mode === "FIXED_TIME" ? 30.0 : 45.0;
    const progressPct = Math.min(100, (parseFloat(state.phase_timer) / maxPhase) * 100);
    document.getElementById("phase-progress").style.width = `${progressPct}%`;
}

function updateLamps(containerId, isRed, isYellow, isGreen) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const lamps = el.querySelectorAll(".lamp");
    lamps[0].classList.toggle("active", isRed);
    lamps[1].classList.toggle("active", isYellow);
    lamps[2].classList.toggle("active", isGreen);
}

// -------------------------------------------------------------
// Main Game Loop (60 FPS)
// -------------------------------------------------------------
let lastFrameTime = performance.now();

function animationLoop(now) {
    const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;

    if (!isConnectedToBackend) {
        localEngine.update(dt);
        latestState = localEngine.getState();
    }

    drawIntersection(latestState);
    updateUI(latestState);

    requestAnimationFrame(animationLoop);
}

// Initialization
window.addEventListener("DOMContentLoaded", () => {
    initWebSocket();
    requestAnimationFrame(animationLoop);
});
