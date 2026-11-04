"""
Anatomical Alignment & Forehead Integration Module (blender.py)
==============================================================
Solves forehead seam cuts, visible brow lines, and harsh mask boundaries:
  1. Anatomical cranial boundary projection up to the hairline (stops naive convex-hull cuts).
  2. Multi-stage skin segmentation and adaptive distance-transform alpha feathering.
  3. CIE LAB color moment transfer (mean and standard deviation matching) for room illumination.
  4. Poisson gradient-domain blending (cv2.seamlessClone) with fallback alpha compositing.
"""

import cv2
import numpy as np
from typing import Tuple, Optional


class AnatomicalBlender:
    """
    Blends the reenacted facial identity seamlessly into the driver's head,
    harmonizing lighting, skin tones, and eliminating cranial seam artifacts.
    """

    def __init__(
        self,
        cranial_extension_factor: float = 0.28,
        feather_radius: int = 25,
        lab_color_blend_ratio: float = 0.85
    ):
        self.cranial_extension_factor = cranial_extension_factor
        self.feather_radius = feather_radius
        self.lab_color_blend_ratio = lab_color_blend_ratio

    def build_anatomical_mask(
        self,
        image_shape: Tuple[int, int],
        landmarks_norm: np.ndarray,
        cranial_extension: Optional[float] = None
    ) -> np.ndarray:
        """
        Builds a full cranial-aware face mask that avoids cutting across the brow.
        Projects forehead geometry upward along the cranial normal vector into the hair roots.
        """
        h, w = image_shape[:2]
        pts = np.copy(landmarks_norm[:, :2])
        pts[:, 0] *= w
        pts[:, 1] *= h

        ext = cranial_extension if cranial_extension is not None else self.cranial_extension_factor

        # Key anatomical indices:
        # Glabella (between eyebrows): #9
        # Forehead apex: #10
        # Left brow / temple: #70, #63, #105, #66, #107
        # Right brow / temple: #336, #296, #334, #293, #300
        # Outer jawline: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
        #                 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
        #                 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]

        jaw_indices = [
            10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
            397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
            172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
        ]

        # Extract contour points
        contour_points = []
        for idx in jaw_indices:
            pt = pts[idx].copy()
            contour_points.append(pt)

        contour_arr = np.array(contour_points, dtype=np.float32)

        # Cranial normal vector: from glabella (9) to apex (10)
        p9 = pts[9]
        p10 = pts[10]
        cranial_vec = p10 - p9
        cranial_len = np.linalg.norm(cranial_vec) + 1e-6
        unit_cranial = cranial_vec / cranial_len

        # Project upper forehead points upward to integrate into hairline
        forehead_indices = [338, 297, 332, 284, 10, 109, 67, 103, 54]
        for i, idx in enumerate(jaw_indices):
            if idx in forehead_indices:
                dist_to_apex = np.linalg.norm(pts[idx] - p10)
                apex_weight = np.clip(1.0 - (dist_to_apex / (w * 0.25)), 0.0, 1.0)
                projection = unit_cranial * (cranial_len * ext * (0.8 + 0.4 * apex_weight))
                contour_arr[i] += projection

        # Draw binary mask
        mask = np.zeros((h, w), dtype=np.uint8)
        poly = np.round(contour_arr).astype(np.int32)
        cv2.fillPoly(mask, [poly], 255)

        return mask

    def refine_with_skin_segmentation(
        self,
        bgr_image: np.ndarray,
        initial_mask: np.ndarray,
        landmarks_norm: np.ndarray
    ) -> np.ndarray:
        """
        Refines the mask boundary by verifying skin chroma distribution (YCrCb/HSV).
        Prevents bleeding into dark hair, eyeglasses, or high-contrast background.
        """
        h, w = bgr_image.shape[:2]
        pts = np.copy(landmarks_norm[:, :2])
        pts[:, 0] *= w
        pts[:, 1] *= h

        # Sample skin patches from cheeks and nose bridge (indices: 1, 117, 346, 187, 411)
        skin_sample_indices = [1, 117, 346, 187, 411, 197, 50, 280]
        sample_pixels = []
        for idx in skin_sample_indices:
            x, y = int(np.clip(pts[idx, 0], 0, w - 1)), int(np.clip(pts[idx, 1], 0, h - 1))
            patch = bgr_image[max(0, y - 4):min(h, y + 5), max(0, x - 4):min(w, x + 5)]
            if patch.size > 0:
                sample_pixels.append(patch.reshape(-1, 3))

        if not sample_pixels:
            return initial_mask

        all_skin_bgr = np.vstack(sample_pixels)
        ycrcb_samples = cv2.cvtColor(all_skin_bgr.reshape(-1, 1, 3), cv2.COLOR_BGR2YCrCb).reshape(-1, 3)

        # Robust skin color bounds
        cr_mean = np.mean(ycrcb_samples[:, 1])
        cr_std = np.std(ycrcb_samples[:, 1]) + 1e-6
        cb_mean = np.mean(ycrcb_samples[:, 2])
        cb_std = np.std(ycrcb_samples[:, 2]) + 1e-6

        # Convert full image to YCrCb
        img_ycrcb = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2YCrCb)
        cr = img_ycrcb[:, :, 1].astype(np.float32)
        cb = img_ycrcb[:, :, 2].astype(np.float32)

        # Mahalanobis / Euclidean distance in chromatic plane
        cr_diff = (cr - cr_mean) / (cr_std * 3.5)
        cb_diff = (cb - cb_mean) / (cb_std * 3.5)
        skin_dist = np.sqrt(cr_diff ** 2 + cb_diff ** 2)

        skin_candidate = (skin_dist < 1.3).astype(np.uint8) * 255

        # Morphological clean up
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        skin_candidate = cv2.morphologyEx(skin_candidate, cv2.MORPH_CLOSE, kernel)

        # Hairline safeguard: only apply skin filtering in upper 30% of the face
        refined_mask = initial_mask.copy()
        glabella_y = int(pts[9, 1])
        forehead_zone = np.zeros_like(initial_mask)
        forehead_zone[:glabella_y, :] = 255

        # Intersect in the upper forehead region to hug the natural hairline
        upper_refined = cv2.bitwise_and(initial_mask, skin_candidate)
        refined_mask = np.where(forehead_zone > 0, upper_refined, initial_mask)

        # Fill holes
        contours, _ = cv2.findContours(refined_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if contours:
            largest = max(contours, key=cv2.contourArea)
            clean_mask = np.zeros_like(refined_mask)
            cv2.drawContours(clean_mask, [largest], -1, 255, thickness=cv2.FILLED)
            return clean_mask

        return initial_mask

    def generate_feathered_alpha(self, binary_mask: np.ndarray, feather_radius: Optional[int] = None) -> np.ndarray:
        """
        Creates an organic, non-linear feathered alpha matte using Euclidean distance transform.
        Eliminates the abrupt boundary jump between persona and driver head.
        """
        radius = feather_radius if feather_radius is not None else self.feather_radius
        if radius % 2 == 0:
            radius += 1

        # Distance transform inside mask
        dist_inside = cv2.distanceTransform(binary_mask, cv2.DIST_L2, 5)

        # Normalize distance within feather zone
        max_dist = float(radius)
        alpha = np.clip(dist_inside / max_dist, 0.0, 1.0)

        # Apply smooth S-curve (cubic Hermite) to feathering
        alpha = alpha * alpha * (3.0 - 2.0 * alpha)

        # Soft Gaussian blur to remove any discretization artifacts
        alpha = cv2.GaussianBlur(alpha, (radius, radius), 0)

        return np.clip(alpha, 0.0, 1.0)

    def match_lab_color_moments(
        self,
        source_bgr: np.ndarray,
        target_bgr: np.ndarray,
        mask: Optional[np.ndarray] = None
    ) -> np.ndarray:
        """
        Transfers color distribution from target (driver's frame) to source (persona face)
        using CIE LAB color space mean and standard deviation alignment.
        Harmonizes room lighting, color temperature, and skin tone.
        """
        src_lab = cv2.cvtColor(source_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
        tgt_lab = cv2.cvtColor(target_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)

        if mask is not None and np.count_nonzero(mask) > 100:
            valid_mask = mask > 128
            src_pixels = src_lab[valid_mask]
            tgt_pixels = tgt_lab[valid_mask]
        else:
            src_pixels = src_lab.reshape(-1, 3)
            tgt_pixels = tgt_lab.reshape(-1, 3)

        src_mean = np.mean(src_pixels, axis=0)
        src_std = np.std(src_pixels, axis=0) + 1e-6
        tgt_mean = np.mean(tgt_pixels, axis=0)
        tgt_std = np.std(tgt_pixels, axis=0) + 1e-6

        # Transfer moments
        res_lab = np.zeros_like(src_lab)
        for c in range(3):
            scale = tgt_std[c] / src_std[c]
            # Moderation to prevent oversaturating or blowing out extremes
            scale = np.clip(scale, 0.65, 1.45)
            transferred = (src_lab[:, :, c] - src_mean[c]) * scale + tgt_mean[c]
            # Blend with original LAB based on ratio
            res_lab[:, :, c] = (1.0 - self.lab_color_blend_ratio) * src_lab[:, :, c] + \
                               self.lab_color_blend_ratio * transferred

        res_lab = np.clip(res_lab, 0, 255).astype(np.uint8)
        return cv2.cvtColor(res_lab, cv2.COLOR_LAB2BGR)

    def blend_composite(
        self,
        warped_face_bgr: np.ndarray,
        driver_frame_bgr: np.ndarray,
        driver_landmarks: np.ndarray,
        use_poisson: bool = True
    ) -> np.ndarray:
        """
        End-to-end integration:
          1. Constructs cranial extended mask.
          2. Refines with skin segmentation up to hairline.
          3. Matches LAB color moments.
          4. Blends via Poisson gradient-domain cloning (cv2.seamlessClone)
             with seamless fallback to feathered alpha matte.
        """
        h, w = driver_frame_bgr.shape[:2]

        # 1. Anatomical mask
        raw_mask = self.build_anatomical_mask((h, w), driver_landmarks)
        refined_mask = self.refine_with_skin_segmentation(driver_frame_bgr, raw_mask, driver_landmarks)

        # 2. Color Harmonization
        color_matched_face = self.match_lab_color_moments(warped_face_bgr, driver_frame_bgr, refined_mask)

        # 3. Poisson Gradient Cloning
        if use_poisson:
            try:
                # Erode mask slightly for Poisson boundary condition stability
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
                clone_mask = cv2.erode(refined_mask, kernel, iterations=2)

                # Compute center of mass
                moments = cv2.moments(clone_mask)
                if moments["m00"] > 500:
                    cx = int(moments["m10"] / moments["m00"])
                    cy = int(moments["m01"] / moments["m00"])

                    # Ensure cloning center is well inside borders
                    pad = 20
                    if pad < cx < (w - pad) and pad < cy < (h - pad):
                        # cv2.NORMAL_CLONE solves gradient equations over the mask
                        cloned = cv2.seamlessClone(
                            color_matched_face,
                            driver_frame_bgr,
                            clone_mask,
                            (cx, cy),
                            cv2.NORMAL_CLONE
                        )
                        return cloned
            except Exception as e:
                # Fallback gracefully to feathered alpha compositing
                pass

        # 4. Fallback: Soft non-linear feathered alpha compositing
        alpha = self.generate_feathered_alpha(refined_mask, self.feather_radius)
        alpha_3c = np.repeat(alpha[:, :, np.newaxis], 3, axis=2)

        blended = (color_matched_face.astype(np.float32) * alpha_3c +
                   driver_frame_bgr.astype(np.float32) * (1.0 - alpha_3c))

        return np.clip(blended, 0, 255).astype(np.uint8)
