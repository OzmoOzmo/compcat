import { cropAlignedComponent, detectComponentBounds, normalizeMarking } from "../vision.js?v=2";
import { recognizeComponent } from "../ocr/browser-ocr.js?v=4";

const MAX_IMAGE_SIDE = 1100;
const button = document.getElementById("runBenchmark");
const status = document.getElementById("benchmarkStatus");
const progress = document.getElementById("benchmarkProgress");
const summary = document.getElementById("benchmarkSummary");
const rowsElement = document.getElementById("benchmarkRows");

function appendCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.append(cell);
}

function expectedTokens(label) {
  const quoted = [...label.matchAll(/"([^"]+)"/g)].map((match) => normalizeMarking(match[1])).filter(Boolean);
  if (quoted.length) return quoted;
  return label
    .replace(/\([^)]*\)/g, "")
    .match(/[A-Z0-9]+(?:-[A-Z0-9]+)*/gi)
    ?.map(normalizeMarking)
    .filter((token) => token.length >= 5 && /\d/.test(token)) ?? [];
}

function prepareWorkCanvas(bitmap) {
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not prepare an image for the benchmark.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function recognizePhoto(file) {
  const response = await fetch(`./IPhoneTests/${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`Could not load ${file} (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const workCanvas = prepareWorkCanvas(bitmap);
    const context = workCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not inspect the benchmark image.");
    const { regions } = detectComponentBounds(
      context.getImageData(0, 0, workCanvas.width, workCanvas.height).data,
      workCanvas.width,
      workCanvas.height
    );
    const readings = [];
    if (regions.length === 0) {
      readings.push(await recognizeComponent(workCanvas));
    } else {
      for (const region of regions) {
        const crop = cropAlignedComponent(bitmap, region, workCanvas.width);
        readings.push(await recognizeComponent(crop));
      }
    }
    return {
      regionCount: regions.length,
      text: readings.map((reading) => reading.text).filter(Boolean).join("\n"),
      variantTexts: readings.flatMap((reading) => reading.variants.map((variant) => variant.text)).filter(Boolean)
    };
  } finally {
    bitmap.close();
  }
}

function parseLabels(csv) {
  return csv.trim().split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
    const separator = line.indexOf(",");
    if (separator < 1) throw new Error(`Invalid labels.csv row: ${line}`);
    const file = line.slice(0, separator).trim();
    const expected = line.slice(separator + 1).trim();
    if (expected.startsWith("resistor-bands|") || expected.startsWith("resistor-reference|")) {
      const [type, ...values] = expected.split("|");
      return { file, type, values };
    }
    return { file, expected, type: "markings" };
  });
}

async function runBenchmark() {
  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  rowsElement.replaceChildren();
  summary.textContent = "";
  let matchedTokens = 0;
  let anyRotationMatchedTokens = 0;
  let totalTokens = 0;
  let errors = 0;

  try {
    const response = await fetch("./IPhoneTests/labels.csv");
    if (!response.ok) throw new Error(`Could not load labels.csv (${response.status}).`);
    const entries = parseLabels(await response.text());
    progress.max = entries.length;

    for (const [index, entry] of entries.entries()) {
      status.textContent = `Processing ${index + 1} of ${entries.length}: ${entry.file}`;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const row = document.createElement("tr");
      appendCell(row, entry.file);
      if (entry.type !== "markings") {
        appendCell(row, entry.type === "resistor-bands" ? "Resistor values, left to right" : "Labeled resistor reference chart");
        appendCell(row, "—");
        appendCell(row, entry.values.join("; "));
        appendCell(row, `${entry.values.length} labeled values; not part of OCR score`);
        rowsElement.append(row);
        progress.value = index + 1;
        continue;
      }
      appendCell(row, entry.expected);
      try {
        const result = await recognizePhoto(entry.file);
        const recognized = normalizeMarking(result.text);
        const tokens = expectedTokens(entry.expected);
        const matches = tokens.filter((token) => recognized.includes(token));
        const anyRotationMatches = tokens.filter((token) =>
          result.variantTexts.some((text) => normalizeMarking(text).includes(token))
        );
        matchedTokens += matches.length;
        anyRotationMatchedTokens += anyRotationMatches.length;
        totalTokens += tokens.length;
        appendCell(row, String(result.regionCount));
        appendCell(row, result.text || "(no marking read)");
        appendCell(
          row,
          tokens.length
            ? `Selected: ${matches.length}/${tokens.length}; any rotation: ${anyRotationMatches.length}/${tokens.length}`
            : "No scoreable marking"
        );
      } catch (error) {
        errors += 1;
        appendCell(row, "—");
        appendCell(row, `Error: ${error.message || "recognition failed"}`);
        appendCell(row, "—");
      }
      rowsElement.append(row);
      progress.value = index + 1;
      summary.textContent = `Selected-rotation matches: ${matchedTokens}/${totalTokens} (${totalTokens ? (100 * matchedTokens / totalTokens).toFixed(1) : "0.0"}%); any-rotation potential: ${anyRotationMatchedTokens}/${totalTokens} (${totalTokens ? (100 * anyRotationMatchedTokens / totalTokens).toFixed(1) : "0.0"}%) · ${errors} image errors`;
    }
    status.textContent = "Benchmark complete.";
  } catch (error) {
    status.textContent = `Benchmark failed: ${error.message || "unknown error"}`;
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", runBenchmark);
