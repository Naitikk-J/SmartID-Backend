import base64
import math
from dataclasses import dataclass
from typing import Dict, List, Tuple

import cv2
import numpy as np
from fastapi import HTTPException


@dataclass
class QualityMetrics:
    face_width: float
    blur_var: float
    brightness: float
    yaw_deg: float
    pitch_deg: float
    score: float
    is_valid: bool
    reject_reasons: List[str]


def decode_data_url(data_url: str) -> np.ndarray:
    try:
        encoded = data_url.split(',', 1)[1] if ',' in data_url else data_url
        raw = base64.b64decode(encoded)
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Unable to decode image")
        return image
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image payload: {exc}")


def resize_with_max_width(image: np.ndarray, target_width: int = 640) -> Tuple[np.ndarray, float]:
    h, w = image.shape[:2]
    if w <= target_width:
        return image, 1.0

    scale = target_width / float(w)
    resized = cv2.resize(image, (target_width, int(h * scale)), interpolation=cv2.INTER_AREA)
    return resized, scale


def normalize_embedding(vector: np.ndarray) -> np.ndarray:
    arr = np.array(vector, dtype=np.float32).flatten()
    norm = float(np.linalg.norm(arr))
    if norm <= 1e-8:
        return arr
    return (arr / norm).astype(np.float32)


def laplacian_blur_variance(image_bgr: np.ndarray) -> float:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def frame_brightness(image_bgr: np.ndarray) -> float:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    return float(np.mean(gray))


def estimate_pose_from_5pts(kps: np.ndarray) -> Tuple[float, float]:
    if kps is None or len(kps) < 5:
        return 0.0, 0.0

    left_eye = kps[0]
    right_eye = kps[1]
    nose = kps[2]
    mouth_left = kps[3]
    mouth_right = kps[4]

    eye_mid_x = (left_eye[0] + right_eye[0]) / 2.0
    eye_mid_y = (left_eye[1] + right_eye[1]) / 2.0
    mouth_mid_y = (mouth_left[1] + mouth_right[1]) / 2.0

    eye_dist = max(1.0, abs(right_eye[0] - left_eye[0]))
    face_vert = max(1.0, abs(mouth_mid_y - eye_mid_y))

    yaw_ratio = (nose[0] - eye_mid_x) / eye_dist
    pitch_ratio = (nose[1] - (eye_mid_y + mouth_mid_y) / 2.0) / face_vert

    yaw_deg = float(yaw_ratio * 60.0)
    pitch_deg = float(pitch_ratio * 50.0)
    return yaw_deg, pitch_deg


def evaluate_face_quality(
    frame_bgr: np.ndarray,
    bbox_xyxy: np.ndarray,
    kps: np.ndarray,
    *,
    min_face_width: float = 100.0,
    min_blur_var: float = 65.0,
    min_brightness: float = 55.0,
    max_brightness: float = 210.0,
    max_abs_yaw: float = 35.0,
    max_abs_pitch: float = 30.0,
) -> QualityMetrics:
    h, w = frame_bgr.shape[:2]
    x1 = max(0, min(w - 1, int(bbox_xyxy[0])))
    y1 = max(0, min(h - 1, int(bbox_xyxy[1])))
    x2 = max(x1 + 1, min(w, int(bbox_xyxy[2])))
    y2 = max(y1 + 1, min(h, int(bbox_xyxy[3])))

    roi = frame_bgr[y1:y2, x1:x2]
    face_width = float(max(1, x2 - x1))

    if roi.size == 0:
        return QualityMetrics(
            face_width=face_width,
            blur_var=0.0,
            brightness=0.0,
            yaw_deg=0.0,
            pitch_deg=0.0,
            score=0.0,
            is_valid=False,
            reject_reasons=["empty_face_roi"],
        )

    blur_var = laplacian_blur_variance(roi)
    brightness = frame_brightness(roi)
    yaw_deg, pitch_deg = estimate_pose_from_5pts(kps)

    reject_reasons: List[str] = []
    if face_width < min_face_width:
        reject_reasons.append("face_too_small")
    if blur_var < min_blur_var:
        reject_reasons.append("too_blurry")
    if brightness < min_brightness:
        reject_reasons.append("too_dark")
    if brightness > max_brightness:
        reject_reasons.append("too_bright")
    if abs(yaw_deg) > max_abs_yaw:
        reject_reasons.append("yaw_too_large")
    if abs(pitch_deg) > max_abs_pitch:
        reject_reasons.append("pitch_too_large")

    size_score = min(100.0, (face_width / 180.0) * 100.0)
    blur_score = min(100.0, (blur_var / 180.0) * 100.0)
    brightness_score = max(0.0, 100.0 - abs(brightness - 128.0) * 1.1)
    pose_score = max(0.0, 100.0 - ((abs(yaw_deg) * 1.5) + (abs(pitch_deg) * 1.2)))

    score = float(round(
        (size_score * 0.30)
        + (blur_score * 0.30)
        + (brightness_score * 0.20)
        + (pose_score * 0.20),
        2,
    ))

    return QualityMetrics(
        face_width=face_width,
        blur_var=blur_var,
        brightness=brightness,
        yaw_deg=yaw_deg,
        pitch_deg=pitch_deg,
        score=score,
        is_valid=len(reject_reasons) == 0,
        reject_reasons=reject_reasons,
    )


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    if a.size == 0 or b.size == 0:
        return -1.0
    dot = float(np.dot(a, b))
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 1e-8:
        return -1.0
    return max(-1.0, min(1.0, dot / denom))


def weighted_average_embeddings(embeddings: List[np.ndarray], weights: List[float]) -> np.ndarray:
    if not embeddings:
        return np.array([], dtype=np.float32)
    if len(embeddings) != len(weights):
        weights = [1.0 for _ in embeddings]

    matrix = np.vstack(embeddings)
    w = np.array(weights, dtype=np.float32)
    if float(np.sum(w)) <= 1e-8:
        w = np.ones_like(w)
    avg = np.average(matrix, axis=0, weights=w)
    return normalize_embedding(avg)


def now_seconds() -> float:
    return float(cv2.getTickCount() / cv2.getTickFrequency())


def softmax(values: List[float]) -> List[float]:
    if not values:
        return []
    m = max(values)
    exps = [math.exp(v - m) for v in values]
    s = sum(exps)
    if s <= 1e-8:
        return [0.0 for _ in values]
    return [e / s for e in exps]


def format_reject_debug(track_id: int, reasons: List[str], score: float) -> Dict[str, object]:
    return {
        "trackId": track_id,
        "rejected": True,
        "reasons": reasons,
        "qualityScore": float(round(score, 2)),
    }
