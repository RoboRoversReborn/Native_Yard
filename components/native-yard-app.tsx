"use client";

import { useEffect, useState } from "react";
import { AnalyzingView } from "./analyzing-view";
import { AuditView } from "./audit-view";
import { LandingPage } from "./landing-page";
import { ReportView } from "./report-view";
import { buildDemoAudit } from "@/lib/plants";
import { isNjZip } from "@/lib/nj-data";
import type { Audit } from "@/lib/types";

type Stage = "landing" | "analyzing" | "audit" | "report";

type ImageMeta = {
  width: number;
  height: number;
};

const SAMPLE_PHOTO = "/images/yard-demo.jpg";
const DEFAULT_ZIP = "07645";

export function NativeYardApp() {
  const [stage, setStage] = useState<Stage>("landing");
  const [photo, setPhoto] = useState<string | null>(null);
  const [zip, setZip] = useState(DEFAULT_ZIP);
  const [error, setError] = useState("");
  const [audit, setAudit] = useState<Audit | null>(null);
  const [scanStep, setScanStep] = useState(0);
  const [isSample, setIsSample] = useState(false);
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [stage]);

  async function handlePhoto(file: File) {
    setError("");

    if (!file.type.startsWith("image/")) {
      setError("That file is not an image. Try a JPEG, PNG, WEBP, or HEIC photo.");
      return;
    }

    if (file.size > 12 * 1024 * 1024) {
      setError("That image is larger than 12 MB. Try a smaller photo.");
      return;
    }

    try {
      const resized = await resizeImage(file);
      setPhoto(resized.dataUrl);
      setImageMeta({ width: resized.width, height: resized.height });
      setIsSample(false);
    } catch {
      setError(
        "We couldn't read that image in this browser. Try exporting it as a JPEG or PNG first.",
      );
    }
  }

  function handleSample() {
    setPhoto(SAMPLE_PHOTO);
    setImageMeta(null);
    setIsSample(true);
    setError("");
  }

  function handleClearPhoto() {
    setPhoto(null);
    setImageMeta(null);
    setIsSample(false);
    setError("");
  }

  async function handleStart() {
    if (!/^\d{5}$/.test(zip) || !isNjZip(zip)) {
      setError("Enter a 5-digit New Jersey ZIP code (07000–08999).");
      return;
    }

    const usingSample = !photo || !photo.startsWith("data:");
    const activePhoto = photo ?? SAMPLE_PHOTO;

    if (usingSample && !photo) {
      setPhoto(SAMPLE_PHOTO);
      setIsSample(true);
    }

    setError("");
    setStage("analyzing");
    setScanStep(0);

    const progress = window.setInterval(() => {
      setScanStep((current) => Math.min(current + 1, 3));
    }, 620);

    const startedAt = Date.now();

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zip,
          image: usingSample ? null : activePhoto,
          sample: usingSample,
          imageWidth: imageMeta?.width,
          imageHeight: imageMeta?.height,
        }),
      });

      let payload: (Audit & { error?: string }) | null = null;
      try {
        payload = (await response.json()) as Audit & { error?: string };
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error(
          payload?.error ||
            "The analysis service returned an error. Please try another photo.",
        );
      }

      if (!payload?.detections?.length) {
        throw new Error(
          "We couldn't identify any plants in that photo. Try a wider, brighter shot of the bed.",
        );
      }

      await waitFor(Math.max(0, 2200 - (Date.now() - startedAt)));
      setAudit(payload);
      setScanStep(3);
      setStage("audit");
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "The analysis service was unreachable. Please try again.";

      if (usingSample) {
        // A sample audit is illustrative by design, so a local fallback is safe.
        const fallback = buildDemoAudit(zip);
        fallback.notice =
          "The analysis service was unreachable, so this is the bundled sample audit. Upload a photo to run live identification.";
        await waitFor(Math.max(0, 1400 - (Date.now() - startedAt)));
        setAudit(fallback);
        setScanStep(3);
        setStage("audit");
      } else {
        // Never paint the demo boxes over a homeowner's uploaded photo.
        await waitFor(Math.max(0, 900 - (Date.now() - startedAt)));
        setError(message);
        setStage("landing");
      }
    } finally {
      window.clearInterval(progress);
    }
  }

  function handleReset() {
    setStage("landing");
    setPhoto(null);
    setImageMeta(null);
    setIsSample(false);
    setAudit(null);
    setError("");
    setScanStep(0);
  }

  if (stage === "analyzing") {
    return <AnalyzingView photo={photo ?? SAMPLE_PHOTO} step={scanStep} />;
  }

  if (stage === "audit" && audit) {
    return (
      <AuditView
        audit={audit}
        photo={photo ?? SAMPLE_PHOTO}
        onAuditChange={setAudit}
        onReport={() => setStage("report")}
        onReset={handleReset}
        onHome={() => setStage("landing")}
      />
    );
  }

  if (stage === "report" && audit) {
    return (
      <ReportView
        audit={audit}
        photo={photo ?? SAMPLE_PHOTO}
        onBack={() => setStage("audit")}
        onReset={handleReset}
        onHome={() => setStage("landing")}
      />
    );
  }

  return (
    <LandingPage
      photo={photo}
      zip={zip}
      error={error}
      isSample={isSample}
      onPhoto={handlePhoto}
      onSample={handleSample}
      onClearPhoto={handleClearPhoto}
      onZip={(value) => {
        setZip(value);
        setError("");
      }}
      onStart={handleStart}
    />
  );
}

function waitFor(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function resizeImage(file: File) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(objectUrl);
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available.");

    context.fillStyle = "#f7f4e9";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.86),
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image decode failed."));
    image.src = src;
  });
}
