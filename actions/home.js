"use server";

import { GoogleGenAI } from "@google/genai";
import { db } from "@/lib/prisma";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";

// Function to serialize car data
function serializeCarData(car) {
  return {
    ...car,
    price: car.price ? parseFloat(car.price.toString()) : 0,
    createdAt: car.createdAt?.toISOString(),
    updatedAt: car.updatedAt?.toISOString(),
  };
}

/**
 * Get featured cars for the homepage
 */
export async function getFeaturedCars(limit = 3) {
  try {
    const cars = await db.car.findMany({
      where: {
        featured: true,
        status: "AVAILABLE",
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    return cars.map(serializeCarData);
  } catch (error) {
    throw new Error("Error fetching featured cars:" + error.message);
  }
}

// Function to convert File to base64
async function fileToBase64(file) {
  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  return buffer.toString("base64");
}

/**
 * Process car image with Gemini AI
 */
export async function processImageSearch(file) {
  try {
    // ArcJet rate limit check
    const req = await request();
    const decision = await aj.protect(req, { requested: 1 });
    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        const { remaining, reset } = decision.reason;
        console.error({
          code: "RATE_LIMIT_EXCEEDED",
          details: { remaining, resetInSeconds: reset },
        });
        throw new Error("Too many requests. Please try again later.");
      }
      throw new Error("Request blocked");
    }

    // Check Gemini API key
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Gemini API key is not configured");
    }

    // ----------------------------
    // Define prompt
    // ----------------------------
    const prompt = `
      Analyze this car image and extract the following information:
      1. Make
      2. Body type
      3. Color

      Return JSON:
      {
        "make": "",
        "bodyType": "",
        "color": "",
        "confidence": 0.0
      }
    `;

    // Initialize Gemini
    const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Convert image to Base64
    const base64Image = await fileToBase64(file);

    // ----------------------------------------------------
    // UPDATED LOGIC: Ensure valid and supported MIME type
    // ----------------------------------------------------
    const supportedMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
    let mimeType = "image/jpeg"; // Default to a common format if type is missing

    if (file?.type) {
      const fileType = file.type.trim().toLowerCase();
      
      // Use the file type if it's explicitly supported
      if (supportedMimeTypes.includes(fileType)) {
        mimeType = fileType;
      } else {
        // Log a warning if the file type is present but unsupported
        console.warn(`Unsupported file type '${fileType}' detected. Falling back to default: ${mimeType}`);
      }
    } else {
      // Log a warning if file.type is missing
      console.warn("File MIME type is missing from the file object. Falling back to default: image/jpeg");
    }
    
    // ----------------------------
    // Call Gemini 2.5 Flash
    // ----------------------------
    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          // NOTE: The 'type' and 'modality' keys here are for the array item itself.
          // The structure within 'parts' is what matters for the image data.
          // Your original structure was slightly redundant but functionally correct 
          // based on the structure expected by the SDK's generateContent method.
          parts: [
            {
              // The 'parts' array should contain the actual data parts.
              // The SDK typically handles wrapping the parts into a Content object.
              // We'll simplify the structure based on the common SDK usage pattern 
              // for multi-part requests, ensuring 'mimeType' is correctly passed.
              inlineData: {
                data: base64Image,
                mimeType: mimeType, // Use the determined MIME type
              },
            },
          ],
        },
        {
          parts: [{ text: prompt }],
        },
      ],
    });

    // Extract AI response
    // NOTE: The new SDK structure for accessing the text is simpler
    // result.response.text should be used instead of digging through response[0].content[0].text
    const text = result.text || ""; 
    const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

    // Parse JSON response
    try {
      const carDetails = JSON.parse(cleanedText);
      return { success: true, data: carDetails };
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError);
      console.log("Raw response:", text);
      return { success: false, error: "Failed to parse AI response" };
    }
  } catch (error) {
    // Add logging for the core error message
    console.error("Caught an error in processImageSearch:", error.message);
    // Ensure the thrown error message is clear
    throw new Error("AI Search error: " + error.message);
  }
}