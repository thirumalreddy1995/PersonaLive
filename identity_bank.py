"""
Multi-View Identity Bank Module (identity_bank.py)
==================================================
Ingests an arbitrary directory of calibrated reference portrait images for Person A
(frontal, yaw left/right, pitch up/down, laughing, open mouth/talking).

Extracts:
  1. Dense identity embeddings (InsightFace / ArcFace).
  2. 3D pose vectors (Yaw, Pitch, Roll) via Perspective-n-Point (cv2.solvePnP).
  3. Expression metrics (jaw openness / mouth aperture in [0.0, 1.0]).
  4. 512x512 aligned, cropped face chips with canonical landmark indexing.

Provides:
  - Dynamic pose/expression retrieval with hysteresis to eliminate single-image collapse
    and frame-to-frame switching jitter.
"""

import os
import glob
import logging
import math
from typing import List, Tuple, Optional
import cv2
import numpy as np

logger = logging.getLogger(__name__)

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

try:
    import mediapipe as mp
    HAS_MEDIAPIPE = True
except ImportError:
    HAS_MEDIAPIPE = False

try:
    import insightface
    from insightface.app import FaceAnalysis
    HAS_INSIGHTFACE = True
except ImportError:
    HAS_INSIGHTFACE = False


# Canonical 3D facial landmark model points for head pose estimation (in mm)
# Based on the anthropometric 3D face model
CANONICAL_3D_POINTS = np.array([
    [0.0, 0.0, 0.0],          # Nose tip (#1)
    [0.0, -63.6, -12.5],      # Chin (#152)
    [-43.3, 32.7, -26.0],     # Left eye outer corner (#263)
    [43.3, 32.7, -26.0],      # Right eye outer corner (#33)
    [-28.9, -28.9, -24.1],    # Left mouth corner (#291)
    [28.9, -28.9, -24.1]      # Right mouth corner (#61)
], dtype=np.float64)

# Corresponding MediaPipe FaceMesh indices
POSE_LANDMARK_INDICES = [1, 152, 263, 33, 291, 61]


class IdentityReferenceEntry:
    """Stores calibrated metadata and assets for a single reference image."""
    def __init__(
        self,
        image_path: str,
        full_image_bgr: np.ndarray,
        chip_512: np.ndarray,
        landmarks_468: np.ndarray,
        chip_landmarks_468: np.ndarray,
        yaw: float,
        pitch: float,
        roll: float,
        mouth_aperture: float,
        identity_embedding: Optional[np.ndarray] = None,
        is_mouth_open: bool = False
    ):
        self.image_path = image_path
        self.full_image_bgr = full_image_bgr
        self.chip_512 = chip_512
        self.landmarks_468 = landmarks_468
        self.chip_landmarks_468 = chip_landmarks_468
        self.yaw = yaw          # in degrees (-90 to +90)
        self.pitch = pitch      # in degrees (-90 to +90)
        self.roll = roll        # in degrees (-180 to +180)
        self.mouth_aperture = mouth_aperture  # normalized [0.0, 1.0]
        self.identity_embedding = identity_embedding
        self.is_mouth_open = is_mouth_open

    @property
    def pose_tuple(self) -> Tuple[float, float, float]:
        return (self.yaw, self.pitch, self.roll)


class MultiViewIdentityBank:
    """
    Ingests and indexes multi-angle and multi-expression photos of Target Person A.
    Enables dynamic, distance-weighted pose and expression querying to prevent
    single-image warping breakdown when the driver turns their head or speaks.
    """

    def __init__(
        self,
        reference_dir: Optional[str] = None,
        use_gpu: bool = True,
        min_detection_confidence: float = 0.5
    ):
        self.use_gpu = use_gpu and (torch.cuda.is_available() if HAS_TORCH else False)
        self.references: List[IdentityReferenceEntry] = []
        self.identity_embedding_mean: Optional[np.ndarray] = None

        # Initialize MediaPipe Face Mesh
        if HAS_MEDIAPIPE:
            self.mp_face_mesh = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=True,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=min_detection_confidence
            )
        else:
            self.mp_face_mesh = None

        # Initialize InsightFace for ArcFace identity embeddings
        self.face_app = None
        if HAS_INSIGHTFACE:
            try:
                providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if self.use_gpu else ['CPUExecutionProvider']
                self.face_app = FaceAnalysis(name='buffalo_l', providers=providers)
                self.face_app.prepare(ctx_id=0 if self.use_gpu else -1, det_size=(640, 640))
            except Exception as e:
                logger.warning("InsightFace initialisation failed; identity embeddings disabled: %s", e)
                self.face_app = None

        if reference_dir:
            self.load_directory(reference_dir)

    def compute_head_pose(
        self,
        landmarks: np.ndarray,
        img_w: int,
        img_h: int
    ) -> Tuple[float, float, float]:
        """
        Estimates head yaw, pitch, roll in degrees using Perspective-n-Point (cv2.solvePnP).
        """
        image_points = np.zeros((6, 2), dtype=np.float64)
        for i, idx in enumerate(POSE_LANDMARK_INDICES):
            image_points[i] = [landmarks[idx, 0] * img_w, landmarks[idx, 1] * img_h]

        focal_length = img_w
        center = (img_w / 2.0, img_h / 2.0)
        camera_matrix = np.array([
            [focal_length, 0, center[0]],
            [0, focal_length, center[1]],
            [0, 0, 1]
        ], dtype=np.float64)

        dist_coeffs = np.zeros((4, 1), dtype=np.float64)

        success, rvec, tvec = cv2.solvePnP(
            CANONICAL_3D_POINTS,
            image_points,
            camera_matrix,
            dist_coeffs,
            flags=cv2.SOLVEPNP_ITERATIVE
        )

        if not success:
            return 0.0, 0.0, 0.0

        rmat, _ = cv2.Rodrigues(rvec)
        # Compute Euler angles from rotation matrix
        sy = math.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2)
        singular = sy < 1e-6

        if not singular:
            pitch = math.atan2(rmat[2, 1], rmat[2, 2])
            yaw = math.atan2(-rmat[2, 0], sy)
            roll = math.atan2(rmat[1, 0], rmat[0, 0])
        else:
            pitch = math.atan2(-rmat[1, 2], rmat[1, 1])
            yaw = math.atan2(-rmat[2, 0], sy)
            roll = 0.0

        # Convert to degrees
        return math.degrees(yaw), math.degrees(pitch), math.degrees(roll)

    def compute_mouth_aperture(self, landmarks: np.ndarray, img_w: int, img_h: int) -> float:
        """
        Calculates normalized mouth aperture (jaw openness) in range [0.0, 1.0].
        Landmark 13 is upper inner lip center, 14 is lower inner lip center.
        Normalized by mouth corner width (landmarks 78 and 308).
        """
        pt_up = np.array([landmarks[13, 0] * img_w, landmarks[13, 1] * img_h])
        pt_low = np.array([landmarks[14, 0] * img_w, landmarks[14, 1] * img_h])
        pt_left = np.array([landmarks[78, 0] * img_w, landmarks[78, 1] * img_h])
        pt_right = np.array([landmarks[308, 0] * img_w, landmarks[308, 1] * img_h])

        vertical_dist = np.linalg.norm(pt_up - pt_low)
        horizontal_dist = np.linalg.norm(pt_left - pt_right) + 1e-6

        # Ratio of vertical opening to horizontal mouth width
        ratio = vertical_dist / horizontal_dist
        # Typical closed mouth ratio is ~0.02 - 0.05, wide open is ~0.5 - 0.7
        normalized = np.clip((ratio - 0.03) / 0.50, 0.0, 1.0)
        return float(normalized)

    def extract_aligned_chip(
        self,
        img_bgr: np.ndarray,
        landmarks: np.ndarray,
        chip_size: int = 512
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Extracts a stabilized, cropped, and aligned 512x512 face chip
        centered on the mid-point of the eyes and mouth.
        """
        h, w = img_bgr.shape[:2]
        pts = np.copy(landmarks[:, :2])
        pts[:, 0] *= w
        pts[:, 1] *= h

        # Eye centers
        left_eye = np.mean(pts[[33, 133, 159, 145]], axis=0)
        right_eye = np.mean(pts[[362, 263, 386, 374]], axis=0)
        eye_center = (left_eye + right_eye) / 2.0

        # Face center & scale
        dx = right_eye[0] - left_eye[0]
        dy = right_eye[1] - left_eye[1]
        dist = np.hypot(dx, dy) + 1e-6
        scale = (chip_size * 0.35) / dist

        # Center between eyes and chin
        chin = pts[152]
        face_center = (eye_center + chin) / 2.0

        # Similarity transformation matrix
        angle = math.degrees(math.atan2(dy, dx))
        rot_mat = cv2.getRotationMatrix2D(tuple(face_center), angle, scale)
        rot_mat[0, 2] += (chip_size / 2.0) - face_center[0]
        rot_mat[1, 2] += (chip_size / 2.0) - face_center[1]

        chip = cv2.warpAffine(
            img_bgr,
            rot_mat,
            (chip_size, chip_size),
            flags=cv2.INTER_LANCZOS4,
            borderMode=cv2.BORDER_REFLECT_101
        )

        # Transform landmarks into chip coordinate frame
        ones = np.ones((pts.shape[0], 1))
        homog = np.hstack([pts, ones])
        chip_pts = (rot_mat @ homog.T).T
        chip_pts_norm = chip_pts / chip_size

        return chip, chip_pts_norm

    def add_reference_image(self, image_path: str) -> Optional[IdentityReferenceEntry]:
        """
        Processes a single reference image, extracts landmarks, pose, aperture,
        ArcFace embedding, and registers it into the bank.
        """
        if not os.path.exists(image_path):
            logger.warning("Reference image not found: %s", image_path)
            return None

        img_bgr = cv2.imread(image_path)
        if img_bgr is None:
            logger.warning("Could not decode reference image: %s", image_path)
            return None

        h, w = img_bgr.shape[:2]
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

        # Detect landmarks
        landmarks = None
        if self.mp_face_mesh:
            results = self.mp_face_mesh.process(img_rgb)
            if results.multi_face_landmarks:
                fl = results.multi_face_landmarks[0]
                landmarks = np.array([[lm.x, lm.y, lm.z] for lm in fl.landmark], dtype=np.float32)

        if landmarks is None:
            # Fallback estimation if no mesh was extracted
            logger.warning("No face mesh detected in reference image: %s", image_path)
            return None

        # Compute pose and expression metrics
        yaw, pitch, roll = self.compute_head_pose(landmarks, w, h)
        aperture = self.compute_mouth_aperture(landmarks, w, h)
        is_mouth_open = aperture > 0.15

        # Extract 512x512 aligned chip
        chip_512, chip_landmarks = self.extract_aligned_chip(img_bgr, landmarks, chip_size=512)

        # Extract InsightFace embedding if available
        embedding = None
        if self.face_app is not None:
            faces = self.face_app.get(img_bgr)
            if faces:
                embedding = faces[0].embedding
                embedding = embedding / (np.linalg.norm(embedding) + 1e-6)

        entry = IdentityReferenceEntry(
            image_path=image_path,
            full_image_bgr=img_bgr,
            chip_512=chip_512,
            landmarks_468=landmarks,
            chip_landmarks_468=chip_landmarks,
            yaw=yaw,
            pitch=pitch,
            roll=roll,
            mouth_aperture=aperture,
            identity_embedding=embedding,
            is_mouth_open=is_mouth_open
        )

        self.references.append(entry)
        logger.info(
            "Ingested '%s': yaw=%.1f pitch=%.1f aperture=%.2f mouth_open=%s",
            os.path.basename(image_path), yaw, pitch, aperture, is_mouth_open,
        )
        return entry

    def load_directory(self, directory_path: str) -> int:
        """
        Loads all JPEG, PNG, WEBP files from a directory into the identity bank.
        """
        patterns = ["*.jpg", "*.jpeg", "*.png", "*.webp", "*.JPG", "*.JPEG", "*.PNG"]
        all_files = []
        for pat in patterns:
            all_files.extend(glob.glob(os.path.join(directory_path, pat)))

        all_files = sorted(list(set(all_files)))
        count = 0
        for f in all_files:
            if self.add_reference_image(f) is not None:
                count += 1

        # Compute mean identity embedding across the bank
        embeddings = [ref.identity_embedding for ref in self.references if ref.identity_embedding is not None]
        if embeddings:
            self.identity_embedding_mean = np.mean(embeddings, axis=0)
            self.identity_embedding_mean /= (np.linalg.norm(self.identity_embedding_mean) + 1e-6)

        logger.info("Total references ingested: %d", count)
        return count

    def get_best_reference(
        self,
        driver_pose: Tuple[float, float, float],
        driver_mouth_aperture: float,
        prev_ref_idx: Optional[int] = None,
        hysteresis: float = 0.20
    ) -> Tuple[IdentityReferenceEntry, int]:
        """
        Dynamically selects the optimal reference image closest to the current driver
        head pose (yaw, pitch, roll) and expression state (jaw openness).

        Applies hysteresis to the previous reference index to prevent high-frequency
        switching jitter between two near-identical pose candidates.
        """
        if not self.references:
            raise RuntimeError("Identity bank is empty. Ingest at least one reference image.")

        if len(self.references) == 1:
            return self.references[0], 0

        driver_yaw, driver_pitch, driver_roll = driver_pose

        # Feature weights for distance metric
        w_yaw = 1.0
        w_pitch = 1.2
        w_roll = 0.5
        w_mouth = 35.0  # Emphasize mouth opening match (e.g. speaking vs closed)

        best_idx = 0
        min_dist = float('inf')

        for i, ref in enumerate(self.references):
            dyaw = (driver_yaw - ref.yaw)
            dpitch = (driver_pitch - ref.pitch)
            droll = (driver_roll - ref.roll)
            dmouth = (driver_mouth_aperture - ref.mouth_aperture)

            dist = math.sqrt(
                w_yaw * (dyaw ** 2) +
                w_pitch * (dpitch ** 2) +
                w_roll * (droll ** 2) +
                w_mouth * (dmouth ** 2)
            )

            # Apply hysteresis bonus to the active reference
            if prev_ref_idx is not None and i == prev_ref_idx:
                dist *= (1.0 - hysteresis)

            if dist < min_dist:
                min_dist = dist
                best_idx = i

        return self.references[best_idx], best_idx

    def get_open_mouth_reference(self) -> Optional[IdentityReferenceEntry]:
        """
        Returns the reference with the highest mouth aperture and visible dental structure,
        used by the oral cavity renderer during speech synthesis.
        """
        if not self.references:
            return None

        # Filter by open mouth flag or highest aperture
        open_refs = [r for r in self.references if r.is_mouth_open]
        if open_refs:
            return max(open_refs, key=lambda r: r.mouth_aperture)

        # Fallback to whatever has maximum aperture
        return max(self.references, key=lambda r: r.mouth_aperture)
