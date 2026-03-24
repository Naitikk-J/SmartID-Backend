import time
from dataclasses import dataclass
from typing import Dict, Optional


@dataclass
class AttendanceRecord:
    employee_id: str
    track_id: int
    similarity: float
    marked_at: float
    snapshot_path: Optional[str] = None


class AttendanceManager:
    def __init__(self, cooldown_seconds: float = 120.0) -> None:
        self.cooldown_seconds = cooldown_seconds
        self.last_marked_by_employee: Dict[str, float] = {}
        self.marked_tracks: Dict[int, float] = {}

    def can_mark(self, employee_id: str, track_id: int, now_ts: Optional[float] = None) -> bool:
        now_ts = now_ts or time.time()

        if track_id in self.marked_tracks:
            return False

        last_marked = self.last_marked_by_employee.get(employee_id)
        if last_marked is None:
            return True

        return (now_ts - last_marked) >= self.cooldown_seconds

    def mark_once(self, employee_id: str, track_id: int, similarity: float, snapshot_path: Optional[str] = None) -> Optional[AttendanceRecord]:
        now_ts = time.time()
        if not self.can_mark(employee_id, track_id, now_ts):
            return None

        self.last_marked_by_employee[employee_id] = now_ts
        self.marked_tracks[track_id] = now_ts

        return AttendanceRecord(
            employee_id=employee_id,
            track_id=track_id,
            similarity=similarity,
            marked_at=now_ts,
            snapshot_path=snapshot_path,
        )

    def cleanup(self) -> None:
        now_ts = time.time()
        stale_tracks = [tid for tid, ts in self.marked_tracks.items() if now_ts - ts > (self.cooldown_seconds * 2)]
        for tid in stale_tracks:
            self.marked_tracks.pop(tid, None)
