import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import supervision as sv

from detection import FaceDetection


@dataclass
class TrackState:
    track_id: int
    embeddings: List[np.ndarray] = field(default_factory=list)
    embedding_quality: List[float] = field(default_factory=list)
    frames_seen: int = 0
    first_seen_time: float = 0.0
    last_seen_time: float = 0.0
    recognized: bool = False
    identity: Optional[str] = None
    confidence_scores: List[float] = field(default_factory=list)
    latest_bbox: Optional[np.ndarray] = None
    latest_det_score: float = 0.0
    latest_is_live: bool = False
    reject_reasons: List[str] = field(default_factory=list)
    best_face_width: float = 0.0


class ByteTrackManager:
    def __init__(self) -> None:
        self.tracker = sv.ByteTrack(
            track_activation_threshold=0.35,
            lost_track_buffer=40,
            minimum_matching_threshold=0.75,
            frame_rate=30,
        )

    def update(self, detections: List[FaceDetection]) -> List[dict]:
        if not detections:
            return []

        det = sv.Detections(
            xyxy=np.array([d.bbox for d in detections], dtype=np.float32),
            confidence=np.array([max(0.001, float(d.det_score)) for d in detections], dtype=np.float32),
            class_id=np.zeros(len(detections), dtype=np.int32),
        )

        tracked = self.tracker.update_with_detections(det)
        tracker_ids = tracked.tracker_id if tracked.tracker_id is not None else np.array([], dtype=np.int32)

        results: List[dict] = []
        for index in range(len(tracked)):
            track_id = int(tracker_ids[index]) if len(tracker_ids) > index and tracker_ids[index] is not None else -1
            bbox = tracked.xyxy[index]
            results.append({
                "track_id": track_id,
                "bbox": bbox,
                "confidence": float(tracked.confidence[index]) if tracked.confidence is not None else 0.0,
            })

        return results


class TrackStore:
    def __init__(self, ttl_seconds: float = 30.0) -> None:
        self.ttl_seconds = ttl_seconds
        self.items: Dict[int, TrackState] = {}

    def touch(self, track_id: int, now_ts: float) -> TrackState:
        if track_id not in self.items:
            self.items[track_id] = TrackState(
                track_id=track_id,
                first_seen_time=now_ts,
                last_seen_time=now_ts,
            )
        state = self.items[track_id]
        state.last_seen_time = now_ts
        return state

    def cleanup(self, now_ts: Optional[float] = None) -> None:
        now_ts = now_ts or time.time()
        stale = [tid for tid, state in self.items.items() if now_ts - state.last_seen_time > self.ttl_seconds]
        for tid in stale:
            self.items.pop(tid, None)

    def get(self, track_id: int) -> Optional[TrackState]:
        return self.items.get(track_id)
