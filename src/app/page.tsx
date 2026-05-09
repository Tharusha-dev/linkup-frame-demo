"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuRotateCcw,
  LuDownload,
  LuShare2,
  LuCamera,
  LuCircle,
  LuUpload,
  LuRefreshCw,
} from "react-icons/lu";
import headerImg from "../../public/viriththan.png"
import { uploadFrame, logEvent, incrementCounter } from "../lib/supabaseClient";

type CaptureMode = "idle" | "camera" | "result";

type CropTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

const INITIAL_CROP_TRANSFORM: CropTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

const MIN_CROP_SCALE = 1;
const MAX_CROP_SCALE = 3;
const CROP_ZOOM_STEP = 0.15;

type PointerPoint = {
  x: number;
  y: number;
};

type GestureState = {
  pointers: Map<number, PointerPoint>;
  startTransform: CropTransform;
  startPointer: PointerPoint | null;
  startDistance: number;
  startCenter: PointerPoint | null;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampCropTransform(transform: CropTransform): CropTransform {
  const maxOffset = Math.max(0, (transform.scale - 1) / 2);

  return {
    scale: clamp(transform.scale, MIN_CROP_SCALE, MAX_CROP_SCALE),
    offsetX: clamp(transform.offsetX, -maxOffset, maxOffset),
    offsetY: clamp(transform.offsetY, -maxOffset, maxOffset),
  };
}

function getDistance(first: PointerPoint, second: PointerPoint) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function getCenter(first: PointerPoint, second: PointerPoint) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${url}`));
    image.src = url;
  });
}

function getEXIFOrientation(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const arr = new Uint8Array(e.target?.result as ArrayBuffer).subarray(0, 4);
      if (arr[0] !== 0xff || arr[1] !== 0xd8 || arr[2] !== 0xff) {
        resolve(1); // Not a JPEG, return default orientation
        return;
      }

      const view = new DataView(e.target?.result as ArrayBuffer);
      let offset = 2;
      while (offset < view.byteLength) {
        if (view.getUint16(offset) === 0xffe1) {
          const length = view.getUint16(offset + 2) + 2;
          if (
            view.getUint32(offset + 4) === 0x45786966
          ) {
            const exifData = view.getUint8(offset + 9);
            let oritentation = 1;

            const tiffOffset = offset + 8 + exifData;
            const littleEndian = view.getUint16(tiffOffset) === 0x4949;

            let tags = view.getUint16(tiffOffset + 8, littleEndian);
            for (let i = 0; i < tags; i++) {
              const tagOffset = tiffOffset + 10 + i * 12;
              if (
                view.getUint16(tagOffset, littleEndian) === 0x0112
              ) {
                oritentation = view.getUint16(tagOffset + 8, littleEndian);
                resolve(oritentation);
                return;
              }
            }
          }
          resolve(1);
          return;
        }
        offset += 2;
      }
      resolve(1);
    };
    reader.readAsArrayBuffer(blob);
  });
}

function drawCoverImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  targetWidth: number,
  targetHeight: number,
) {
  const scale = Math.max(
    targetWidth / image.naturalWidth,
    targetHeight / image.naturalHeight,
  );
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const offsetX = (targetWidth - drawWidth) / 2;
  const offsetY = (targetHeight - drawHeight) / 2;

  context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const nativeCaptureInputRef = useRef<HTMLInputElement | null>(null);
  const cropEditorRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<CaptureMode>("idle");
  const [cameraFacing, setCameraFacing] = useState<"environment" | "user">("user");
  const [cameraError, setCameraError] = useState<string>("");
  const [sourceImage, setSourceImage] = useState<string>("");
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null);
  const [isFromNativeCamera, setIsFromNativeCamera] = useState(false);
  const [shouldMirrorResult, setShouldMirrorResult] = useState(false);
  const [cropTransform, setCropTransform] = useState<CropTransform>(INITIAL_CROP_TRANSFORM);
  const isCompositing = false;
  const [isSharing, setIsSharing] = useState(false);
  const [isManuallyFlipped, setIsManuallyFlipped] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [saveStatus, setSaveStatus] = useState("");
  const canShare = useMemo(
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
    [],
  );

  const prefersNativeCameraCapture = useMemo(() => {
    if (typeof navigator === "undefined") {
      return false;
    }

    const mobileUserAgent = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isIPadLikeDesktop = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;

    return mobileUserAgent || isIPadLikeDesktop;
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const openCamera = useCallback(async (facingMode: "environment" | "user") => {
    setCameraError("");

    void logEvent("open_camera", { facing: facingMode, prefersNative: prefersNativeCameraCapture });
    void incrementCounter("open_camera");
    if (prefersNativeCameraCapture) {
      setCameraFacing(facingMode);
      nativeCaptureInputRef.current?.click();
      return;
    }

    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: 1080 },
          height: { ideal: 1350 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraFacing(facingMode);
      setMode("camera");
    } catch {
      setMode("idle");
      setCameraError(
        "Camera access is blocked on this device. You can still upload a photo from your gallery.",
      );
    }
  }, [prefersNativeCameraCapture, stopCamera]);

  const switchCamera = useCallback(async () => {
    const nextFacing = cameraFacing === "environment" ? "user" : "environment";
    if (mode === "camera") {
      await openCamera(nextFacing);
      return;
    }

    setCameraFacing(nextFacing);
  }, [cameraFacing, mode, openCamera]);

  const buildFramedPhoto = useCallback(async (
    photoUrl: string,
    mirrorPhoto = false,
    transform: CropTransform = INITIAL_CROP_TRANSFORM,
    photoBlob: Blob | null = null,
    fromNativeCamera = false,
  ) => {
    const [photo, frame] = await Promise.all([
      loadImage(photoUrl),
      loadImage("/frame.png"),
    ]);
    
    // Only apply EXIF orientation correction for file uploads, not native camera
    // (native camera apps already handle orientation correctly)
    let orientation = 1;
    if (photoBlob && !fromNativeCamera) {
      orientation = await getEXIFOrientation(photoBlob);
    }

    const canvas = document.createElement("canvas");
    canvas.width = frame.naturalWidth;
    canvas.height = frame.naturalHeight;
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Canvas not supported");
    }

    context.save();
    if (mirrorPhoto && !fromNativeCamera) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }

    context.translate(
      canvas.width / 2 + transform.offsetX * canvas.width,
      canvas.height / 2 + transform.offsetY * canvas.height,
    );
    context.scale(transform.scale, transform.scale);
    context.translate(-canvas.width / 2, -canvas.height / 2);
    
    // Apply EXIF orientation correction
    switch (orientation) {
      case 2:
        context.translate(photo.naturalWidth, 0);
        context.scale(-1, 1);
        break;
      case 3:
        context.translate(photo.naturalWidth, photo.naturalHeight);
        context.rotate(Math.PI);
        break;
      case 4:
        context.translate(0, photo.naturalHeight);
        context.scale(1, -1);
        break;
      case 5:
        context.rotate(Math.PI / 2);
        context.scale(1, -1);
        break;
      case 6:
        context.rotate(Math.PI / 2);
        context.translate(0, -photo.naturalWidth);
        break;
      case 7:
        context.rotate(-Math.PI / 2);
        context.translate(-photo.naturalHeight, 0);
        context.scale(1, -1);
        break;
      case 8:
        context.rotate(-Math.PI / 2);
        context.translate(-photo.naturalHeight, 0);
        break;
    }
    
    drawCoverImage(context, photo, canvas.width, canvas.height);
    context.restore();
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);

    const pngUrl = canvas.toDataURL("image/png");
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((generatedBlob) => resolve(generatedBlob), "image/png", 1);
    });

    return { pngUrl, blob };
  }, []);

  const capturePhoto = useCallback(async () => {
    if (!videoRef.current) {
      return;
    }

    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight) {
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/jpeg", 0.95);
    const mirrorCapture = cameraFacing === "user";

    stopCamera();
    setSourceImage(image);
    setShouldMirrorResult(mirrorCapture);
    setCropTransform(INITIAL_CROP_TRANSFORM);
    setMode("result");

    // Log capture event and increment counter.
    void (async () => {
      try {
        await logEvent("capture", { mirror: mirrorCapture });
      } catch {}
      void incrementCounter("capture");
    })();
  }, [cameraFacing, stopCamera]);

  const processSelectedFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>, mirrorResult: boolean, fromNativeCamera = false) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const fileUrl = URL.createObjectURL(file);
      stopCamera();
      setSourceImage(fileUrl);
      setSourceBlob(file);
      setIsFromNativeCamera(fromNativeCamera);
      setShouldMirrorResult(mirrorResult);
      setCropTransform(INITIAL_CROP_TRANSFORM);
      setMode("result");
      // Log upload event and increment counter.
      void (async () => {
        try {
          await logEvent("upload", { fromNative: fromNativeCamera });
        } catch {}
        void incrementCounter("upload");
      })();

      event.target.value = "";
    },
    [stopCamera],
  );

  const onUploadPhoto = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      void processSelectedFile(event, false, false);
    },
    [processSelectedFile],
  );

  const onNativeCapturePhoto = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      void processSelectedFile(event, false, true);
    },
    [processSelectedFile],
  );

  const downloadFramedPhoto = useCallback(async () => {
    if (!sourceImage) {
      return;
    }

    setIsSaving(true);
    setSaveProgress(10);
    setSaveStatus("Preparing frame...");

    try {
      await logEvent("download", { via: "save_button" });
    } catch {}
    void incrementCounter("download");

    const { pngUrl, blob } = await buildFramedPhoto(
      sourceImage,
      shouldMirrorResult || isManuallyFlipped,
      cropTransform,
      sourceBlob,
      isFromNativeCamera,
    );
    setSaveProgress(45);
    setSaveStatus("Uploading secure copy...");

    if (blob) {
      try {
        const filename = `download-${Date.now()}-${Math.floor(Math.random() * 10000)}.png`;
        const res = await uploadFrame(blob, filename);
        if (res?.error) console.error("Upload failed:", res.error);
      } catch {}
    }
    setSaveProgress(75);
    setSaveStatus("Saving to device...");

    const isIOS =
      typeof navigator !== "undefined" &&
      /iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !(window as any).MSStream;

    if (isIOS && blob) {
      const shareFile = new File([blob], "linkup-colombo-frame-demo.png", {
        type: "image/png",
      });

      if (navigator.canShare?.({ files: [shareFile] }) && canShare) {
        try {
          await navigator.share({
            files: [shareFile],
            title: "LinkUp Colombo Frame Demo",
            text: "Save this image to your photos.",
          });
          setSaveProgress(100);
          setSaveStatus("Opened iOS share sheet.");
          return;
        } finally {
          setTimeout(() => {
            setIsSaving(false);
            setSaveProgress(0);
            setSaveStatus("");
          }, 900);
        }
      }

      window.open(pngUrl, "_blank", "noopener,noreferrer");
      setSaveProgress(100);
      setSaveStatus("Opened image. Long-press to save.");
      setTimeout(() => {
        setIsSaving(false);
        setSaveProgress(0);
        setSaveStatus("");
      }, 1200);
      return;
    }

    const link = document.createElement("a");
    link.href = pngUrl;
    link.download = "linkup-colombo-frame-demo.png";
    document.body.append(link);
    link.click();
    link.remove();
    setSaveProgress(100);
    setSaveStatus("Saved.");
    setTimeout(() => {
      setIsSaving(false);
      setSaveProgress(0);
      setSaveStatus("");
    }, 900);
  }, [buildFramedPhoto, cropTransform, shouldMirrorResult, isManuallyFlipped, sourceImage, sourceBlob, isFromNativeCamera, canShare]);

  const shareFramedPhoto = useCallback(async () => {
    if (!canShare || !sourceImage) {
      return;
    }

    setIsSharing(true);
    try {
        const { blob } = await buildFramedPhoto(sourceImage, shouldMirrorResult || isManuallyFlipped, cropTransform, sourceBlob, isFromNativeCamera);

        try {
          await logEvent("share", { via: "native_share" });
        } catch {}
        void incrementCounter("share");

        if (blob) {
          const filename = `share-${Date.now()}-${Math.floor(Math.random() * 10000)}.png`;
          try {
            const res = await uploadFrame(blob, filename);
            if (res?.error) console.error("Upload failed:", res.error);
          } catch {}
        }

      const sharePayload: ShareData = {
        title: "LinkUp Colombo Frame Demo",
        text: "I captured this from the LinkUp Colombo frame demo!",
      };

      if (blob) {
        const shareFile = new File([blob], "linkup-colombo-frame-demo.png", {
          type: "image/png",
        });
        if (navigator.canShare?.({ files: [shareFile] })) {
          sharePayload.files = [shareFile];
        }
      }

      await navigator.share(sharePayload);
    } catch {
      // Ignore if user dismisses native share sheet.
    } finally {
      setIsSharing(false);
    }
  }, [buildFramedPhoto, canShare, cropTransform, shouldMirrorResult, isManuallyFlipped, sourceImage, sourceBlob, isFromNativeCamera]);

  const adjustZoom = useCallback((delta: number) => {
    setCropTransform((current) =>
      clampCropTransform({
        ...current,
        scale: current.scale + delta,
      }),
    );
  }, []);

   const resetCrop = useCallback(() => {
     setCropTransform(INITIAL_CROP_TRANSFORM);
   }, []);

   const toggleFlipImage = useCallback(() => {
     setIsManuallyFlipped((prev) => !prev);
   }, []);

  const handleCropPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!sourceImage || mode !== "result") {
      return;
    }

    const editor = cropEditorRef.current;
    if (!editor) {
      return;
    }

    editor.setPointerCapture(event.pointerId);

    const activePointers = new Map(gestureRef.current?.pointers ?? []);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pointerValues = Array.from(activePointers.values());
    const firstPointer = pointerValues[0] ?? null;
    const secondPointer = pointerValues[1] ?? null;

    gestureRef.current = {
      pointers: activePointers,
      startTransform: cropTransform,
      startPointer: firstPointer,
      startDistance: firstPointer && secondPointer ? getDistance(firstPointer, secondPointer) : 0,
      startCenter: firstPointer && secondPointer ? getCenter(firstPointer, secondPointer) : null,
    };
  }, [cropTransform, mode, sourceImage]);

  const handleCropPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    const editor = cropEditorRef.current;
    if (!gesture || !editor || mode !== "result" || !sourceImage) {
      return;
    }

    if (!gesture.pointers.has(event.pointerId)) {
      return;
    }

    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(gesture.pointers.values());
    const rect = editor.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      return;
    }

    const horizontalDirection = shouldMirrorResult ? -1 : 1;

    if (points.length >= 2 && gesture.startCenter && gesture.startDistance > 0) {
      const currentCenter = getCenter(points[0], points[1]);
      const currentDistance = getDistance(points[0], points[1]);
      const nextScale = clamp(
        gesture.startTransform.scale * (currentDistance / gesture.startDistance),
        MIN_CROP_SCALE,
        MAX_CROP_SCALE,
      );

      setCropTransform(clampCropTransform({
        scale: nextScale,
        offsetX: gesture.startTransform.offsetX + ((currentCenter.x - gesture.startCenter.x) / rect.width) * horizontalDirection,
        offsetY: gesture.startTransform.offsetY + (currentCenter.y - gesture.startCenter.y) / rect.height,
      }));
      return;
    }

    if (gesture.startPointer) {
      setCropTransform(clampCropTransform({
        scale: gesture.startTransform.scale,
        offsetX: gesture.startTransform.offsetX + ((event.clientX - gesture.startPointer.x) / rect.width) * horizontalDirection,
        offsetY: gesture.startTransform.offsetY + (event.clientY - gesture.startPointer.y) / rect.height,
      }));
    }
  }, [mode, shouldMirrorResult, sourceImage]);

  const handleCropPointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const editor = cropEditorRef.current;
    if (editor) {
      try {
        editor.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore if capture was already lost.
      }
    }

    gestureRef.current = null;
  }, []);

  const handleCropWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (mode !== "result" || !sourceImage) {
      return;
    }

    event.preventDefault();
    const zoomStep = event.deltaY > 0 ? -CROP_ZOOM_STEP : CROP_ZOOM_STEP;
    adjustZoom(zoomStep);
  }, [adjustZoom, mode, sourceImage]);

  const resetFlow = useCallback(() => {
    stopCamera();
    setSourceImage("");
    setSourceBlob(null);
    setIsFromNativeCamera(false);
    setShouldMirrorResult(false);
      setIsManuallyFlipped(false);
    setCropTransform(INITIAL_CROP_TRANSFORM);
    gestureRef.current = null;
    setCameraError("");
    setMode("idle");
    setCameraFacing("user");
  }, [stopCamera]);

  useEffect(() => {
    return () => {
      stopCamera();
      if (sourceImage.startsWith("blob:")) {
        URL.revokeObjectURL(sourceImage);
      }
    };
  }, [sourceImage, stopCamera]);

  return (
    <div className="linkup-page">
      <header className="hero">
        <div className="hero__grain" />
        <div className="hero__content">
          <img src={headerImg.src} alt="Viriththan" className="hero__image" />
        </div>
      </header>

      <main className="content-shell">
        <section className="capture-panel" aria-labelledby="capture-title">

          <div className="capture-stage">
            <div className="preview-box">
              {(mode === "idle" || mode === "camera") && (
                <video
                  ref={videoRef}
                  className={`preview-media ${mode === "camera" ? "is-visible" : ""} ${cameraFacing === "user" ? "preview-media--mirrored" : ""}`}
                  playsInline
                  muted
                  autoPlay
                />
              )}

              {mode === "result" && sourceImage && (
                <div
                  ref={cropEditorRef}
                  className="preview-editor"
                  onPointerDown={handleCropPointerDown}
                  onPointerMove={handleCropPointerMove}
                  onPointerUp={handleCropPointerEnd}
                  onPointerCancel={handleCropPointerEnd}
                  onWheel={handleCropWheel}
                  style={{ touchAction: "none" }}
                >
                  <img
                    src={sourceImage}
                    alt="Captured photo to adjust"
                    className="preview-media preview-media--editable is-visible"
                    style={{
                       transform: `${shouldMirrorResult || isManuallyFlipped ? "scaleX(-1) " : ""}translate(${cropTransform.offsetX * 100}%, ${cropTransform.offsetY * 100}%) scale(${cropTransform.scale})`,
                    }}
                    draggable={false}
                  />

                  <div className="preview-editor__overlay" />
                </div>
              )}

              <img src="/frame.png" alt="LinkUp frame overlay" className="preview-frame" />

              {mode === "idle" && (
                <div className="preview-empty">
                  <p>Open camera or upload a photo.</p>
                </div>
              )}
            </div>

            {mode === "result" && sourceImage && (
              <p className="preview-editor__hint">Use two fingers to zoom. Swipe to reposition.</p>
            )}

            <div className="capture-actions">
              {mode === "result" ? (
                <>
                  <button
                    type="button"
                    onClick={resetCrop}
                    className="btn btn--ghost"
                    aria-label="Reset crop"
                    title="Reset crop"
                  >
                    <LuRotateCcw />
                    <span>Reset</span>
                  </button>

                   <button
                     type="button"
                     onClick={toggleFlipImage}
                     className="btn btn--subtle"
                     aria-label="Flip image"
                     title="Flip image horizontally"
                   >
                     <LuRefreshCw />
                     <span>Flip</span>
                   </button>

                  <button
                    type="button"
                    onClick={downloadFramedPhoto}
                    className="btn btn--primary"
                    disabled={!sourceImage || isSaving}
                    aria-label="Save to device"
                    title="Save to device"
                  >
                    <LuDownload />
                    <span>{isSaving ? "Saving..." : "Save"}</span>
                  </button>

                  <button
                    type="button"
                    onClick={shareFramedPhoto}
                    className="btn btn--accent"
                    disabled={!sourceImage || !canShare || isSharing}
                    aria-label="Share to social"
                    title="Share to social"
                  >
                    <LuShare2 />
                    <span>Share</span>
                  </button>

                  <button
                    type="button"
                    onClick={resetFlow}
                    className="btn btn--ghost"
                    aria-label="Retake photo"
                    title="Retake photo"
                  >
                    <LuCamera />
                    <span>Retake</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => openCamera(cameraFacing)}
                    className="btn btn--primary"
                    aria-label="Open camera"
                    title="Open camera"
                  >
                    <LuCamera />
                    <span>Camera</span>
                  </button>

                  <button
                    type="button"
                    onClick={capturePhoto}
                    className="btn btn--accent"
                    disabled={mode !== "camera"}
                    aria-label="Take photo"
                    title="Take photo"
                  >
                    <LuCircle />
                    <span>Capture</span>
                  </button>

                  <label htmlFor="upload-photo" className="btn btn--ghost" aria-label="Upload photo" title="Upload photo">
                    <LuUpload />
                    <span>Upload</span>
                  </label>
                  <input
                    id="upload-photo"
                    type="file"
                    accept="image/*"
                    onChange={onUploadPhoto}
                    className="visually-hidden"
                  />

                  <input
                    ref={nativeCaptureInputRef}
                    type="file"
                    accept="image/*"
                    capture={cameraFacing}
                    onChange={onNativeCapturePhoto}
                    className="visually-hidden"
                    tabIndex={-1}
                    aria-hidden="true"
                  />

                  <button
                    type="button"
                    onClick={switchCamera}
                    className="btn btn--subtle"
                    disabled={mode !== "camera"}
                    aria-label={`Switch camera to ${cameraFacing === "environment" ? "front" : "back"}`}
                    title={`Switch camera to ${cameraFacing === "environment" ? "front" : "back"}`}
                  >
                    <LuRefreshCw />
                    <span>Flip</span>
                  </button>
                </>
              )}
            </div>

            {mode === "result" && saveProgress > 0 && (
              <div className="save-progress" role="status" aria-live="polite">
                <div className="save-progress__bar" style={{ width: `${saveProgress}%` }} />
                <p className="save-progress__label">{saveStatus}</p>
              </div>
            )}

            {cameraError && <p className="status-message">{cameraError}</p>}
            {mode === "result" && !canShare && (
              <p className="status-message">
                Direct sharing is not available in this browser. You can still save and post
                manually.
              </p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
