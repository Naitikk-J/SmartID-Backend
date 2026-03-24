import os
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np

from detection import FaceDetection
from tracking import ByteTrackManager, TrackState, TrackStore
from utils import (
    QualityMetrics,
    cosine_similarity,
    evaluate_face_quality,
    format_reject_debug,
    softmax,
    weighted_average_embeddings,
)


@dataclass
class ProcessedTrack:
    track_id: int
    bbox: List[float]
    det_score: float
    frames_seen: int
    elapsed_sec: float
    quality_score: float
    is_live: bool
    ready_for_recognition: bool
    descriptor: List[float]
    reject_reasons: List[str]


class WalkThroughRecognitionEngine:
    def __init__(self) -> None:
        fast_mode = os.getenv("FACE_FAST_MODE", "1").lower() in {"1", "true", "yes", "on"}
        self.fast_mode = fast_mode

        self.frame_stride = int(os.getenv("FRAME_STRIDE", "1" if fast_mode else "3"))
        self.min_frames_before_recognition = int(os.getenv("MIN_TRACK_FRAMES", "4" if fast_mode else "10"))
        self.min_seconds_before_recognition = float(os.getenv("MIN_TRACK_SECONDS", "0.35" if fast_mode else "1.2"))
        self.max_embeddings_per_track = int(os.getenv("MAX_TRACK_EMBEDDINGS", "10" if fast_mode else "20"))
        self.majority_window = int(os.getenv("MAJORITY_WINDOW", "4" if fast_mode else "8"))
        self.majority_ratio = float(os.getenv("MAJORITY_RATIO", "0.55" if fast_mode else "0.65"))

        self.tracker = ByteTrackManager()
        self.store = TrackStore(ttl_seconds=float(os.getenv("TRACK_TTL_SECONDS", "30")))
        self.frame_index = 0
        self.last_tracks: List[ProcessedTrack] = []

    def _best_detection_match(self, tracked_bbox: np.ndarray, detections: List[FaceDetection]) -> Optional[FaceDetection]:
        if not detections:
            return None

        def iou(a: np.ndarray, b: np.ndarray) -> float:
            x1 = max(float(a[0]), float(b[0]))
            y1 = max(float(a[1]), float(b[1]))
            x2 = min(float(a[2]), float(b[2]))
            y2 = min(float(a[3]), float(b[3]))
            inter_w = max(0.0, x2 - x1)
            inter_h = max(0.0, y2 - y1)
            inter = inter_w * inter_h
            area_a = max(0.0, float(a[2] - a[0])) * max(0.0, float(a[3] - a[1]))
            area_b = max(0.0, float(b[2] - b[0])) * max(0.0, float(b[3] - b[1]))
            union = area_a + area_b - inter
            return (inter / union) if union > 0 else 0.0

        best = None
        best_iou = 0.0
        for det in detections:
            overlap = iou(tracked_bbox, det.bbox)
            if overlap > best_iou:
                best_iou = overlap
                best = det
        return best if best_iou > 0.15 else None

    def _update_state_with_quality(
        self,
        state: TrackState,
        frame_bgr: np.ndarray,
        det: FaceDetection,
        quality: QualityMetrics,
        is_live: bool,
    ) -> None:
        state.frames_seen += 1
        state.latest_bbox = det.bbox
        state.latest_det_score = float(det.det_score)
        state.latest_is_live = bool(is_live)
        state.reject_reasons = quality.reject_reasons

        face_width = float(max(1.0, det.bbox[2] - det.bbox[0]))
        state.best_face_width = max(state.best_face_width, face_width)

        if quality.is_valid and is_live:
            state.embeddings.append(det.embedding)
            state.embedding_quality.append(max(1.0, quality.score))
            if len(state.embeddings) > self.max_embeddings_per_track:
                state.embeddings = state.embeddings[-self.max_embeddings_per_track :]
                state.embedding_quality = state.embedding_quality[-self.max_embeddings_per_track :]

    def _ready_for_recognition(self, state: TrackState, now_ts: float) -> bool:
        elapsed = now_ts - state.first_seen_time
        enough_frames = state.frames_seen >= self.min_frames_before_recognition
        enough_time = elapsed >= self.min_seconds_before_recognition
        enough_samples = len(state.embeddings) >= max(3, self.min_frames_before_recognition // 3)
        close_enough = state.best_face_width >= 100.0
        return (enough_frames or enough_time) and enough_samples and close_enough

    def process(self, frame_bgr: np.ndarray, detections: List[FaceDetection]) -> List[ProcessedTrack]:
        self.frame_index += 1
        now_ts = time.time()

        if self.frame_index % max(1, self.frame_stride) != 0:
            self.store.cleanup(now_ts)
            return self.last_tracks

        tracked = self.tracker.update(detections)
        results: List[ProcessedTrack] = []

        for item in tracked:
            track_id = int(item["track_id"])
            if track_id < 0:
                continue

            state = self.store.touch(track_id, now_ts)
            det = self._best_detection_match(item["bbox"], detections)
            if det is None:
                continue

            if self.fast_mode:
                # Fast path: avoid expensive per-frame quality analysis.
                state.frames_seen += 1
                state.latest_bbox = det.bbox
                state.latest_det_score = float(det.det_score)
                is_live = bool(det.det_score >= 0.5)
                state.latest_is_live = is_live
                state.reject_reasons = []

                face_width = float(max(1.0, det.bbox[2] - det.bbox[0]))
                state.best_face_width = max(state.best_face_width, face_width)

                if is_live:
                    state.embeddings.append(det.embedding)
                    state.embedding_quality.append(max(1.0, float(det.det_score) * 100.0))
                    if len(state.embeddings) > self.max_embeddings_per_track:
                        state.embeddings = state.embeddings[-self.max_embeddings_per_track :]
                        state.embedding_quality = state.embedding_quality[-self.max_embeddings_per_track :]

                quality_score = float(round(max(0.0, min(100.0, float(det.det_score) * 100.0)), 2))
                reject_reasons: List[str] = []
            else:
                quality = evaluate_face_quality(frame_bgr, det.bbox, det.kps)
                is_live = bool(
                    det.det_score >= 0.55
                    and quality.blur_var >= 55.0
                    and quality.brightness >= 50.0
                    and abs(quality.yaw_deg) <= 40.0
                    and abs(quality.pitch_deg) <= 35.0
                )
                self._update_state_with_quality(state, frame_bgr, det, quality, is_live)
                quality_score = float(round(quality.score, 2))
                reject_reasons = list(quality.reject_reasons)

            ready = self._ready_for_recognition(state, now_ts)
            descriptor = []
            if ready and state.embeddings:
                weighted = weighted_average_embeddings(state.embeddings, state.embedding_quality)
                descriptor = weighted.astype(np.float32).tolist()

            results.append(
                ProcessedTrack(
                    track_id=track_id,
                    bbox=[float(v) for v in det.bbox],
                    det_score=float(det.det_score),
                    frames_seen=int(state.frames_seen),
                    elapsed_sec=float(round(now_ts - state.first_seen_time, 3)),
                    quality_score=quality_score,
                    is_live=is_live,
                    ready_for_recognition=ready,
                    descriptor=descriptor,
                    reject_reasons=reject_reasons,
                )
            )

        self.store.cleanup(now_ts)
        self.last_tracks = results
        return results


class SimilarityMatcher:
    def __init__(self) -> None:
        self.reject_threshold = float(os.getenv("MATCH_REJECT_THRESHOLD", "0.50"))
        self.accept_threshold = float(os.getenv("MATCH_ACCEPT_THRESHOLD", "0.65"))

    def classify(self, similarity: float) -> str:
        if similarity < self.reject_threshold:
            return "reject"
        if similarity < self.accept_threshold:
            return "uncertain"
        return "accept"


class MajorityVoteIdentity:
    def __init__(self, window: int = 8, ratio: float = 0.65) -> None:
        self.window = window
        self.ratio = ratio
        self.history: Dict[int, List[str]] = defaultdict(list)

    def update(self, track_id: int, predicted_identity: str) -> Optional[str]:
        bucket = self.history[track_id]
        bucket.append(predicted_identity)
        if len(bucket) > self.window:
            self.history[track_id] = bucket[-self.window :]
            bucket = self.history[track_id]

        votes = Counter(bucket)
        identity, count = votes.most_common(1)[0]
        required = max(1, int(round(len(bucket) * self.ratio)))
        if count >= required:
            return identity
        return None
