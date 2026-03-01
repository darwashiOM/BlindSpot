import { GoogleGenAI } from "@google/genai";

export function getGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing");
  }
  return new GoogleGenAI({ apiKey });
}