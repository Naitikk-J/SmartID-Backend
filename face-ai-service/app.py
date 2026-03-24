import os
import time
from typing import Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from detection import InsightFaceDetector
from recognition import WalkThroughRecognitionEngine
from utils import decode_data_url, normalize_embedding


app = FastAPI(title="MITS Face AI Service", version="2.0.0")
detector = InsightFaceDetector()
engine_by_stream = {}
stream_extract_cache: Dict[str, dict] = {}
stream_min_interval_ms = int(os.getenv("FACE_STREAM_MIN_INTERVAL_MS", "120"))


class ExtractRequest(BaseModel):
    imageFrame: str
    streamId: Optional[str] = "default"


class BatchExtractRequest(BaseModel):
    faceImages: List[str] = Field(min_length=1)


class CompareRequest(BaseModel):
    descriptorA: List[float] = Field(min_length=128)
    descriptorB: List[float] = Field(min_length=128)


class ExtractResponse(BaseModel):
    descriptor: List[float] = Field(default_factory=list)
    descriptors: List[List[float]] = Field(default_factory=list)
    liveDescriptorIndexes: List[int] = Field(default_factory=list)
    trackedFaces: List[dict] = Field(default_factory=list)
    qualityScore: float = 0.0
    faceCount: int = 0
    antiSpoofScore: float = 0.0
    isLive: bool = False


def _get_engine(stream_id: str) -> WalkThroughRecognitionEngine:
    if stream_id not in engine_by_stream:
        engine_by_stream[stream_id] = WalkThroughRecognitionEngine()
    return engine_by_stream[stream_id]


def _empty_extract_response() -> dict:
    return {
        "descriptor": [],
        "descriptors": [],
        "liveDescriptorIndexes": [],
        "trackedFaces": [],
        "qualityScore": 0.0,
        "faceCount": 0,
        "antiSpoofScore": 0.0,
        "isLive": False,
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "recognition": "ArcFace",
        "modelPack": detector.active_model_pack,
        "requestedModelPack": detector.model_pack,
        "detectorSize": detector.det_size,
        "maxFrameWidth": detector.max_frame_width,
        "maxFaces": detector.max_faces,
        "fastMode": detector.fast_mode,
        "streamMinIntervalMs": stream_min_interval_ms,
        "frameStride": int(detector.max_frame_width > 0) and _get_engine("default").frame_stride,
    }


@app.post("/extract", response_model=ExtractResponse)
def extract_face(request: ExtractRequest):
    stream_id = request.streamId or "default"
    now_ms = int(time.time() * 1000)

    cached = stream_extract_cache.get(stream_id)
    if (
        stream_min_interval_ms > 0
        and cached
        and (now_ms - int(cached.get("ts", 0))) < stream_min_interval_ms
        and isinstance(cached.get("payload"), dict)
    ):
        return cached["payload"]

    image = decode_data_url(request.imageFrame)
    detections = detector.detect(image)
    if not detections:
        payload = _empty_extract_response()
        stream_extract_cache[stream_id] = {"ts": now_ms, "payload": payload}
        return payload

    engine = _get_engine(stream_id)
    tracks = engine.process(image, detections)

    tracked_faces = []
    descriptors: List[List[float]] = []
    live_indexes: List[int] = []

    for track in tracks:
        descriptor = track.descriptor if track.ready_for_recognition else []
        tracked_faces.append({
            "trackId": int(track.track_id),
            "descriptor": descriptor,
            "antiSpoofScore": float(track.quality_score),
            "isLive": bool(track.is_live and track.ready_for_recognition),
            "bbox": [float(v) for v in track.bbox],
            "detScore": float(track.det_score),
            "framesSeen": int(track.frames_seen),
            "elapsedSec": float(track.elapsed_sec),
            "readyForRecognition": bool(track.ready_for_recognition),
            "rejectReasons": list(track.reject_reasons),
        })
        if descriptor:
            descriptors.append(descriptor)
            if track.is_live:
                live_indexes.append(len(descriptors) - 1)

    if not tracked_faces:
        payload = _empty_extract_response()
        stream_extract_cache[stream_id] = {"ts": now_ms, "payload": payload}
        return payload

    primary_face = tracked_faces[0]
    primary_descriptor = descriptors[0] if descriptors else []

    payload = {
        "descriptor": primary_descriptor,
        "descriptors": descriptors,
        "liveDescriptorIndexes": live_indexes,
        "trackedFaces": tracked_faces,
        "qualityScore": float(round(primary_face.get("antiSpoofScore", 0.0), 2)),
        "faceCount": len(tracked_faces),
        "antiSpoofScore": primary_face["antiSpoofScore"],
        "isLive": len(live_indexes) > 0,
    }
    stream_extract_cache[stream_id] = {"ts": now_ms, "payload": payload}
    return payload


@app.post("/extract-batch", response_model=ExtractResponse)
def extract_batch(request: BatchExtractRequest):
    descriptors = []
    all_descriptors = []
    quality_scores = []
    anti_spoof_scores = []
    live_indexes = []

    for idx, image_data in enumerate(request.faceImages):
        image = decode_data_url(image_data)
        detections = detector.detect(image)
        if not detections:
            continue

        best = detections[0]
        descriptor = normalize_embedding(best.embedding)
        all_descriptors.append(descriptor.astype(np.float32).tolist())
        descriptors.append(descriptor)
        quality_scores.append(float(min(100.0, max(0.0, best.det_score * 100.0))))
        anti_spoof_scores.append(float(min(100.0, max(0.0, best.det_score * 100.0))))
        if best.det_score >= 0.55:
            live_indexes.append(idx)

    if not descriptors:
        raise HTTPException(status_code=422, detail="No detectable face found in captures")

    if len(live_indexes) == 0:
        raise HTTPException(status_code=422, detail="Anti-spoofing failed: liveness not detected")

    if len(live_indexes) < 2 and len(descriptors) >= 2:
        raise HTTPException(status_code=422, detail="Need at least 2 live captures for reliable enrollment")

    live_descriptors = [descriptors[i] for i in live_indexes if i < len(descriptors)]
    reference_vectors = live_descriptors if live_descriptors else descriptors
    stacked = np.vstack(reference_vectors)
    avg_descriptor = np.mean(stacked, axis=0)
    avg_descriptor = normalize_embedding(avg_descriptor)
    avg_quality = float(round(float(np.mean(quality_scores)), 2)) if quality_scores else 0.0
    avg_anti_spoof = float(round(float(np.mean(anti_spoof_scores)), 2)) if anti_spoof_scores else 0.0

    return {
        "descriptor": avg_descriptor.astype(np.float32).tolist(),
        "descriptors": all_descriptors,
        "liveDescriptorIndexes": live_indexes,
        "trackedFaces": [],
        "qualityScore": avg_quality,
        "faceCount": len(descriptors),
        "antiSpoofScore": avg_anti_spoof,
        "isLive": len(live_indexes) >= max(1, len(descriptors) // 2),
    }


@app.post("/compare")
def compare(request: CompareRequest):
    a = normalize_embedding(np.array(request.descriptorA, dtype=np.float32))
    b = normalize_embedding(np.array(request.descriptorB, dtype=np.float32))
    length = min(len(a), len(b))
    if length < 128:
        raise HTTPException(status_code=400, detail="Descriptor length mismatch")
    similarity = float(np.dot(a[:length], b[:length]))
    distance = float(np.sqrt(max(0.0, 2.0 - (2.0 * similarity))))
    confidence = float(max(0.0, ((similarity + 1.0) / 2.0) * 100.0))

    return {
        "distance": round(distance, 4),
        "similarity": round(similarity, 4),
        "confidence": round(confidence, 2),
        "matched": similarity >= 0.65,
    }
