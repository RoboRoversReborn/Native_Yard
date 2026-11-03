import { buildAuditFromVision, buildDemoAudit } from "@/lib/plants";
import { validateYardImage } from "@/lib/image-validation";
import { isNjZip } from "@/lib/nj-data";
import { identifyPlantsWithGemini } from "@/lib/vision";
import type { AuditImage } from "@/lib/types";

export const maxDuration = 60;

type AnalyzeBody = {
  zip?: string;
  image?: string | null;
  sample?: boolean;
  imageWidth?: number;
  imageHeight?: number;
};

function imageMeta(body: AnalyzeBody): AuditImage | undefined {
  const width = Number(body.imageWidth);
  const height = Number(body.imageHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { width: Math.round(width), height: Math.round(height) };
}

function fail(message: string, code: string, status: number) {
  return Response.json({ error: message, code }, { status });
}

export async function POST(request: Request) {
  let body: AnalyzeBody;

  try {
    body = (await request.json()) as AnalyzeBody;
  } catch {
    return fail("Invalid request body.", "invalid_body", 400);
  }

  const zip = String(body.zip ?? "").replace(/\D/g, "").slice(0, 5);

  if (zip.length !== 5 || !isNjZip(zip)) {
    return fail(
      "Enter a 5-digit New Jersey ZIP code (07000–08999) so we can match your physiographic province.",
      "invalid_zip",
      400,
    );
  }

  const meta = imageMeta(body);

  // The sample yard is the only flow allowed to use the illustrative audit.
  // It is never painted over a homeowner's uploaded photo.
  if (body.sample === true) {
    return Response.json(buildDemoAudit(zip, meta));
  }

  if (!body.image || !String(body.image).startsWith("data:image/")) {
    return fail(
      "Upload a yard photo, or choose the sample yard to explore the demo audit.",
      "missing_image",
      400,
    );
  }

  if (!process.env.GEMINI_API_KEY && !process.env.PLANTNET_API_KEY) {
    return fail(
      "Live plant identification is not configured on this deployment. Add GEMINI_API_KEY or PLANTNET_API_KEY to enable photo analysis, or try the sample yard.",
      "vision_unavailable",
      503,
    );
  }

  const check = await validateYardImage(String(body.image));
  if (!check.ok) {
    return fail(check.message, check.code, 422);
  }

  try {
    const vision = await identifyPlantsWithGemini(String(body.image), zip);
    console.info("NativeYard vision detections:", {
      model: process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash",
      count: vision.length,
      scientificNames: vision.map((item) => item.scientificName),
    });
    const audit = buildAuditFromVision(vision, zip, {
      image: meta ?? { width: check.width, height: check.height },
    });

    if (audit) {
      return Response.json(audit);
    }

    return fail(
      vision.length
        ? "Gemini found plants, but none matched the local New Jersey plant catalog. Try a clearer shot with foliage and stems, or add the detected species to the catalog."
        : "We could not identify any plants in that photo. Try a wider, brighter shot that includes clear leaves and stems, or move closer to the bed.",
      "no_detections",
      422,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown vision error";
    console.error("NativeYard vision error:", message);

    return fail(
      "Live plant identification failed for this photo. Check the image and try again in a moment.",
      "vision_failed",
      502,
    );
  }
}
