"""
Full Real-Time Reenactment Loop Orchestrator (main_stream.py)
=============================================================
Connects webcam or test video feed, detects driver head pose and expressions in real-time,
queries MultiViewIdentityBank for optimal reference angle, warps identity geometry,
synthesizes oral interior and dental structures, and blends seamlessly across the hairline.

Usage:
  python main_stream.py --ref_dir ./public/assets/aistudio
  python main_stream.py --camera 0 --ref_dir ./references --mode split
  python main_stream.py --video ./public/assets/aistudio/WhatsApp_Video_2026-11-03_at_9.00.12_PM_cc7a2b70.mp4
"""

import os
import time
import argparse
import logging
from typing import Any, List, Tuple, Optional
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

from identity_bank import MultiViewIdentityBank, IdentityReferenceEntry
from blender import AnatomicalBlender
from mouth_render import OralCavityRenderer


# Subsampled landmark mesh indices for ultra-fast real-time Delaunay warping
CORE_WARP_INDICES = [
    # Silhouette & Jawline
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
    # Eyebrows
    70, 63, 105, 66, 107, 336, 296, 334, 293, 300,
    # Eyes & Irises
    33, 133, 159, 145, 362, 263, 386, 374, 468, 473,
    # Nose
    1, 2, 98, 327, 195, 197, 5, 4,
    # Cheeks & Temples
    117, 346, 187, 411, 50, 280, 123, 352,
    # Outer Lips
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 185, 40, 39, 37, 0, 267, 269, 270, 409
]


def warp_triangle(img_src: np.ndarray, img_dst: np.ndarray, t_src: np.ndarray, t_dst: np.ndarray):
    """Warps an individual triangular mesh facet using local affine transformation."""
    # Bounding rectangles for source and target triangles
    r1 = cv2.boundingRect(np.float32([t_src]))
    r2 = cv2.boundingRect(np.float32([t_dst]))

    # Zero-area (collinear) triangles have no affine mapping; skipping them keeps the stream alive.
    if r1[2] <= 0 or r1[3] <= 0 or r2[2] <= 0 or r2[3] <= 0:
        return

    # Offset points by top-left bounds
    t1_rect = []
    t2_rect = []
    for i in range(3):
        t1_rect.append(((t_src[i][0] - r1[0]), (t_src[i][1] - r1[1])))
        t2_rect.append(((t_dst[i][0] - r2[0]), (t_dst[i][1] - r2[1])))

    # Create mask for target triangle
    mask = np.zeros((r2[3], r2[2], 3), dtype=np.float32)
    cv2.fillConvexPoly(mask, np.int32(t2_rect), (1.0, 1.0, 1.0), 16, 0)

    # Crop source patch (may be empty when a landmark sits outside the reference image)
    img1_rect = img_src[r1[1]:r1[1] + r1[3], r1[0]:r1[0] + r1[2]]
    if img1_rect.size == 0:
        return

    # Affine transform
    try:
        warp_mat = cv2.getAffineTransform(np.float32(t1_rect), np.float32(t2_rect))
    except cv2.error as e:
        logger.debug("Skipping degenerate triangle: %s", e)
        return
    img2_rect = cv2.warpAffine(
        img1_rect,
        warp_mat,
        (r2[2], r2[3]),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101
    )

    # Composite into destination (the target rect can be clipped at the frame border)
    dst_sub = img_dst[r2[1]:r2[1] + r2[3], r2[0]:r2[0] + r2[2]]
    if dst_sub.shape != img2_rect.shape:
        return
    img_dst[r2[1]:r2[1] + r2[3], r2[0]:r2[0] + r2[2]] = dst_sub * (1.0 - mask) + img2_rect * mask


def piecewise_affine_mesh_warp(
    src_img: np.ndarray,
    src_landmarks_norm: np.ndarray,
    dst_landmarks_norm: np.ndarray,
    dst_shape: Tuple[int, int]
) -> np.ndarray:
    """
    Warps the reference face image onto the destination geometry using Delaunay Triangulation.
    """
    h_src, w_src = src_img.shape[:2]
    h_dst, w_dst = dst_shape[:2]

    # Convert normalized landmarks to pixel coords
    src_pts = np.zeros((len(CORE_WARP_INDICES), 2), dtype=np.float32)
    dst_pts = np.zeros((len(CORE_WARP_INDICES), 2), dtype=np.float32)

    for i, idx in enumerate(CORE_WARP_INDICES):
        src_pts[i] = [src_landmarks_norm[idx, 0] * w_src, src_landmarks_norm[idx, 1] * h_src]
        dst_pts[i] = [dst_landmarks_norm[idx, 0] * w_dst, dst_landmarks_norm[idx, 1] * h_dst]

    # Compute Delaunay triangulation on destination points
    rect = (0, 0, w_dst, h_dst)
    subdiv = cv2.Subdiv2D(rect)
    for p in dst_pts:
        if 0 <= p[0] < w_dst and 0 <= p[1] < h_dst:
            subdiv.insert((float(p[0]), float(p[1])))

    triangles = subdiv.getTriangleList()
    warped_output = np.zeros((h_dst, w_dst, 3), dtype=np.uint8)

    for t in triangles:
        pt_dst_tri = np.array([[t[0], t[1]], [t[2], t[3]], [t[4], t[5]]], dtype=np.float32)

        # Check bounds
        if (pt_dst_tri[:, 0] < 0).any() or (pt_dst_tri[:, 0] >= w_dst).any() or \
           (pt_dst_tri[:, 1] < 0).any() or (pt_dst_tri[:, 1] >= h_dst).any():
            continue

        # Find corresponding indices in dst_pts
        idx_tri = []
        for p in pt_dst_tri:
            dists = np.linalg.norm(dst_pts - p, axis=1)
            idx_tri.append(int(np.argmin(dists)))

        if len(set(idx_tri)) < 3:
            continue

        pt_src_tri = np.array([src_pts[idx_tri[0]], src_pts[idx_tri[1]], src_pts[idx_tri[2]]], dtype=np.float32)

        warp_triangle(src_img, warped_output, pt_src_tri, pt_dst_tri)

    return warped_output


class NeuralReenactmentPipeline:
    """Full-stack neural face reenactment pipeline."""

    def __init__(
        self,
        reference_dir: str,
        use_gpu: bool = True,
        display_mode: str = "ai_only"
    ):
        self.use_gpu = use_gpu and (torch.cuda.is_available() if HAS_TORCH else False)
        self.display_mode = display_mode  # "ai_only", "split", "side_by_side"
        self.show_mesh = False

        logger.info("Initializing on %s", "CUDA / GPU" if self.use_gpu else "CPU")

        # 1. Ingest Multi-View Reference Bank
        self.identity_bank = MultiViewIdentityBank(
            reference_dir=reference_dir,
            use_gpu=self.use_gpu
        )
        if len(self.identity_bank.references) == 0:
            raise RuntimeError(f"No reference images found in {reference_dir}")

        # 2. Initialize Anatomical Cranial Blender
        self.blender = AnatomicalBlender(
            cranial_extension_factor=0.28,
            feather_radius=25,
            lab_color_blend_ratio=0.85
        )

        # 3. Initialize Oral Cavity & Denture Renderer
        self.mouth_renderer = OralCavityRenderer(
            min_aperture_px=4.5,
            temporal_alpha=0.72,
            use_optical_flow_smoothing=True
        )

        # 4. Live MediaPipe FaceMesh Tracker
        if not HAS_MEDIAPIPE:
            raise RuntimeError("MediaPipe is required. Please install via: pip install mediapipe")

        self.mp_face_mesh = mp.solutions.face_mesh.FaceMesh(
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )

        # State tracking
        self.active_ref_idx: Optional[int] = None
        self.fps_history: List[float] = []

    def process_frame(self, driver_frame_bgr: np.ndarray) -> np.ndarray:
        """Processes a single driver video frame end-to-end."""
        h, w = driver_frame_bgr.shape[:2]
        frame_rgb = cv2.cvtColor(driver_frame_bgr, cv2.COLOR_BGR2RGB)

        # 1. Detect Driver Landmarks
        results = self.mp_face_mesh.process(frame_rgb)
        if not results.multi_face_landmarks:
            # No face detected in driver frame: pass through untouched
            return driver_frame_bgr

        driver_landmarks = np.array(
            [[lm.x, lm.y, lm.z] for lm in results.multi_face_landmarks[0].landmark],
            dtype=np.float32
        )

        # 2. Extract Driver Head Pose & Jaw Aperture
        driver_pose = self.identity_bank.compute_head_pose(driver_landmarks, w, h)
        driver_aperture = self.identity_bank.compute_mouth_aperture(driver_landmarks, w, h)

        # 3. Query Best Reference from Identity Bank
        best_ref, ref_idx = self.identity_bank.get_best_reference(
            driver_pose=driver_pose,
            driver_mouth_aperture=driver_aperture,
            prev_ref_idx=self.active_ref_idx,
            hysteresis=0.20
        )
        self.active_ref_idx = ref_idx

        # 4. Mesh Deformation (Warping Persona onto Driver Geometry)
        warped_persona = piecewise_affine_mesh_warp(
            src_img=best_ref.full_image_bgr,
            src_landmarks_norm=best_ref.landmarks_468,
            dst_landmarks_norm=driver_landmarks,
            dst_shape=(h, w)
        )

        # 5. Realistic Intra-Oral & Denture Rendering
        # If mouth is open while speaking, synthesize realistic dental cavity
        mouth_synthesized = self.mouth_renderer.render_intra_oral_cavity(
            base_frame_bgr=warped_persona,
            driver_landmarks_norm=driver_landmarks,
            ref_entry=best_ref
        )

        # 6. Anatomical Cranial Blending & Color Harmonization
        final_composite = self.blender.blend_composite(
            warped_face_bgr=mouth_synthesized,
            driver_frame_bgr=driver_frame_bgr,
            driver_landmarks=driver_landmarks,
            use_poisson=True
        )

        # 7. Optional Debug Overlay (Landmark Mesh)
        if self.show_mesh:
            for idx in CORE_WARP_INDICES:
                x = int(driver_landmarks[idx, 0] * w)
                y = int(driver_landmarks[idx, 1] * h)
                cv2.circle(final_composite, (x, y), 1, (0, 255, 255), -1)

        # 8. Display Mode Compositing
        if self.display_mode == "split":
            split_x = w // 2
            output = driver_frame_bgr.copy()
            output[:, split_x:] = final_composite[:, split_x:]
            cv2.line(output, (split_x, 0), (split_x, h), (0, 255, 200), 2)
        elif self.display_mode == "side_by_side":
            output = np.hstack([driver_frame_bgr, final_composite])
        else:  # "ai_only"
            output = final_composite

        # 9. Watermark & Pose Telemetry
        cv2.putText(
            output,
            "AI-TRANSFORMED PERSONA",
            (16, h - 20),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (0, 0, 0),
            3,
            cv2.LINE_AA
        )
        cv2.putText(
            output,
            "AI-TRANSFORMED PERSONA",
            (16, h - 20),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            1,
            cv2.LINE_AA
        )

        return output

    def run_stream(self, source: Any = 0, save_output: Optional[str] = None):
        """Starts real-time webcam or video stream loop."""
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            logger.error("Cannot open video source: %s", source)
            return

        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720
        fps_in = cap.get(cv2.CAP_PROP_FPS) or 30.0

        logger.info("Video source opened: %dx%d @ %.1f FPS", w, h, fps_in)
        # Interactive key bindings are user-facing help, so they stay on stdout.
        print("[Pipeline] Controls:")
        print("  'q' - Quit stream")
        print("  'm' - Cycle display mode (AI only / Split / Side-by-side)")
        print("  'd' - Toggle landmark mesh debug overlay")
        print("  's' - Save snapshot PNG")

        writer = None
        if save_output:
            fourcc = cv2.VideoWriter_fourcc(*'mp4v')
            out_w = w * 2 if self.display_mode == "side_by_side" else w
            writer = cv2.VideoWriter(save_output, fourcc, fps_in, (out_w, h))

        prev_time = time.time()
        frame_count = 0

        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    logger.info("Video stream ended or EOF.")
                    break

                t_start = time.time()
                result = self.process_frame(frame)
                dt = time.time() - t_start

                # FPS calculation
                fps = 1.0 / (dt + 1e-6)
                self.fps_history.append(fps)
                if len(self.fps_history) > 30:
                    self.fps_history.pop(0)
                avg_fps = sum(self.fps_history) / len(self.fps_history)

                # Overlay FPS
                cv2.putText(
                    result,
                    f"FPS: {avg_fps:.1f} | Ref #{self.active_ref_idx}",
                    (16, 32),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (0, 255, 0),
                    2,
                    cv2.LINE_AA
                )

                if writer is not None:
                    writer.write(result)

                cv2.imshow("PersonaLive Neural Reenactment Studio", result)

                key = cv2.waitKey(1) & 0xFF
                if key == ord('q'):
                    break
                elif key == ord('m'):
                    modes = ["ai_only", "split", "side_by_side"]
                    curr_idx = modes.index(self.display_mode)
                    self.display_mode = modes[(curr_idx + 1) % len(modes)]
                    logger.info("Display mode changed to: %s", self.display_mode)
                elif key == ord('d'):
                    self.show_mesh = not self.show_mesh
                    logger.info("Show mesh debug: %s", self.show_mesh)
                elif key == ord('s'):
                    snapshot_name = f"snapshot_{int(time.time())}.png"
                    cv2.imwrite(snapshot_name, result)
                    logger.info("Saved snapshot: %s", snapshot_name)

                frame_count += 1
        finally:
            cap.release()
            if writer is not None:
                writer.release()
            cv2.destroyAllWindows()
            logger.info("Stopped after %d frames.", frame_count)


def main():
    parser = argparse.ArgumentParser(description="Real-Time Photorealistic Neural Face Reenactment")
    parser.add_argument(
        "--ref_dir",
        type=str,
        default="./public/assets/aistudio",
        help="Directory with reference images for Person A"
    )
    parser.add_argument(
        "--camera",
        type=int,
        default=0,
        help="Webcam device index (default: 0)"
    )
    parser.add_argument(
        "--video",
        type=str,
        default=None,
        help="Path to driving video file (overrides webcam)"
    )
    parser.add_argument(
        "--mode",
        type=str,
        choices=["ai_only", "split", "side_by_side"],
        default="ai_only",
        help="Display compositing mode"
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Optional path to save output video (e.g. output.mp4)"
    )
    parser.add_argument(
        "--cpu",
        action="store_true",
        help="Force CPU execution (disables CUDA/GPU)"
    )

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    # Fallback reference dir check
    ref_dir = args.ref_dir
    if not os.path.exists(ref_dir):
        alt_dirs = ["./references", "./assets", "."]
        for d in alt_dirs:
            if os.path.exists(d):
                ref_dir = d
                break

    source = args.video if args.video else args.camera

    pipeline = NeuralReenactmentPipeline(
        reference_dir=ref_dir,
        use_gpu=not args.cpu,
        display_mode=args.mode
    )

    pipeline.run_stream(source=source, save_output=args.output)


if __name__ == "__main__":
    main()
