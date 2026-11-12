const DIGITS = new Map([
  ["black", 0],
  ["brown", 1],
  ["red", 2],
  ["orange", 3],
  ["yellow", 4],
  ["green", 5],
  ["blue", 6],
  ["violet", 7],
  ["gray", 8],
  ["white", 9]
]);

const TOLERANCES = new Map([
  ["brown", 1],
  ["red", 2],
  ["green", 0.5],
  ["blue", 0.25],
  ["violet", 0.1],
  ["gray", 0.05],
  ["gold", 5],
  ["silver", 10]
]);

export function decodeResistorBands(bands) {
  if (!Array.isArray(bands) || ![4, 5].includes(bands.length)) {
    throw new TypeError("Provide four or five resistor bands, ordered from the digit end to tolerance.");
  }

  const colors = bands.map((color) => String(color).trim().toLowerCase());
  const digitCount = colors.length - 2;
  const digits = colors.slice(0, digitCount);
  if (digits.some((color) => !DIGITS.has(color))) {
    throw new RangeError("Significant-digit bands must use a resistor color from black to white.");
  }

  const multiplierColor = colors[digitCount];
  const multiplier = DIGITS.has(multiplierColor)
    ? 10 ** DIGITS.get(multiplierColor)
    : multiplierColor === "gold"
      ? 0.1
      : multiplierColor === "silver"
        ? 0.01
        : NaN;
  if (!Number.isFinite(multiplier)) throw new RangeError("The multiplier band color is not supported.");

  const toleranceColor = colors.at(-1);
  if (!TOLERANCES.has(toleranceColor)) throw new RangeError("The tolerance band color is not supported.");

  const significantValue = Number(digits.map((color) => DIGITS.get(color)).join(""));
  return {
    ohms: significantValue * multiplier,
    tolerancePercent: TOLERANCES.get(toleranceColor)
  };
}

export function formatResistorValue({ ohms, tolerancePercent }) {
  if (!Number.isFinite(ohms) || ohms <= 0 || !Number.isFinite(tolerancePercent)) {
    throw new TypeError("A positive resistance and finite tolerance are required.");
  }

  const [value, unit] = ohms >= 1_000_000
    ? [ohms / 1_000_000, "MΩ"]
    : ohms >= 1_000
      ? [ohms / 1_000, "kΩ"]
      : [ohms, "Ω"];
  const displayValue = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  return `${displayValue} ${unit} ±${tolerancePercent}%`;
}
