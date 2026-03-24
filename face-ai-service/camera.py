import queue
import threading
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np


@dataclass
class FramePacket:
    frame: np.ndarray
    timestamp: float


class AsyncCamera:
    def __init__(self, src: int = 0, queue_size: int = 4) -> None:
        self.src = src
        self.cap: Optional[cv2.VideoCapture] = None
        self.queue: "queue.Queue[FramePacket]" = queue.Queue(maxsize=queue_size)
        self._thread: Optional[threading.Thread] = None
        self._running = False

    def start(self) -> None:
        if self._running:
            return
        self.cap = cv2.VideoCapture(self.src)
        self._running = True
        self._thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._thread.start()

    def _reader_loop(self) -> None:
        if self.cap is None:
            return

        while self._running:
            ok, frame = self.cap.read()
            if not ok:
                continue
            packet = FramePacket(frame=frame, timestamp=cv2.getTickCount() / cv2.getTickFrequency())
            if self.queue.full():
                try:
                    self.queue.get_nowait()
                except queue.Empty:
                    pass
            self.queue.put(packet)

    def get_latest(self, timeout: float = 0.2) -> Optional[FramePacket]:
        try:
            return self.queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def stop(self) -> None:
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        if self.cap is not None:
            self.cap.release()
            self.cap = None
