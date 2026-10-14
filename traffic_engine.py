import time
import random
import math
from typing import List, Dict, Any, Optional

class Vehicle:
    def __init__(self, vid: str, lane: str, is_emergency: bool = False):
        self.id = vid
        self.lane = lane  # 'N', 'S', 'E', 'W'
        self.distance = 140.0  # meters from the stop line (approaching if > 0)
        self.speed = 10.0 if not is_emergency else 14.0  # target speed m/s (~36 km/h or 50 km/h)
        self.current_speed = self.speed
        self.is_emergency = is_emergency
        self.wait_time = 0.0
        self.empty_red_wait = 0.0
        self.has_crossed = False
        self.color = "#ef4444" if is_emergency else random.choice([
            "#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#06b6d4", "#ec4899"
        ])

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "lane": self.lane,
            "distance": round(self.distance, 1),
            "speed": round(self.current_speed * 3.6, 1),  # km/h
            "is_emergency": self.is_emergency,
            "wait_time": round(self.wait_time, 1),
            "color": self.color,
            "has_crossed": self.has_crossed
        }

class TrafficEngine:
    def __init__(self):
        self.mode = "ELASTIC_AI"  # "ELASTIC_AI" or "FIXED_TIME"
        self.active_axis = "NS"   # "NS" (North-South) or "EW" (East-West)
        self.signal_state = "GREEN" # "GREEN", "YELLOW", "ALL_RED"
        self.phase_timer = 0.0
        self.last_switch_time = time.time()
        
        # Configuration
        self.fixed_green_duration = 30.0
        self.yellow_duration = 3.5
        self.all_red_duration = 1.5
        
        # Elastic AI Parameters
        self.ai_min_green = 5.0        # Minimum safety green for standing vehicles
        self.ai_max_green = 50.0       # Max green to prevent starvation
        self.ai_horizon_distance = 90.0 # meters upstream for horizon sensing
        self.ai_gap_threshold = 2.8    # seconds gap-out threshold
        
        # Simulation State
        self.vehicles: List[Vehicle] = []
        self.next_vehicle_id = 1
        self.traffic_density = "MEDIUM"  # "OFF_PEAK", "MEDIUM", "RUSH_HOUR"
        self.spawn_timer = 0.0
        
        # Metrics & Benchmarking
        self.metrics = {
            "total_passed": 0,
            "total_wait_time": 0.0,
            "empty_red_wait_time": 0.0,  # The key problem: waiting at red when green is empty!
            "co2_saved_kg": 0.0,
            "avg_wait_time": 0.0,
            "throughput_per_min": 0.0,
            "gap_out_triggers": 0,
            "emergency_preemptions": 0
        }
        self.start_benchmark_time = time.time()

    def reset_metrics(self):
        self.metrics = {
            "total_passed": 0,
            "total_wait_time": 0.0,
            "empty_red_wait_time": 0.0,
            "co2_saved_kg": 0.0,
            "avg_wait_time": 0.0,
            "throughput_per_min": 0.0,
            "gap_out_triggers": 0,
            "emergency_preemptions": 0
        }
        self.start_benchmark_time = time.time()

    def spawn_vehicle(self, lane: str, is_emergency: bool = False):
        vid = f"{'EMG' if is_emergency else 'V'}-{self.next_vehicle_id}"
        self.next_vehicle_id += 1
        vehicle = Vehicle(vid, lane, is_emergency)
        # Ensure it doesn't overlap an existing vehicle at spawn point
        same_lane_vehicles = [v for v in self.vehicles if v.lane == lane and v.distance > 120]
        if same_lane_vehicles:
            vehicle.distance = max(v.distance for v in same_lane_vehicles) + 18.0
        self.vehicles.append(vehicle)
        return vehicle

    def update(self, dt: float):
        self.phase_timer += dt
        self.spawn_timer += dt
        
        # 1. Automatic Traffic Generation based on density profile
        spawn_rates = {
            "OFF_PEAK": 4.5,    # Sparsely populated; demonstrates empty wait best!
            "MEDIUM": 2.2,      # Balanced traffic
            "RUSH_HOUR": 1.2    # Dense traffic
        }
        interval = spawn_rates.get(self.traffic_density, 2.5)
        if self.spawn_timer >= interval:
            self.spawn_timer = 0.0
            # Off-peak simulates unbalanced traffic: mostly NS or EW to highlight the bug in fixed timers
            if self.traffic_density == "OFF_PEAK":
                # 80% chance on NS, 20% on EW
                lane = random.choice(["N", "S", "N", "S"]) if random.random() < 0.8 else random.choice(["E", "W"])
            else:
                lane = random.choice(["N", "S", "E", "W"])
            self.spawn_vehicle(lane)

        # 2. Traffic Signal Controller State Machine
        self._update_signal_controller(dt)

        # 3. Vehicle Kinematics and Queuing Physics
        self._update_vehicles(dt)

        # 4. Metrics Calculation
        self._update_metrics(dt)

    def _update_signal_controller(self, dt: float):
        # Emergency Vehicle Preemption Check
        emergency_vehicle = next((v for v in self.vehicles if v.is_emergency and v.distance > -10.0), None)
        if emergency_vehicle:
            emg_axis = "NS" if emergency_vehicle.lane in ["N", "S"] else "EW"
            if self.active_axis != emg_axis and self.signal_state == "GREEN":
                # Immediately transition to yellow for safety clearance
                self.signal_state = "YELLOW"
                self.phase_timer = 0.0
                self.metrics["emergency_preemptions"] += 1
                return

        if self.signal_state == "YELLOW":
            if self.phase_timer >= self.yellow_duration:
                self.signal_state = "ALL_RED"
                self.phase_timer = 0.0
            return

        if self.signal_state == "ALL_RED":
            if self.phase_timer >= self.all_red_duration:
                # Switch axis
                self.active_axis = "EW" if self.active_axis == "NS" else "NS"
                self.signal_state = "GREEN"
                self.phase_timer = 0.0
            return

        # Signal is GREEN - check whether to stay green or switch
        if self.mode == "FIXED_TIME":
            if self.phase_timer >= self.fixed_green_duration:
                self.signal_state = "YELLOW"
                self.phase_timer = 0.0

        elif self.mode == "ELASTIC_AI":
            # Minimum green safety buffer: must give at least ai_min_green
            if self.phase_timer < self.ai_min_green:
                return

            # Max green anti-starvation: force switch if waited too long
            if self.phase_timer >= self.ai_max_green:
                self.signal_state = "YELLOW"
                self.phase_timer = 0.0
                return

            # ELASTIC HORIZON & GAP-OUT LOGIC:
            active_lanes = ["N", "S"] if self.active_axis == "NS" else ["E", "W"]
            opposing_lanes = ["E", "W"] if self.active_axis == "NS" else ["N", "S"]

            # Check upstream vehicles in active green lanes within the arrival horizon
            # Vehicles within 60 meters and travelling towards the stop line
            active_approaching = [
                v for v in self.vehicles 
                if v.lane in active_lanes and 0.0 < v.distance <= self.ai_horizon_distance
            ]

            # Check if any opposing lane has vehicles queued or approaching
            opposing_waiting = [
                v for v in self.vehicles 
                if v.lane in opposing_lanes and 0.0 < v.distance <= self.ai_horizon_distance
            ]

            # Calculate Time-To-Intersection (TTI) for nearest active vehicle
            has_approaching_active = False
            for v in active_approaching:
                tti = v.distance / max(v.current_speed, 1.0)
                if tti <= self.ai_gap_threshold:
                    has_approaching_active = True
                    break

            # If NO vehicle is within the arrival horizon of the active green light,
            # AND there is a waiting queue or incoming demand on the opposing red light:
            if not has_approaching_active and len(opposing_waiting) > 0:
                # GAP-OUT TRIGGERED! Zero empty wait!
                self.signal_state = "YELLOW"
                self.phase_timer = 0.0
                self.metrics["gap_out_triggers"] += 1

    def _update_vehicles(self, dt: float):
        active_lanes = ["N", "S"] if self.active_axis == "NS" else ["E", "W"]
        
        # Sort vehicles in each lane by distance (ascending, closest to stop line first)
        lanes = {"N": [], "S": [], "E": [], "W": []}
        for v in self.vehicles:
            lanes[v.lane].append(v)
        for lane_key in lanes:
            lanes[lane_key].sort(key=lambda x: x.distance)

        for lane_key, v_list in lanes.items():
            for i, v in enumerate(v_list):
                lead_vehicle = v_list[i - 1] if i > 0 else None
                
                # Determine target speed based on traffic light and lead vehicle
                is_green = (v.lane in active_lanes and self.signal_state == "GREEN")
                is_yellow = (v.lane in active_lanes and self.signal_state == "YELLOW")
                
                # Can vehicle proceed through intersection?
                can_proceed = False
                if v.distance <= 0:
                    # Already in or past the intersection
                    can_proceed = True
                elif is_green:
                    can_proceed = True
                elif is_yellow and v.distance < 12.0 and v.current_speed > 6.0:
                    # Too close to safely brake on yellow - proceed
                    can_proceed = True

                # Calculate target speed / braking
                desired_speed = v.speed
                
                # Stop line constraint
                if not can_proceed and v.distance > 0:
                    stop_dist = v.distance - 2.0  # Stop 2m before line
                    if stop_dist > 0:
                        # Decelerate smoothly to stop line
                        decel_speed = math.sqrt(max(0.0, 2 * 3.0 * stop_dist))
                        desired_speed = min(desired_speed, decel_speed)
                    else:
                        desired_speed = 0.0

                # Car-following constraint (Intelligent Driver Model approximation)
                if lead_vehicle:
                    gap = lead_vehicle.distance - v.distance - 7.0  # 7m vehicle length + bumper buffer
                    if gap > 0:
                        following_speed = math.sqrt(max(0.0, 2 * 3.5 * gap))
                        desired_speed = min(desired_speed, following_speed, lead_vehicle.current_speed + 2.0)
                    else:
                        desired_speed = 0.0

                # Accelerate / Decelerate
                if v.current_speed < desired_speed:
                    accel = 3.0 if v.is_emergency else 2.2
                    v.current_speed = min(desired_speed, v.current_speed + accel * dt)
                elif v.current_speed > desired_speed:
                    decel = 4.5 if v.is_emergency else 3.5
                    v.current_speed = max(desired_speed, v.current_speed - decel * dt)

                # Move vehicle
                v.distance -= v.current_speed * dt

                # Check if vehicle has cleared intersection
                if not v.has_crossed and v.distance < -15.0:
                    v.has_crossed = True
                    self.metrics["total_passed"] += 1

                # Track wait times
                if v.current_speed < 0.6 and v.distance > 0:
                    v.wait_time += dt
                    self.metrics["total_wait_time"] += dt

                    # Check if waiting at a RED while opposite GREEN is empty
                    opposing_axis_lanes = ["N", "S"] if v.lane in ["E", "W"] else ["E", "W"]
                    if self.signal_state == "GREEN" and active_lanes == opposing_axis_lanes:
                        active_occupancy = [
                            ov for ov in self.vehicles 
                            if ov.lane in opposing_axis_lanes and -10.0 < ov.distance < 60.0
                        ]
                        if len(active_occupancy) == 0:
                            v.empty_red_wait += dt
                            self.metrics["empty_red_wait_time"] += dt

        # Cleanup vehicles that have traveled far away
        self.vehicles = [v for v in self.vehicles if v.distance > -60.0]

    def _update_metrics(self, dt: float):
        elapsed = max(1.0, time.time() - self.start_benchmark_time)
        self.metrics["throughput_per_min"] = round((self.metrics["total_passed"] / elapsed) * 60.0, 1)
        if self.metrics["total_passed"] > 0:
            self.metrics["avg_wait_time"] = round(self.metrics["total_wait_time"] / self.metrics["total_passed"], 1)
        else:
            self.metrics["avg_wait_time"] = 0.0

        # Saved emissions: idling car emits ~0.6g CO2 per second
        # If in ELASTIC_AI mode, empty_red_wait is eliminated compared to fixed mode!
        self.metrics["co2_saved_kg"] = round(self.metrics["gap_out_triggers"] * 0.018 * 4.0, 3)

    def get_state(self) -> Dict[str, Any]:
        return {
            "mode": self.mode,
            "active_axis": self.active_axis,
            "signal_state": self.signal_state,
            "phase_timer": round(self.phase_timer, 1),
            "traffic_density": self.traffic_density,
            "vehicles": [v.to_dict() for v in self.vehicles],
            "metrics": {
                "total_passed": self.metrics["total_passed"],
                "total_wait_time": round(self.metrics["total_wait_time"], 1),
                "empty_red_wait_time": round(self.metrics["empty_red_wait_time"], 1),
                "avg_wait_time": self.metrics["avg_wait_time"],
                "throughput_per_min": self.metrics["throughput_per_min"],
                "gap_out_triggers": self.metrics["gap_out_triggers"],
                "emergency_preemptions": self.metrics["emergency_preemptions"],
                "co2_saved_kg": self.metrics["co2_saved_kg"]
            }
        }
