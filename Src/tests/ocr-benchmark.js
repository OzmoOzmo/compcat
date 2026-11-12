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

function matchDistance(text, token) {
  const source = normalizeMarking(text);
  const target = normalizeMarking(token);
  if (!target) return 0;
  let previous = new Array(source.length + 1).fill(0);
  for (let i = 1; i <= target.length; i += 1) {
    const current = new Array(source.length + 1);
    current[0] = i;
    for (let j = 1; j <= source.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (target[i - 1] === source[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return Math.min(...previous);
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
  const response = await fetch(`./sample-images/${encodeURIComponent(file)}`);
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
    for (const region of regions) {
      const crop = cropAlignedComponent(bitmap, region, workCanvas.width);
      readings.push(await recognizeComponent(crop));
    }
    return readings.map((reading) => reading.text).filter(Boolean).join("\n");
  } finally {
    bitmap.close();
  }
}

async function runBenchmark() {
  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  rowsElement.replaceChildren();
  summary.textContent = "";
  let exactCount = 0;
  let nearCount = 0;
  let completedCount = 0;
  let errorCount = 0;

  try {
    const response = await fetch("./sample-images/labels.csv");
    if (!response.ok) throw new Error(`Could not load labels.csv (${response.status}).`);
    const entries = (await response.text())
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const [file, expected] = line.split(",");
        if (!file || !expected) throw new Error(`Invalid labels.csv row: ${line}`);
        return { file, expected };
      });
    progress.max = entries.length;

    for (const [index, entry] of entries.entries()) {
      status.textContent = `Processing ${index + 1} of ${entries.length}: ${entry.file}`;
      await new Promise(requestAnimationFrame);
      const row = document.createElement("tr");
      appendCell(row, entry.file);
      appendCell(row, entry.expected);
      try {
        const recognized = await recognizePhoto(entry.file);
        const distance = matchDistance(recognized, entry.expected);
        const exact = distance === 0;
        const near = distance <= 1;
        exactCount += Number(exact);
        nearCount += Number(near);
        completedCount += 1;
        appendCell(row, recognized || "(no marking read)");
        appendCell(row, exact ? "Yes" : "No");
        appendCell(row, near ? "Yes" : "No");
      } catch (error) {
        errorCount += 1;
        appendCell(row, `Error: ${error.message || "recognition failed"}`);
        appendCell(row, "—");
        appendCell(row, "—");
      }
      rowsElement.append(row);
      progress.value = index + 1;
      summary.textContent =
        `Exact: ${exactCount}/${completedCount} (${completedCount ? (100 * exactCount / completedCount).toFixed(1) : "0.0"}%) · ` +
        `Within one edit: ${nearCount}/${completedCount} (${completedCount ? (100 * nearCount / completedCount).toFixed(1) : "0.0"}%) · ` +
        `${errorCount} errors`;
    }
    status.textContent = "Benchmark complete.";
  } catch (error) {
    status.textContent = `Benchmark failed: ${error.message || "unknown error"}`;
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", runBenchmark);
