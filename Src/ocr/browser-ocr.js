const RUNTIME_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs";
const DETECTOR_URL = new URL("./models/det_ppocrv3.onnx", import.meta.url);
const RECOGNIZER_URL = new URL("./models/rec_en_ppocrv5.onnx", import.meta.url);
const DICTIONARY_URL = new URL("./models/dict_en_ppocrv5.txt", import.meta.url);
const DETECTOR_MIN_SIDE = 736;
const DETECTOR_THRESHOLD = 0.3;
const BOX_SCORE_THRESHOLD = 0.5;
const DETECTOR_UNCLIP = 1.6;
const RECOGNIZER_HEIGHT = 48;
const RECOGNIZER_MIN_WIDTH = 320;
const MIN_LINE_CONFIDENCE = 0.5;
const DETECTOR_MEAN = [0.485, 0.456, 0.406];
const DETECTOR_STD = [0.229, 0.224, 0.225];
let enginePromise;

function resizeDimensions(width, height, minSide) {
  const scale = Math.max(1, minSide / Math.min(width, height));
  const resizedWidth = Math.max(32, Math.round((width * scale) / 32) * 32);
  const resizedHeight = Math.max(32, Math.round((height * scale) / 32) * 32);
  return { width: resizedWidth, height: resizedHeight };
}

function imageDataFor(canvas, width, height) {
  const resized = document.createElement("canvas");
  resized.width = width;
  resized.height = height;
  const context = resized.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not prepare an image for text recognition.");
  context.drawImage(canvas, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

function chwTensorData(pixels, width, height, mean, standardDeviation) {
  const planeSize = width * height;
  const data = new Float32Array(planeSize * 3);
  for (let index = 0; index < planeSize; index += 1) {
    const pixel = index * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const rgbChannel = 2 - channel;
      data[channel * planeSize + index] =
        (pixels[pixel + rgbChannel] / 255 - mean[channel]) / standardDeviation[channel];
    }
  }
  return data;
}

function connectedRegions(probabilities, width, height) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      mask[index] = (
        probabilities[index] > DETECTOR_THRESHOLD ||
        (x > 0 && probabilities[index - 1] > DETECTOR_THRESHOLD) ||
        (y > 0 && probabilities[index - width] > DETECTOR_THRESHOLD) ||
        (x > 0 && y > 0 && probabilities[index - width - 1] > DETECTOR_THRESHOLD)
      ) ? 1 : 0;
    }
  }

  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const regions = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let probabilitySum = 0;
    let area = 0;
    const boundary = [];

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      probabilitySum += probabilities[index];
      area += 1;
      let touchesBoundary = false;

      for (let dy = -1; dy <= 1; dy += 1) {
        const nextY = y + dy;
        if (nextY < 0 || nextY >= height) {
          touchesBoundary = true;
          continue;
        }
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          if (nextX < 0 || nextX >= width) {
            touchesBoundary = true;
            continue;
          }
          const next = nextY * width + nextX;
          if (!mask[next]) {
            touchesBoundary = true;
          } else if (!seen[next]) {
            seen[next] = 1;
            queue[tail++] = next;
          }
        }
      }
      if (touchesBoundary) boundary.push({ x, y });
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    if (boxWidth < 3 || boxHeight < 3 || area < 3) continue;
    regions.push({
      points: boundary,
      meanProbability: probabilitySum / area,
      area
    });
  }
  return regions;
}

function convexHull(points) {
  if (points.length <= 2) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (origin, a, b) =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function minimumAreaRectangle(points) {
  const hull = convexHull(points);
  let best = null;
  let minimumArea = Infinity;
  for (let index = 0; index < hull.length; index += 1) {
    const first = hull[index];
    const second = hull[(index + 1) % hull.length];
    const angle = Math.atan2(second.y - first.y, second.x - first.x);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const vx = -uy;
    const vy = ux;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const point of hull) {
      const u = point.x * ux + point.y * uy;
      const v = point.x * vx + point.y * vy;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const boxWidth = maxU - minU;
    const boxHeight = maxV - minV;
    const area = boxWidth * boxHeight;
    if (area >= minimumArea) continue;
    minimumArea = area;
    best = {
      center: {
        x: ((minU + maxU) / 2) * ux + ((minV + maxV) / 2) * vx,
        y: ((minU + maxU) / 2) * uy + ((minV + maxV) / 2) * vy
      },
      width: boxWidth,
      height: boxHeight,
      angle
    };
  }
  if (!best) return null;
  if (best.height > best.width) {
    [best.width, best.height] = [best.height, best.width];
    best.angle += Math.PI / 2;
  }
  while (best.angle > Math.PI / 4) {
    best.angle -= Math.PI / 2;
    [best.width, best.height] = [best.height, best.width];
  }
  while (best.angle <= -Math.PI / 4) {
    best.angle += Math.PI / 2;
    [best.width, best.height] = [best.height, best.width];
  }
  return best;
}

function detectorBoxes(probabilities, width, height) {
  return connectedRegions(probabilities, width, height)
    .filter((region) => region.meanProbability >= BOX_SCORE_THRESHOLD)
    .map((region) => {
      const rectangle = minimumAreaRectangle(region.points);
      if (!rectangle) return null;
      const expansion = rectangle.width * rectangle.height * DETECTOR_UNCLIP /
        (2 * (rectangle.width + rectangle.height));
      rectangle.width += 2 * expansion;
      rectangle.height += 2 * expansion;
      return rectangle.width > 5 && rectangle.height > 5 ? rectangle : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x);
}

function cropRotatedLine(source, rectangle, scaleX, scaleY) {
  const centerX = rectangle.center.x * scaleX;
  const centerY = rectangle.center.y * scaleY;
  const width = Math.max(1, Math.round(rectangle.width * (scaleX + scaleY) / 2));
  const height = Math.max(1, Math.round(rectangle.height * (scaleX + scaleY) / 2));
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const context = output.getContext("2d");
  if (!context) throw new Error("Could not crop a recognized text line.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.translate(width / 2, height / 2);
  context.rotate(-rectangle.angle);
  context.drawImage(source, -centerX, -centerY);
  return output;
}

function decodeCtc(probabilities, steps, classes, dictionary) {
  let text = "";
  let confidenceSum = 0;
  let characterCount = 0;
  let previous = -1;
  for (let step = 0; step < steps; step += 1) {
    const offset = step * classes;
    let bestClass = 0;
    for (let character = 1; character < classes; character += 1) {
      if (probabilities[offset + character] > probabilities[offset + bestClass]) {
        bestClass = character;
      }
    }
    if (bestClass !== 0 && bestClass !== previous && dictionary[bestClass] !== undefined) {
      text += dictionary[bestClass];
      confidenceSum += probabilities[offset + bestClass];
      characterCount += 1;
    }
    previous = bestClass;
  }
  return { text, confidence: characterCount ? confidenceSum / characterCount : 0 };
}

export function correctLikelyDigitConfusions(text) {
  return text.replace(/[A-Z0-9]+/gi, (token) => {
    const digitCount = (token.match(/\d/g) ?? []).length;
    if (digitCount < 2 || !/[A-Z]/i.test(token)) return token;
    return token.replace(/O/gi, "0").replace(/S(?=5)/gi, "5");
  });
}

async function loadEngine() {
  const ort = await import(RUNTIME_URL);
  ort.env.wasm.numThreads = 1;
  const [detectorBytes, recognizerBytes, dictionaryText] = await Promise.all([
    fetch(DETECTOR_URL).then((response) => {
      if (!response.ok) throw new Error(`Could not load the text detector (${response.status}).`);
      return response.arrayBuffer();
    }),
    fetch(RECOGNIZER_URL).then((response) => {
      if (!response.ok) throw new Error(`Could not load the marking recognizer (${response.status}).`);
      return response.arrayBuffer();
    }),
    fetch(DICTIONARY_URL).then((response) => {
      if (!response.ok) throw new Error(`Could not load the OCR character dictionary (${response.status}).`);
      return response.text();
    })
  ]);
  const [detector, recognizer] = await Promise.all([
    ort.InferenceSession.create(detectorBytes, { executionProviders: ["wasm"] }),
    ort.InferenceSession.create(recognizerBytes, { executionProviders: ["wasm"] })
  ]);
  const dictionary = ["", ...dictionaryText.replace(/\r/g, "").trimEnd().split("\n"), " "];
  return { ort, detector, recognizer, dictionary };
}

function getEngine() {
  if (!enginePromise) {
    enginePromise = loadEngine().catch((error) => {
      enginePromise = undefined;
      throw error;
    });
  }
  return enginePromise;
}

async function detectLines(engine, canvas) {
  const dimensions = resizeDimensions(canvas.width, canvas.height, DETECTOR_MIN_SIDE);
  const pixels = imageDataFor(canvas, dimensions.width, dimensions.height);
  const tensor = new engine.ort.Tensor(
    "float32",
    chwTensorData(pixels, dimensions.width, dimensions.height, DETECTOR_MEAN, DETECTOR_STD),
    [1, 3, dimensions.height, dimensions.width]
  );
  const output = await engine.detector.run({ x: tensor });
  const probabilities = Object.values(output)[0].data;
  const boxes = detectorBoxes(probabilities, dimensions.width, dimensions.height);
  return boxes.map((box) => ({
    canvas: cropRotatedLine(
      canvas,
      box,
      canvas.width / dimensions.width,
      canvas.height / dimensions.height
    ),
    box
  }));
}

async function recognizeLine(engine, canvas) {
  const ratio = canvas.width / canvas.height;
  const targetWidth = Math.max(
    RECOGNIZER_MIN_WIDTH,
    Math.min(4096, Math.ceil(RECOGNIZER_HEIGHT * ratio))
  );
  const tensorWidth = targetWidth;
  const pixels = imageDataFor(canvas, tensorWidth, RECOGNIZER_HEIGHT);
  const data = chwTensorData(pixels, tensorWidth, RECOGNIZER_HEIGHT, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  const tensor = new engine.ort.Tensor("float32", data, [1, 3, RECOGNIZER_HEIGHT, tensorWidth]);
  const output = await engine.recognizer.run({ x: tensor });
  const result = Object.values(output)[0];
  return decodeCtc(result.data, result.dims[1], result.dims[2], engine.dictionary);
}

export async function recognizeComponent(canvas) {
  const engine = await getEngine();
  const variants = [];
  for (let rotation = 0; rotation < 4; rotation += 1) {
    const oriented = document.createElement("canvas");
    oriented.width = rotation % 2 ? canvas.height : canvas.width;
    oriented.height = rotation % 2 ? canvas.width : canvas.height;
    const context = oriented.getContext("2d");
    if (!context) throw new Error("Could not rotate a component for text recognition.");
    context.translate(oriented.width / 2, oriented.height / 2);
    context.rotate(rotation * Math.PI / 2);
    context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);

    const lines = await detectLines(engine, oriented);
    const recognized = [];
    for (const line of lines) {
      const result = await recognizeLine(engine, line.canvas);
      if (result.text.trim()) recognized.push({ ...result, box: line.box });
    }
    const accepted = recognized.filter((line) => line.confidence >= MIN_LINE_CONFIDENCE);
    accepted.sort((a, b) => {
      const topDistance =
        (a.box.center.y - a.box.height / 2) - (b.box.center.y - b.box.height / 2);
      return Math.abs(topDistance) > a.box.height / 2
        ? topDistance
        : a.box.center.x - b.box.center.x;
    });
    const text = accepted.map((line) => line.text.trim()).join("\n");
    const characters = accepted.reduce(
      (count, line) => count + line.text.replace(/[^A-Z0-9]/gi, "").length,
      0
    );
    const score = accepted.reduce(
      (total, line) => total + line.confidence * line.text.replace(/[^A-Z0-9]/gi, "").length,
      0
    );
    const confidence = characters ? score / characters : 0;
    variants.push({
      rotation,
      text,
      confidence,
      lines: recognized.map((line) => ({
        text: line.text,
        confidence: line.confidence,
        box: line.box
      })),
      score
    });
  }
  variants.sort((a, b) => b.score - a.score);
  const best = variants[0] ?? { text: "", confidence: 0 };
  return {
    text: correctLikelyDigitConfusions(best.text),
    confidence: best.confidence,
    variants
  };
}
