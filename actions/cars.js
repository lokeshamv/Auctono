"use server";

import { GoogleGenAI } from "@google/genai";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/lib/prisma";
import { createClient } from "@/lib/supabase";
import { auth } from "@clerk/nextjs/server";
import { serializeCarData } from "@/lib/helpers";

// Convert file to base64
async function fileToBase64(file) {
  const bytes = await file.arrayBuffer();
  return Buffer.from(bytes).toString("base64");
}

// -------------------------------------------------------------
// 🚗 GEMINI: Extract Car Details (NEW GOOGLE API)
// -------------------------------------------------------------
export async function processCarImageWithAI(file) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Gemini API key missing");
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const base64Image = await fileToBase64(file);

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                data: base64Image,
                mimeType: file.type,
              },
            },
            {
              text: `
                Extract car details from image.
                Respond ONLY in this JSON format:
                {
                  "make": "",
                  "model": "",
                  "year": 0,
                  "color": "",
                  "bodyType": "",
                  "mileage": "",
                  "fuelType": "",
                  "transmission": "",
                  "price": "",
                  "description": "",
                  "confidence": 0.0
                }
              `,
            },
          ],
        },
      ],
    });

    // -------- UNIVERSAL GOOGLE TEXT EXTRACTOR --------
    let rawText = "";

    if (response?.candidates?.[0]?.content?.[0]?.text) {
      rawText = response.candidates[0].content[0].text;
    } else if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
      rawText = response.candidates[0].content.parts[0].text;
    } else if (response?.candidates?.[0]?.content?.[0]?.parts?.[0]?.text) {
      rawText = response.candidates[0].content[0].parts[0].text;
    } else {
      console.log("🛑 RAW GOOGLE RESPONSE:", JSON.stringify(response, null, 2));
      throw new Error("AI returned unexpected format");
    }

    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const data = JSON.parse(cleaned);

    return { success: true, data };
  } catch (error) {
    console.error("Gemini Error:", error);
    return { success: false, error: error.message };
  }
}

// -------------------------------------------------------------
// 🚗 Add Car + Upload Images to Supabase
// -------------------------------------------------------------
export async function addCar({ carData, images }) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    const carId = uuidv4();
    const folderPath = `cars/${carId}`;

    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const imageUrls = [];

    for (let i = 0; i < images.length; i++) {
      const base64Data = images[i];
      if (!base64Data.startsWith("data:image/")) continue;

      const base64 = base64Data.split(",")[1];
      const fileExt = base64Data.match(/data:image\/(.+);/)[1] || "jpeg";

      const buffer = Buffer.from(base64, "base64");
      const fileName = `image-${Date.now()}-${i}.${fileExt}`;
      const filePath = `${folderPath}/${fileName}`;

      const { error } = await supabase.storage
        .from("car-images")
        .upload(filePath, buffer, {
          contentType: `image/${fileExt}`,
        });

      if (error) throw new Error(`Image upload failed: ${error.message}`);

      const publicUrl =
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/car-images/${filePath}`;

      imageUrls.push(publicUrl);
    }

    if (imageUrls.length === 0) {
      throw new Error("No valid images uploaded");
    }

    await db.car.create({
      data: {
        id: carId,
        ...carData,
        images: imageUrls,
      },
    });

    revalidatePath("/admin/cars");

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// -------------------------------------------------------------
// 🚗 Get Cars (searchable)
// -------------------------------------------------------------
export async function getCars(search = "") {
  try {
    const where = search
      ? {
          OR: [
            { make: { contains: search, mode: "insensitive" } },
            { model: { contains: search, mode: "insensitive" } },
            { color: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    const cars = await db.car.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return {
      success: true,
      data: cars.map(serializeCarData),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// -------------------------------------------------------------
// 🚗 Delete Car + Images
// -------------------------------------------------------------
export async function deleteCar(id) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const car = await db.car.findUnique({
      where: { id },
      select: { images: true },
    });

    if (!car) return { success: false, error: "Car not found" };

    await db.car.delete({ where: { id } });

    const supabase = createClient(cookies());

    const filePaths = car.images.map((img) => {
      const url = new URL(img);
      return url.pathname.split("/car-images/")[1];
    });

    await supabase.storage.from("car-images").remove(filePaths);

    revalidatePath("/admin/cars");

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// -------------------------------------------------------------
// 🚗 Update Car Status
// -------------------------------------------------------------
export async function updateCarStatus(id, { status, featured }) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    await db.car.update({
      where: { id },
      data: {
        ...(status !== undefined && { status }),
        ...(featured !== undefined && { featured }),
      },
    });

    revalidatePath("/admin/cars");

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
