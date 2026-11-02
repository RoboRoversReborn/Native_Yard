import { regionForZip } from "./plants";
import type { VisionDetection } from "./types";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

export async function identifyPlantsWithGemini(
  dataUrl: string,
  rawZip: string,
): Promise<VisionDetection[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error("The image must be a base64 data URL.");
  }

  const [, mimeType, base64] = match;
  const region = regionForZip(rawZip);
  const model = process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt = `You are a careful field botanist and ecological landscape auditor working in New Jersey.

Analyze this residential yard photo for a homeowner in ${region.city}, ${region.state || "New Jersey"}${region.county ? `, ${region.county} County` : ""} (USDA zone ${region.zone}; ${region.province ?? region.ecoregion}; ${region.ecoregionCode}).

Identify up to 10 distinct plants that are visibly present: trees, shrubs, flowering perennials, vines, groundcovers, and ornamental grasses. Do not identify lawn grass unless it is a distinct ornamental clump. Do not identify fences, furniture, mulch, sky, or people as plants.

For each plant, return:
- isPlant: true only if you can see an actual plant
- scientificName: the most likely binomial, or genus + "spp." if uncertain
- commonName: a plain-English name
- confidence: a number from 0 to 1
- x, y, width, height: normalized bounding-box coordinates from 0 to 1, relative to the FULL original image, origin top-left. The box must tightly enclose the visible foliage of that plant and stay inside the image.
- plantPart: "canopy", "shrub", "perennial", "groundcover", "vine", or "grass"
- note: one short visual clue (leaf shape, flower color, growth habit)
- topMatches: if confidence is below 0.75, list up to 2 alternative local plants with scientificName, commonName, and confidence

Be conservative. If a plant is too blurry or generic to identify, omit it rather than guessing. Do not invent species. If the image is not an outdoor yard or plant photo, return an empty plants array. Return ONLY valid JSON in this exact shape:
{"plants":[{"isPlant":true,"scientificName":"Genus species","commonName":"Common name","confidence":0.85,"x":0.1,"y":0.2,"width":0.2,"height":0.3,"plantPart":"shrub","note":"visual clue","topMatches":[{"scientificName":"Genus altus","commonName":"Alternative","confidence":0.4}]}]}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: base64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  const payload = (await response.json()) as GeminiResponse;

  if (!response.ok) {
    throw new Error(payload.error?.message || "Gemini vision request failed.");
  }

  const text =
    payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim() ?? "";

  if (!text) throw new Error("Gemini returned an empty response.");

  const parsed = JSON.parse(stripCodeFence(text)) as
    | { plants?: unknown }
    | unknown[];

  const rawPlants = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.plants)
      ? parsed.plants
      : [];

  return rawPlants
    .map((item) => toVisionDetection(item))
    .filter((item): item is VisionDetection => Boolean(item))
    .slice(0, 10);
}

function stripCodeFence(value: string) {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function toVisionDetection(value: unknown): VisionDetection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const scientificName = String(record.scientificName ?? "").trim();
  if (!scientificName) return null;

  return {
    scientificName,
    commonName: record.commonName ? String(record.commonName) : undefined,
    confidence: clamp(Number(record.confidence ?? 0.7), 0, 1),
    x: normalizeCoordinate(record.x),
    y: normalizeCoordinate(record.y),
    width: normalizeCoordinate(record.width),
    height: normalizeCoordinate(record.height),
    note: record.note ? String(record.note).slice(0, 180) : undefined,
    isPlant: record.isPlant === false ? false : undefined,
    plantPart: record.plantPart ? String(record.plantPart).slice(0, 40) : undefined,
    topMatches: parseTopMatches(record.topMatches),
    polygon: parsePolygon(record.polygon),
  };
}

function parseTopMatches(value: unknown): VisionDetection["topMatches"] {
  if (!Array.isArray(value)) return undefined;
  const matches = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const scientificName = String(record.scientificName ?? "").trim();
      if (!scientificName) return null;
      return {
        scientificName,
        commonName: record.commonName ? String(record.commonName) : undefined,
        confidence: clamp(Number(record.confidence ?? 0.4), 0, 1),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 2);
  return matches.length ? matches : undefined;
}

function parsePolygon(value: unknown): VisionDetection["polygon"] {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const points = value
    .map((point) => {
      if (!Array.isArray(point) || point.length < 2) return null;
      return [normalizeCoordinate(point[0]), normalizeCoordinate(point[1])] as [
        number,
        number,
      ];
    })
    .filter((point): point is [number, number] => Boolean(point));
  return points.length >= 3 ? points : undefined;
}

function normalizeCoordinate(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 1.5 ? clamp(number / 100, 0, 1) : clamp(number, 0, 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
