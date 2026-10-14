# OmniFlow: Dynamic Elastic Micro-Phasing Traffic Controller

An Edge-AI dynamic traffic control system that replaces rigid timer-based traffic signals with **Packet-Switched Elastic Micro-Phasing**. 

The system solves the problem of drivers sitting idle at red lights when conflicting cross-streets are completely empty.

---

## 🚀 Key Features

1. **Horizon Sensing & Upstream Detection (80–100m):**
   - Continuously computes Time-to-Intersection (TTI) for oncoming vehicles using computer vision / mmWave radar feeds.
2. **2.5-Second "Gap-Out" Rule:**
   - If an active green lane has zero approaching vehicles within the arrival threshold and crossroad traffic is waiting, the signal immediately initiates a yellow clearance and hands over the green phase.
3. **Emergency Vehicle Preemption (Acoustic & Vision):**
   - Detects sirens or emergency beacons and creates an instant green corridor.
4. **Empty-Red Waste Gauge:**
   - Real-time benchmark quantifying exact seconds saved from pointless waiting, average delay reductions, and avoided carbon emissions ($CO_2$).
5. **Dual Architecture (Zero-Setup Guarantee):**
   - **Full Stack:** Python asynchronous backend with WebSocket stream on `ws://localhost:8765` + static server on `http://localhost:8000`.
   - **Standalone Fallback:** The frontend (`index.html`) embeds an in-browser replica of the same engine, so it can run immediately by double-clicking without installing anything!

---

## 📁 Project Structure

```
smart-traffic-system/
├── backend/
│   ├── traffic_engine.py    # Core simulation engine (Elastic AI vs Fixed-Time)
│   └── server.py            # Async WebSocket server (8765) & HTTP server (8000)
├── frontend/
│   ├── index.html           # Interactive dashboard & 2D canvas visualizer
│   ├── style.css            # Dark-mode styling with glowing signal lamps
│   └── app.js               # WebSocket client & 60 FPS Canvas rendering loop
├── start.bat                # 1-click launcher for Windows
└── README.md
```

---

## 🏃 How to Run

### Method 1: One-Click Launcher (Windows)
Double-click `start.bat` in the root folder. It will start the backend and automatically open the dashboard in your default browser.

### Method 2: Command Line (Python)
```powershell
python backend/server.py
```
Then open: **`http://localhost:8000`** in your browser.

### Method 3: Instant Browser View (Zero Dependencies)
Double-click `frontend/index.html` to open it directly in Google Chrome, Edge, or Firefox. The dashboard will automatically switch to **Standalone Engine** mode and run the simulation right in your browser!

---

## 🕹️ Controls on the Dashboard

- **⚡ Elastic Micro-Phasing vs ⏳ Fixed-Timer:** Switch live between the AI controller and traditional fixed cycles to watch the "Empty-Red Waste" metric diverge.
- **Approach Influx Buttons:** Click `+ North`, `+ South`, `+ East`, or `+ West` to dispatch single cars.
- **🚨 Dispatch Ambulance:** Triggers priority corridor clearing.
- **Traffic Influx Profile:** Toggle between *Off-Peak / Night*, *Normal Flow*, and *Rush Hour*.
