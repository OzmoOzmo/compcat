const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function filterLine(source, radius, maximum) {
  const length = source.length;
  const output = new Float32Array(length);
  const queue = new Int32Array(length);
  let head = 0;
  let tail = 0;
  let next = 0;

  for (let center = 0; center < length; center += 1) {
    const right = Math.min(length - 1, center + radius);
    while (next <= right) {
      while (tail > head) {
        const previous = source[queue[tail - 1]];
        if (maximum ? previous > source[next] : previous < source[next]) break;
        tail -= 1;
      }
      queue[tail] = next;
      tail += 1;
      next += 1;
    }

    const left = Math.max(0, center - radius);
    while (head < tail && queue[head] < left) head += 1;
    output[center] = source[queue[head]];
  }
  return output;
}

function separableFilter(source, width, height, radius, maximum) {
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  const line = new Float32Array(Math.max(width, height));

  for (let y = 0; y < height; y += 1) {
    const start = y * width;
    line.set(source.subarray(start, start + width), 0);
    horizontal.set(filterLine(line.subarray(0, width), radius, maximum), start);
  }

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) line[y] = horizontal[y * width + x];
    const filtered = filterLine(line.subarray(0, height), radius, maximum);
    for (let y = 0; y < height; y += 1) output[y * width + x] = filtered[y];
  }
  return output;
}

function boxBlur(source, width, height, radius) {
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  const line = new Float32Array(Math.max(width, height));

  for (let y = 0; y < height; y += 1) {
    const start = y * width;
    line.set(source.subarray(start, start + width), 0);
    const prefix = new Float64Array(width + 1);
    for (let x = 0; x < width; x += 1) prefix[x + 1] = prefix[x] + line[x];
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      horizontal[start + x] = (prefix[right + 1] - prefix[left]) / (right - left + 1);
    }
  }

  for (let x = 0; x < width; x += 1) {
    const prefix = new Float64Array(height + 1);
    for (let y = 0; y < height; y += 1) {
      line[y] = horizontal[y * width + x];
      prefix[y + 1] = prefix[y] + line[y];
    }
    for (let y = 0; y < height; y += 1) {
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height - 1, y + radius);
      output[y * width + x] = (prefix[bottom + 1] - prefix[top]) / (bottom - top + 1);
    }
  }
  return output;
}

function otsuThreshold(values) {
  const histogram = new Uint32Array(256);
  let total = 0;
  let sum = 0;

  for (const value of values) {
    const bin = clamp(Math.round(value), 0, 255);
    histogram[bin] += 1;
    total += 1;
    sum += bin;
  }

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let bestThreshold = 0;
  for (let threshold = 0; threshold < 256; threshold += 1) {
    backgroundWeight += histogram[threshold];
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += threshold * histogram[threshold];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
}

function morph(mask, width, height, radius, maximum) {
  return separableFilter(mask, width, height, radius, maximum);
}

function getComponents(mask, width, height, minimumArea, foreground = null) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  const neighbors = [-1, 0, 1];

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    seen[start] = 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let contrastTotal = 0;

    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      area += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (foreground) contrastTotal += foreground[index];

      for (const dy of neighbors) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (const dx of neighbors) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (mask[next] === 0 || seen[next]) continue;
          seen[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const boxArea = boxWidth * boxHeight;
    if (
      area >= minimumArea &&
      boxWidth >= 10 &&
      boxHeight >= 10 &&
      area / boxArea >= 0.08
    ) {
      const localMask = new Float32Array(boxArea);
      for (let i = 0; i < tail; i += 1) {
        const index = queue[i];
        const x = index % width;
        const y = Math.floor(index / width);
        localMask[(y - minY) * boxWidth + x - minX] = 1;
      }
      components.push({
        x: minX,
        y: minY,
        width: boxWidth,
        height: boxHeight,
        area,
        contrast: foreground ? contrastTotal / area : 0,
        mask: localMask
      });
    }
  }
  return components;
}

function fitMaskOrientation(mask, width, height, offsetX = 0, offsetY = 0) {
  const boundary = [];
  const contains = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] > 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!contains(x, y)) continue;
      if (contains(x - 1, y) && contains(x + 1, y) && contains(x, y - 1) && contains(x, y + 1)) continue;
      boundary.push(
        { x, y },
        { x: x + 1, y },
        { x, y: y + 1 },
        { x: x + 1, y: y + 1 }
      );
    }
  }
  if (!boundary.length) return null;
  boundary.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (origin, a, b) =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower = [];
  for (const point of boundary) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = boundary.length - 1; index >= 0; index -= 1) {
    const point = boundary[index];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  let best = null;
  let bestArea = Infinity;
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
    if (area >= bestArea) continue;
    bestArea = area;
    best = {
      centerX: ((minU + maxU) / 2) * ux + ((minV + maxV) / 2) * vx,
      centerY: ((minU + maxU) / 2) * uy + ((minV + maxV) / 2) * vy,
      width: boxWidth,
      height: boxHeight,
      angle
    };
  }
  let orientedWidth = best.width;
  let orientedHeight = best.height;
  let normalizedAngle = best.angle;
  if (orientedHeight > orientedWidth) {
    [orientedWidth, orientedHeight] = [orientedHeight, orientedWidth];
    normalizedAngle += Math.PI / 2;
  }
  while (normalizedAngle > Math.PI / 4) normalizedAngle -= Math.PI / 2;
  while (normalizedAngle <= -Math.PI / 4) normalizedAngle += Math.PI / 2;
  return {
    centerX: offsetX + best.centerX,
    centerY: offsetY + best.centerY,
    orientedWidth,
    orientedHeight,
    angle: normalizedAngle
  };
}

function fillMaskHoles(mask, width, height) {
  const outside = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;
  const enqueue = (x, y) => {
    const index = y * width + x;
    if (mask[index] || outside[index]) return;
    outside[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(x - 1, y);
    if (x + 1 < width) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y + 1 < height) enqueue(x, y + 1);
  }

  const filled = new Float32Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    filled[index] = mask[index] || !outside[index] ? 1 : 0;
  }
  return filled;
}

function darkCoreComponent(region, foreground, imageWidth, imageHeight, closeRadius) {
  const blobMask = fillMaskHoles(region.mask, region.width, region.height);
  const values = [];
  let blobArea = 0;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      if (blobMask[y * region.width + x]) {
        values.push(foreground[(region.y + y) * imageWidth + region.x + x]);
        blobArea += 1;
      }
    }
  }
  const threshold = otsuThreshold(Float32Array.from(values));
  const core = new Float32Array(blobMask.length);
  let area = 0;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const index = y * region.width + x;
      if (blobMask[index] && foreground[(region.y + y) * imageWidth + region.x + x] > threshold) {
        core[index] = 1;
        area += 1;
      }
    }
  }
  if (!area) return null;

  const closed = morph(morph(core, region.width, region.height, closeRadius, true), region.width, region.height, closeRadius, false);
  const components = getComponents(closed, region.width, region.height, 1).sort((a, b) => b.area - a.area);
  const largest = components[0];
  if (!largest) return null;
  const filledMask = fillMaskHoles(largest.mask, largest.width, largest.height);
  let filledArea = 0;
  for (const value of filledMask) filledArea += value;
  if (filledArea < blobArea * 0.6) return null;
  return {
    x: largest.x,
    y: largest.y,
    width: largest.width,
    height: largest.height,
    mask: filledMask,
    area: filledArea
  };
}

function trimLeadsAndShadows(region, foreground, imageWidth, imageHeight) {
  const closeRadius = clamp(Math.floor(Math.min(imageWidth, imageHeight) / 100), 1, 4);
  const fillRatio = region.area / (region.width * region.height);
  const core = fillRatio < 0.9
    ? darkCoreComponent(region, foreground, imageWidth, imageHeight, closeRadius)
    : null;
  const source = core ?? {
    x: 0,
    y: 0,
    width: region.width,
    height: region.height,
    mask: region.mask,
    area: region.area
  };
  let body = source;

  if (source.area / (source.width * source.height) <= 0.75) {
    const radius = Math.max(1, Math.round(0.08 * Math.sqrt(source.area)));
    const opened = morph(
      morph(source.mask, source.width, source.height, radius, false),
      source.width,
      source.height,
      radius,
      true
    );
    const bodies = getComponents(opened, source.width, source.height, Math.max(20, Math.floor(source.area * 0.25)));
    const largest = bodies.sort((a, b) => b.area - a.area)[0];
    if (largest && largest.area >= source.area * 0.25) body = largest;
  }

  const x = region.x + source.x + (body === source ? 0 : body.x);
  const y = region.y + source.y + (body === source ? 0 : body.y);
  return {
    x,
    y,
    width: body.width,
    height: body.height,
    ...fitMaskOrientation(body.mask, body.width, body.height, x, y),
    area: body.area,
    contrast: region.contrast,
    mask: undefined
  };
}

function refineRegions(regions, width, height) {
  const refined = [];
  const fragments = [...regions].sort((a, b) => b.area - a.area);
  const mergeDistance = Math.max(12, Math.round(Math.min(width, height) * 0.055));

  for (const region of fragments) {
    const touchesEdge =
      region.x === 0 ||
      region.y === 0 ||
      region.x + region.width >= width ||
      region.y + region.height >= height;
    const larger = refined.find((candidate) => candidate.area >= region.area * 4);
    if (!larger) {
      refined.push(region);
      continue;
    }

    const gapX = Math.max(0, Math.max(larger.x - (region.x + region.width), region.x - (larger.x + larger.width)));
    const gapY = Math.max(0, Math.max(larger.y - (region.y + region.height), region.y - (larger.y + larger.height)));
    const intersectionWidth = Math.max(0, Math.min(larger.x + larger.width, region.x + region.width) - Math.max(larger.x, region.x));
    const intersectionHeight = Math.max(0, Math.min(larger.y + larger.height, region.y + region.height) - Math.max(larger.y, region.y));
    const overlap = (intersectionWidth * intersectionHeight) / (region.width * region.height);
    const closeFragment = gapX <= mergeDistance && gapY <= mergeDistance;

    if (touchesEdge && region.area < larger.area * 0.25) continue;
    if (!closeFragment && overlap < 0.25) {
      refined.push(region);
      continue;
    }
    if (region.area >= larger.area * 0.25) {
      refined.push(region);
      continue;
    }

    const left = Math.min(larger.x, region.x);
    const top = Math.min(larger.y, region.y);
    const right = Math.max(larger.x + larger.width, region.x + region.width);
    const bottom = Math.max(larger.y + larger.height, region.y + region.height);
    larger.x = left;
    larger.y = top;
    larger.width = right - left;
    larger.height = bottom - top;
    larger.area += region.area;
  }
  return refined;
}

export function detectComponentBounds(imageData, width, height) {
  if (!imageData || imageData.length !== width * height * 4 || width < 1 || height < 1) {
    throw new TypeError("Expected RGBA image data and positive dimensions.");
  }

  const darkestChannel = new Float32Array(width * height);
  for (let pixel = 0, offset = 0; pixel < darkestChannel.length; pixel += 1, offset += 4) {
    darkestChannel[pixel] = Math.min(imageData[offset], imageData[offset + 1], imageData[offset + 2]);
  }

  const filterRadius = Math.max(1, Math.floor(Math.max(width, height) / 6));
  const localWhite = boxBlur(
    separableFilter(darkestChannel, width, height, filterRadius, true),
    width,
    height,
    Math.max(1, Math.floor(filterRadius / 2))
  );
  const foreground = new Float32Array(darkestChannel.length);
  for (let i = 0; i < foreground.length; i += 1) {
    const background = Math.max(1, localWhite[i]);
    foreground[i] = Math.max(0, ((background - darkestChannel[i]) / background) * 255);
  }

  const threshold = Math.max(35, otsuThreshold(foreground));
  const mask = new Float32Array(foreground.length);
  for (let i = 0; i < mask.length; i += 1) mask[i] = foreground[i] > threshold ? 1 : 0;

  const closeRadius = clamp(Math.floor(Math.min(width, height) / 100), 1, 4);
  const closed = morph(morph(mask, width, height, closeRadius, true), width, height, closeRadius, false);
  const minimumArea = Math.max(36, Math.floor(width * height * 0.00012));
  const rawComponents = getComponents(closed, width, height, minimumArea, foreground);
  const largestComponent = [...rawComponents].sort((a, b) => b.area - a.area)[0];
  const mainContrast = largestComponent?.contrast ?? 0;
  const components = rawComponents
    .map((region) => trimLeadsAndShadows(region, foreground, width, height))
    .filter((region) => region.width <= width * 0.96 && region.height <= height * 0.96)
    .filter((region) => region.area >= (largestComponent?.area ?? 0) * 0.25 || region.contrast >= mainContrast * 0.82);
  const regions = refineRegions(components, width, height)
    .sort((a, b) => b.area - a.area)
    .slice(0, 40)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  return { regions, threshold };
}

export function normalizeMarking(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function cropAlignedComponent(source, region, workWidth, targetHeight = 360) {
  const scale = source.width / workWidth;
  const margin = 0.1 * Math.min(region.orientedWidth ?? region.width, region.orientedHeight ?? region.height);
  const width = Math.max(1, Math.round(((region.orientedWidth ?? region.width) + margin * 2) * scale));
  const height = Math.max(1, Math.round(((region.orientedHeight ?? region.height) + margin * 2) * scale));
  const centerX = (region.centerX ?? (region.x + region.width / 2)) * scale;
  const centerY = (region.centerY ?? (region.y + region.height / 2)) * scale;
  const aligned = document.createElement("canvas");
  aligned.width = width;
  aligned.height = height;
  const context = aligned.getContext("2d");
  if (!context) throw new Error("This browser could not align the component crop.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.translate(width / 2, height / 2);
  context.rotate(-(region.angle ?? 0));
  context.drawImage(source, -centerX, -centerY);

  const normalized = document.createElement("canvas");
  normalized.height = targetHeight;
  normalized.width = Math.max(1, Math.round((width / height) * normalized.height));
  const normalizedContext = normalized.getContext("2d");
  if (!normalizedContext) throw new Error("This browser could not resize the component crop.");
  normalizedContext.drawImage(aligned, 0, 0, normalized.width, normalized.height);
  return normalized;
}
