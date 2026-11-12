const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DETAILS_SCHEMA = {
  type: "object",
  properties: {
    manufacturer: { type: "string" },
    description: { type: "string" },
    datasheetUrl: { type: "string" },
    pinout: { type: "string" }
  },
  required: ["manufacturer", "description", "datasheetUrl", "pinout"]
};

export async function requestGeminiDetails(prompt, key, fetchImpl = fetch) {
  const response = await fetchImpl(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: prompt,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: DETAILS_SCHEMA
      }
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `Gemini request failed (${response.status}).`);
  if (typeof payload.output_text !== "string" || !payload.output_text.trim()) {
    throw new Error("Gemini returned no details for this part.");
  }
  return JSON.parse(payload.output_text);
}
