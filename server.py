import os
import sys
import json
import time
import asyncio
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import websockets
from traffic_engine import TrafficEngine

# Determine paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend")

# Initialize Simulation Engine
engine = TrafficEngine()
connected_clients = set()

class StaticFileHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    def log_message(self, format, *args):
        # Suppress noisy HTTP asset logs in console
        pass

def start_http_server(port=8000):
    server = ThreadingHTTPServer(("0.0.0.0", port), StaticFileHandler)
    server.serve_forever()

async def ws_handler(websocket):
    connected_clients.add(websocket)
    try:
        # Send initial state immediately
        await websocket.send(json.dumps(engine.get_state()))
        
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get("type")
            
            if msg_type == "SET_MODE":
                new_mode = data.get("mode", "ELASTIC_AI")
                if new_mode in ["ELASTIC_AI", "FIXED_TIME"]:
                    engine.mode = new_mode
                    print(f"🚦 Mode switched to: {engine.mode}")
            
            elif msg_type == "SPAWN_VEHICLE":
                lane = data.get("lane", "N")
                engine.spawn_vehicle(lane, is_emergency=False)
                
            elif msg_type == "SPAWN_EMERGENCY":
                lane = data.get("lane", "N")
                engine.spawn_vehicle(lane, is_emergency=True)
                print(f"🚨 Emergency vehicle dispatched on lane {lane}!")
                
            elif msg_type == "SET_DENSITY":
                density = data.get("density", "MEDIUM")
                if density in ["OFF_PEAK", "MEDIUM", "RUSH_HOUR"]:
                    engine.traffic_density = density
                    print(f"📊 Traffic density set to: {density}")
                    
            elif msg_type == "RESET_METRICS":
                engine.reset_metrics()
                print("🔄 Metrics reset.")
                
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)

async def simulation_loop():
    tick_rate = 20  # 20 Hz (50 ms)
    dt = 1.0 / tick_rate
    last_time = time.time()
    
    while True:
        now = time.time()
        actual_dt = now - last_time
        last_time = now
        
        # Clamp dt to avoid big jumps if event loop was briefly delayed
        step_dt = min(actual_dt, 0.1)
        engine.update(step_dt)
        
        if connected_clients:
            payload = json.dumps(engine.get_state())
            # Broadcast to all connected WebSockets
            websockets_list = list(connected_clients)
            for ws in websockets_list:
                try:
                    await ws.send(payload)
                except Exception:
                    connected_clients.discard(ws)
                    
        await asyncio.sleep(dt)

async def main():
    http_port = 8000
    ws_port = 8765
    
    # 1. Start HTTP Server in background thread
    http_thread = threading.Thread(target=start_http_server, args=(http_port,), daemon=True)
    http_thread.start()
    
    # 2. Start WebSocket Server
    ws_server = await websockets.serve(ws_handler, "0.0.0.0", ws_port)
    
    print("\n" + "="*65)
    print(" 🚀 SMART TRAFFIC SYSTEM: ELASTIC MICRO-PHASING (EDGE-AI)")
    print("="*65)
    print(f" 🌐 Web Dashboard:  http://localhost:{http_port}")
    print(f" 🔌 WebSocket API:  ws://localhost:{ws_port}")
    print(f" 📁 Serving UI from: {FRONTEND_DIR}")
    print("="*65)
    print(" ✨ Open http://localhost:8000 in your browser to test.")
    print(" Press Ctrl+C in terminal to stop.\n")
    
    # 3. Run simulation loop concurrently
    await simulation_loop()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 Simulation stopped by user.")
