import test from "node:test";
import assert from "node:assert/strict";
import { requestGeminiDetails } from "../gemini.js";

test("requests component details through Gemini Interactions with structured JSON output", async () => {
  let requestUrl;
  let requestOptions;
  const details = {
    manufacturer: "Texas Instruments",
    description: "Dual operational amplifier",
    datasheetUrl: "https://example.com/datasheet.pdf",
    pinout: "See datasheet"
  };

  const result = await requestGeminiDetails("Identify LM358", "test-key", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return {
      ok: true,
      json: async () => ({ output_text: JSON.stringify(details) })
    };
  });

  assert.equal(requestUrl, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.headers["x-goog-api-key"], "test-key");
  assert.deepEqual(JSON.parse(requestOptions.body), {
    model: "gemini-3.8-flash",
    input: "Identify LM358",
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: {
        type: "object",
        properties: {
          manufacturer: { type: "string" },
          description: { type: "string" },
          datasheetUrl: { type: "string" },
          pinout: { type: "string" }
        },
        required: ["manufacturer", "description", "datasheetUrl", "pinout"]
      }
    }
  });
  assert.deepEqual(result, details);
});

test("reports Gemini API errors", async () => {
  await assert.rejects(
    requestGeminiDetails("Identify LM358", "test-key", async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid API key." } })
    })),
    /Invalid API key\./
  );
});

test("rejects empty or invalid JSON output", async () => {
  await assert.rejects(
    requestGeminiDetails("Identify LM358", "test-key", async () => ({
      ok: true,
      json: async () => ({ output_text: "" })
    })),
    /Gemini returned no details/
  );
  await assert.rejects(
    requestGeminiDetails("Identify LM358", "test-key", async () => ({
      ok: true,
      json: async () => ({ output_text: "not JSON" })
    })),
    SyntaxError
  );
});
