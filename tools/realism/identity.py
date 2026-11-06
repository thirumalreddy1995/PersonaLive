"""Identity guard (R3b): OpenCV Zoo YuNet (detection) + SFace (recognition), both Apache-2.0.

Usage:
  python -I tools/realism/identity.py --models realism-review/models --persona photo.jpg --pairs pairs.json

`pairs.json` is a list of {"output": path, "driver": path}. Prints a JSON list with, per pair,
the cosine similarity of the output face to the persona photo and to the driver frame, and the
margin (toPersona - toDriver). A face that YuNet does not find yields nulls. This is a regression
guard, not a score to maximise; the numbers are never compared with verification thresholds.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

YUNET = "face_detection_yunet_2023mar.onnx"
SFACE = "face_recognition_sface_2021dec.onnx"


def detect_at(detector, img, threshold):
    h, w = img.shape[:2]
    detector.setInputSize((w, h))
    detector.setScoreThreshold(threshold)
    _, faces = detector.detect(img)
    if faces is None or len(faces) == 0:
        return None
    areas = faces[:, 2] * faces[:, 3]
    return faces[int(np.argmax(areas))]


def largest_face(detector, img):
    """Largest YuNet face; falls back to lower score thresholds and a half-size pass (turned or
    upward-looking persona photos score low at full resolution)."""
    for threshold in (0.7, 0.5, 0.3):
        face = detect_at(detector, img, threshold)
        if face is not None:
            return face
    h, w = img.shape[:2]
    if max(h, w) > 400:
        small = cv2.resize(img, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
        for threshold in (0.5, 0.3):
            face = detect_at(detector, small, threshold)
            if face is not None:
                face = face.copy()
                face[:14] *= 2.0
                return face
    return None


def feature(recognizer, detector, path):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        return None
    face = largest_face(detector, img)
    if face is None:
        return None
    aligned = recognizer.alignCrop(img, face)
    return recognizer.feature(aligned)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--persona", required=True)
    ap.add_argument("--pairs", required=True)
    args = ap.parse_args()
    detector = cv2.FaceDetectorYN.create(os.path.join(args.models, YUNET), "", (320, 320), 0.7, 0.3, 5000)
    recognizer = cv2.FaceRecognizerSF.create(os.path.join(args.models, SFACE), "")
    persona = feature(recognizer, detector, args.persona)
    with open(args.pairs, "r", encoding="utf-8") as f:
        pairs = json.load(f)
    out = []
    for pair in pairs:
        o = feature(recognizer, detector, pair["output"])
        d = feature(recognizer, detector, pair["driver"])
        to_persona = float(recognizer.match(o, persona, cv2.FaceRecognizerSF_FR_COSINE)) if o is not None and persona is not None else None
        to_driver = float(recognizer.match(o, d, cv2.FaceRecognizerSF_FR_COSINE)) if o is not None and d is not None else None
        driver_to_persona = float(recognizer.match(d, persona, cv2.FaceRecognizerSF_FR_COSINE)) if d is not None and persona is not None else None
        out.append({
            "toPersona": to_persona,
            "toDriver": to_driver,
            "margin": (to_persona - to_driver) if to_persona is not None and to_driver is not None else None,
            "driverToPersona": driver_to_persona,
            "outputFace": o is not None,
            "driverFace": d is not None,
        })
    json.dump({"personaFace": persona is not None, "frames": out}, sys.stdout)


if __name__ == "__main__":
    main()
