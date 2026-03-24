import os
from dataclasses import dataclass
from threading import Lock
from typing import List, Optional

import cv2
import numpy as np
from insightface.app import FaceAnalysis

from utils import normalize_embedding, resize_with_max_width


@dataclass
class FaceDetection:
    bbox: np.ndarray
    kps: np.ndarray
    det_score: float
    embedding: np.ndarray


class InsightFaceDetector:
    def __init__(self) -> None:
        self._lock = Lock()
        self._analyzer: Optional[FaceAnalysis] = None
        self.fast_mode = os.getenv("FACE_FAST_MODE", "1").lower() in {"1", "true", "yes", "on"}
        default_model_pack = "buffalo_s" if self.fast_mode else "antelopev2"
        self.model_pack = os.getenv("FACE_MODEL_PACK", default_model_pack)
        self.active_model_pack = self.model_pack
        self.det_size = int(os.getenv("FACE_DET_SIZE", "320" if self.fast_mode else "640"))
        self.max_frame_width = int(os.getenv("FACE_MAX_FRAME_WIDTH", "480" if self.fast_mode else "640"))
        self.max_faces = int(os.getenv("FACE_MAX_FACES", "2" if self.fast_mode else "5"))

    def _get_analyzer(self) -> FaceAnalysis:
        if self._analyzer is None:
            with self._lock:
                if self._analyzer is None:
                    requested_pack = (self.model_pack or "").strip() or "antelopev2"
                    fallback_packs = ["buffalo_s", "buffalo_m", "buffalo_l", "antelopev2"]
                    candidate_packs = [requested_pack]
                    candidate_packs.extend([pack for pack in fallback_packs if pack != requested_pack])

                    last_error: Optional[Exception] = None
                    for pack in candidate_packs:
                        try:
                            analyzer = FaceAnalysis(name=pack, providers=["CPUExecutionProvider"])
                            analyzer.prepare(ctx_id=0, det_size=(self.det_size, self.det_size))
                            self._analyzer = analyzer
                            self.active_model_pack = pack
                            break
                        except Exception as error:
                            last_error = error

                    if self._analyzer is None:
                        raise RuntimeError(
                            f"Unable to initialize InsightFace model pack. Tried: {', '.join(candidate_packs)}"
                        ) from last_error
        return self._analyzer

    def detect(self, frame_bgr: np.ndarray) -> List[FaceDetection]:
        resized, scale = resize_with_max_width(frame_bgr, self.max_frame_width)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)

        analyzer = self._get_analyzer()
        faces = analyzer.get(rgb)
        if not faces:
            return []

        if self.max_faces > 0 and len(faces) > self.max_faces:
            faces = sorted(
                faces,
                key=lambda face: float((face.bbox[2] - face.bbox[0]) * (face.bbox[3] - face.bbox[1])),
                reverse=True,
            )[: self.max_faces]

        detections: List[FaceDetection] = []
        inv_scale = (1.0 / scale) if scale > 0 else 1.0

        for face in faces:
            bbox = getattr(face, "bbox", None)
            kps = getattr(face, "kps", None)
            det_score = float(getattr(face, "det_score", 0.0))

            embedding = getattr(face, "normed_embedding", None)
            if embedding is None:
                embedding = getattr(face, "embedding", None)

            if bbox is None or embedding is None:
                continue

            bbox_arr = np.array(bbox, dtype=np.float32) * inv_scale
            if kps is not None:
                kps_arr = np.array(kps, dtype=np.float32) * inv_scale
            else:
                kps_arr = np.zeros((5, 2), dtype=np.float32)

            detections.append(
                FaceDetection(
                    bbox=bbox_arr,
                    kps=kps_arr,
                    det_score=det_score,
                    embedding=normalize_embedding(np.array(embedding, dtype=np.float32)),
                )
            )

        detections.sort(key=lambda d: float((d.bbox[2] - d.bbox[0]) * (d.bbox[3] - d.bbox[1])), reverse=True)
        return detections
