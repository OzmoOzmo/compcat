import { cropAlignedComponent, detectComponentBounds, normalizeMarking } from "../vision.js?v=2";
import { recognizeComponent } from "../ocr/browser-ocr.js?v=4";

const MAX_IMAGE_SIDE = 1100;
const LABELS_URL = "../TrainingData/training/labels.csv";
const IMAGES_URL = "../TrainingData/training/images/";
const button = document.getElementById("runBenchmark");
const status = document.getElementById("benchmarkStatus");
const progress = document.getElementById("benchmarkProgress");
const summary = document.getElementById("benchmarkSummary");
const rowsElement = document.getElementById("benchmarkRows");
const imagePreview = document.createElement("div");
const previewImage = document.createElement("img");
imagePreview.className = "benchmark-image-preview";
imagePreview.setAttribute("aria-hidden", "true");
imagePreview.hidden = true;
imagePreview.append(previewImage);
document.body.append(imagePreview);

function appendCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.append(cell);
}

function positionPreview(x, y) {
  const margin = 12;
  const gap = 16;
  const bounds = imagePreview.getBoundingClientRect();
  const left = x + gap + bounds.width <= window.innerWidth - margin
    ? x + gap
    : Math.max(margin, x - gap - bounds.width);
  const top = y + gap + bounds.height <= window.innerHeight - margin
    ? y + gap
    : Math.max(margin, y - gap - bounds.height);
  imagePreview.style.left = `${left}px`;
  imagePreview.style.top = `${top}px`;
}

function showPreview(link, x, y) {
  previewImage.src = link.href;
  previewImage.alt = link.textContent;
  imagePreview.hidden = false;
  positionPreview(x, y);
}

function appendImageLink(cell, file) {
  const link = document.createElement("a");
  link.className = "benchmark-photo-link";
  link.href = `${IMAGES_URL}${encodeURIComponent(file)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = file;
  link.title = "Hover or focus to preview; click to open the image in a new tab";
  link.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") showPreview(link, event.clientX, event.clientY);
  });
  link.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse" && !imagePreview.hidden) {
      positionPreview(event.clientX, event.clientY);
    }
  });
  link.addEventListener("pointerleave", () => {
    imagePreview.hidden = true;
  });
  link.addEventListener("focus", () => {
    const bounds = link.getBoundingClientRect();
    showPreview(link, bounds.right, bounds.top);
  });
  link.addEventListener("blur", () => {
    imagePreview.hidden = true;
  });
  cell.append(link);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("The consolidated labels.csv has an unterminated quoted field.");
  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => cell.trim())) rows.push(row);
  }
  return rows;
}

function parseLabels(csv) {
  const rows = parseCsv(csv);
  if (rows[0]?.[0]?.trim().toLowerCase() !== "file" ||
      rows[0]?.[1]?.trim().toLowerCase() !== "expected") {
    throw new Error("The consolidated labels.csv must start with the columns file,expected.");
  }
  const seen = new Set();
  return rows.slice(1).map(([file, expected]) => {
    if (!file?.trim() || !expected?.trim()) {
      throw new Error("The consolidated labels.csv contains a row without a file or expected label.");
    }
    const key = file.trim().toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate image in labels.csv: ${file}`);
    seen.add(key);
    return { file: file.trim(), expected: expected.trim() };
  });
}

function expectedTokens(label) {
  const tokens = new Set();
  for (const part of label.split(",")) {
    const combined = normalizeMarking(part);
    if (combined.length >= 3 && /\d/.test(combined)) tokens.add(combined);
    for (const match of part.match(/[A-Z0-9]+(?:[-.][A-Z0-9]+)*/gi) ?? []) {
      const token = normalizeMarking(match);
      if (token.length >= 4 && /[A-Z]/.test(token) && /\d/.test(token)) tokens.add(token);
    }
    if (!/\d/.test(label) && /^[A-Z]{4,}$/i.test(part.trim())) {
      tokens.add(normalizeMarking(part));
    }
  }
  return [...tokens];
}

function matchDistance(source, target) {
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
  const response = await fetch(`${IMAGES_URL}${encodeURIComponent(file)}`);
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
      text: readings.map((reading) => reading.text).filter(Boolean).join("\n")
    };
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
  let exactImages = 0;
  let nearImages = 0;
  let matchedTokens = 0;
  let totalTokens = 0;
  let completedCount = 0;
  let errorCount = 0;
  let unscoredCount = 0;

  try {
    const response = await fetch(LABELS_URL);
    if (!response.ok) throw new Error(`Could not load consolidated labels.csv (${response.status}).`);
    const entries = parseLabels(await response.text());
    progress.max = entries.length;

    for (const [index, entry] of entries.entries()) {
      status.textContent = `Processing ${index + 1} of ${entries.length}: ${entry.file}`;
      await new Promise(requestAnimationFrame);
      const row = document.createElement("tr");
      const photoCell = document.createElement("td");
      appendImageLink(photoCell, entry.file);
      row.append(photoCell);
      appendCell(row, entry.expected);
      try {
        const result = await recognizePhoto(entry.file);
        const recognized = normalizeMarking(result.text);
        const tokens = expectedTokens(entry.expected);
        const matches = tokens.filter((token) => recognized.includes(token));
        const nearMatches = tokens.filter((token) => matchDistance(recognized, token) <= 1);
        const exact = matches.length > 0;
        const near = nearMatches.length > 0;
        exactImages += Number(exact);
        nearImages += Number(near);
        matchedTokens += matches.length;
        totalTokens += tokens.length;
        unscoredCount += Number(tokens.length === 0);
        completedCount += 1;
        appendCell(row, String(result.regionCount));
        appendCell(row, result.text || "(no marking read)");
        appendCell(row, tokens.length ? `${matches.length}/${tokens.length} exact` : "No scoreable label");
        appendCell(row, exact ? "Yes" : "No");
        appendCell(row, near ? "Yes" : "No");
      } catch (error) {
        errorCount += 1;
        appendCell(row, "—");
        appendCell(row, `Error: ${error.message || "recognition failed"}`);
        appendCell(row, "—");
        appendCell(row, "—");
        appendCell(row, "—");
      }
      rowsElement.append(row);
      progress.value = index + 1;
      const scoredCount = completedCount - unscoredCount;
      summary.textContent =
        `Images with an exact expected-text hit: ${exactImages}/${scoredCount} (${scoredCount ? (100 * exactImages / scoredCount).toFixed(1) : "0.0"}%) · ` +
        `within one edit: ${nearImages}/${scoredCount} (${scoredCount ? (100 * nearImages / scoredCount).toFixed(1) : "0.0"}%) · ` +
        `exact expected-text tokens: ${matchedTokens}/${totalTokens} (${totalTokens ? (100 * matchedTokens / totalTokens).toFixed(1) : "0.0"}%) · ` +
        `${errorCount} image errors, ${unscoredCount} unscored`;
    }
    status.textContent = "Benchmark complete.";
  } catch (error) {
    status.textContent = `Benchmark failed: ${error.message || "unknown error"}`;
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", runBenchmark);
