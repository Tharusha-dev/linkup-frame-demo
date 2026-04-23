"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CaptureMode = "idle" | "camera" | "result";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${url}`));
    image.src = url;
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
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<CaptureMode>("idle");
  const [cameraError, setCameraError] = useState<string>("");
  const [sourceImage, setSourceImage] = useState<string>("");
  const [framedImage, setFramedImage] = useState<string>("");
  const [framedBlob, setFramedBlob] = useState<Blob | null>(null);
  const [isCompositing, setIsCompositing] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  const canShare = useMemo(
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
    [],
  );

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

  const openCamera = useCallback(async () => {
    setCameraError("");
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
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
      setMode("camera");
    } catch {
      setMode("idle");
      setCameraError(
        "Camera access is blocked on this device. You can still upload a photo from your gallery.",
      );
    }
  }, [stopCamera]);

  const composeFramedPhoto = useCallback(async (photoUrl: string) => {
    setIsCompositing(true);
    try {
      const [photo, frame] = await Promise.all([
        loadImage(photoUrl),
        loadImage("/frame.png"),
      ]);
      const canvas = document.createElement("canvas");
      canvas.width = frame.naturalWidth;
      canvas.height = frame.naturalHeight;
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Canvas not supported");
      }

      drawCoverImage(context, photo, canvas.width, canvas.height);
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);

      const pngUrl = canvas.toDataURL("image/png");
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((generatedBlob) => resolve(generatedBlob), "image/png", 1);
      });

      setFramedImage(pngUrl);
      setFramedBlob(blob);
    } finally {
      setIsCompositing(false);
    }
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

    stopCamera();
    setSourceImage(image);
    setMode("result");
    await composeFramedPhoto(image);
  }, [composeFramedPhoto, stopCamera]);

  const onUploadPhoto = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const fileUrl = URL.createObjectURL(file);
      stopCamera();
      setSourceImage(fileUrl);
      setMode("result");
      await composeFramedPhoto(fileUrl);
      event.target.value = "";
    },
    [composeFramedPhoto, stopCamera],
  );

  const downloadFramedPhoto = useCallback(() => {
    if (!framedImage) {
      return;
    }

    const link = document.createElement("a");
    link.href = framedImage;
    link.download = "linkup-colombo-frame-demo.png";
    document.body.append(link);
    link.click();
    link.remove();
  }, [framedImage]);

  const shareFramedPhoto = useCallback(async () => {
    if (!canShare) {
      return;
    }

    setIsSharing(true);
    try {
      const sharePayload: ShareData = {
        title: "LinkUp Colombo Frame Demo",
        text: "I captured this from the LinkUp Colombo frame demo!",
      };

      if (framedBlob) {
        const shareFile = new File([framedBlob], "linkup-colombo-frame-demo.png", {
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
  }, [canShare, framedBlob]);

  const resetFlow = useCallback(() => {
    stopCamera();
    setSourceImage("");
    setFramedImage("");
    setFramedBlob(null);
    setCameraError("");
    setMode("idle");
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
          <p className="hero__kicker">LinkUp Colombo Frame Demo</p>
          <h1>Frame your shot</h1>
        </div>
      </header>

      <main className="content-shell">
        <section className="capture-panel" aria-labelledby="capture-title">
          <div className="capture-panel__head">
            <h2 id="capture-title">Capture or Upload</h2>
            <p>
              Use your phone camera or upload an existing photo. Once captured, the preview
              locks into the framed result and the actions switch to save, share, and retake.
            </p>
          </div>

          <div className="capture-stage">
            <div className="preview-box">
              {(mode === "idle" || mode === "camera") && (
                <video
                  ref={videoRef}
                  className={`preview-media ${mode === "camera" ? "is-visible" : ""}`}
                  playsInline
                  muted
                  autoPlay
                />
              )}

              {mode === "result" && framedImage && (
                <img
                  src={framedImage}
                  alt="Final framed capture preview"
                  className="preview-media is-visible"
                />
              )}

              {mode === "result" && !framedImage && sourceImage && (
                <img
                  src={sourceImage}
                  alt="Framed capture preview"
                  className="preview-media is-visible"
                />
              )}

              {mode !== "result" && (
                <img src="/frame.png" alt="LinkUp frame overlay" className="preview-frame" />
              )}

              {mode === "idle" && (
                <div className="preview-empty">
                  <p>Open camera or upload a photo to begin.</p>
                </div>
              )}
            </div>

            <div className="capture-actions">
              {mode === "result" ? (
                <>
                  <button
                    type="button"
                    onClick={downloadFramedPhoto}
                    className="btn btn--primary"
                    disabled={!framedImage || isCompositing}
                  >
                    Save to Device
                  </button>

                  <button
                    type="button"
                    onClick={shareFramedPhoto}
                    className="btn btn--accent"
                    disabled={!framedImage || isCompositing || !canShare || isSharing}
                  >
                    {isSharing ? "Opening Share..." : "Share to Social"}
                  </button>

                  <button type="button" onClick={resetFlow} className="btn btn--ghost">
                    Retake Photo
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={openCamera} className="btn btn--primary">
                    Open Camera
                  </button>

                  <button
                    type="button"
                    onClick={capturePhoto}
                    className="btn btn--accent"
                    disabled={mode !== "camera"}
                  >
                    Take Photo
                  </button>

                  <label htmlFor="upload-photo" className="btn btn--ghost">
                    Upload Photo
                  </label>
                  <input
                    id="upload-photo"
                    type="file"
                    accept="image/*"
                    onChange={onUploadPhoto}
                    className="visually-hidden"
                  />
                </>
              )}
            </div>

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
