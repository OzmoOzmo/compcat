import { normalizeMarking } from "./vision.js";

const DATABASE_NAME = "component-identifier";
const DATABASE_VERSION = 2;
export const DEFAULT_PAGE_SIZE = 50;
let databasePromise;

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function openInventory() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) return Promise.reject(new Error("This browser does not support local inventory storage."));

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("components")) {
        database.createObjectStore("components", { keyPath: "id", autoIncrement: true });
      }
      if (!database.objectStoreNames.contains("items")) {
        const items = database.createObjectStore("items", { keyPath: "id", autoIncrement: true });
        items.createIndex("componentId", "componentId", { unique: false });
        items.createIndex("capturedAt", "capturedAt", { unique: false });
      }
      if (!database.objectStoreNames.contains("sessionCandidates")) {
        database.createObjectStore("sessionCandidates", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error("Could not open the local inventory."));
    };
  });
  return databasePromise;
}

export async function listInventory() {
  const database = await openInventory();
  const transaction = database.transaction(["components", "items"], "readonly");
  const [components, items] = await Promise.all([
    requestPromise(transaction.objectStore("components").getAll()),
    requestPromise(transaction.objectStore("items").getAll())
  ]);
  const itemsByComponent = new Map();
  for (const item of items) {
    const group = itemsByComponent.get(item.componentId) ?? [];
    group.push(item);
    itemsByComponent.set(item.componentId, group);
  }

  return components
    .map((component) => ({
      ...component,
      items: (itemsByComponent.get(component.id) ?? []).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
      itemCount: (itemsByComponent.get(component.id) ?? []).length
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export async function addAcceptedCandidates(candidatesToSave) {
  const database = await openInventory();
  const transaction = database.transaction(["components", "items", "sessionCandidates"], "readwrite");
  const components = transaction.objectStore("components");
  const items = transaction.objectStore("items");
  const sessionCandidates = transaction.objectStore("sessionCandidates");
  const componentRequest = components.getAll();

  return new Promise((resolve, reject) => {
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not save this component."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save this component."));
    componentRequest.onerror = () => transaction.abort();
    componentRequest.onsuccess = () => {
      const componentIds = new Map(
        componentRequest.result
          .filter((component) => component.normalizedName)
          .map((component) => [component.normalizedName, component.id])
      );
      let candidateIndex = 0;

      const saveNext = () => {
        if (candidateIndex >= candidatesToSave.length) return;
        const candidate = candidatesToSave[candidateIndex];
        candidateIndex += 1;
        const normalizedName = normalizeMarking(candidate.name || candidate.marking);
        const existingId = normalizedName ? componentIds.get(normalizedName) : undefined;
        if (existingId !== undefined) {
          saveItem(candidate, existingId, saveNext);
          return;
        }

        const component = {
          name: String(candidate.name || candidate.marking || "Unidentified component").trim(),
          normalizedName,
          description: "",
          manufacturer: "",
          datasheetUrl: "",
          pinout: "",
          createdAt: candidate.capturedAt ?? new Date().toISOString()
        };
        const addRequest = components.add(component);
        addRequest.onerror = () => transaction.abort();
        addRequest.onsuccess = () => {
          const componentId = addRequest.result;
          if (normalizedName) componentIds.set(normalizedName, componentId);
          saveItem(candidate, componentId, saveNext);
        };
      };

      saveNext();
    };

    transaction.oncomplete = () => resolve();

    function saveItem(candidate, componentId, next) {
      const itemRequest = items.add({
        componentId,
        marking: candidate.marking || "",
        confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : 0,
        capturedAt: candidate.capturedAt ?? new Date().toISOString(),
        photo: candidate.photo ?? null
      });
      itemRequest.onerror = () => transaction.abort();
      itemRequest.onsuccess = () => {
        sessionCandidates.delete(candidate.id);
        next();
      };
    }
  });
}

export async function listSessionCandidates() {
  const database = await openInventory();
  const transaction = database.transaction("sessionCandidates", "readonly");
  return requestPromise(transaction.objectStore("sessionCandidates").getAll());
}

export async function putSessionCandidate(candidate) {
  const database = await openInventory();
  const transaction = database.transaction("sessionCandidates", "readwrite");
  const request = transaction.objectStore("sessionCandidates").put(candidate);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not save this session scan."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save this session scan."));
    request.onerror = () => transaction.abort();
  });
}

export async function deleteSessionCandidate(id) {
  const database = await openInventory();
  const transaction = database.transaction("sessionCandidates", "readwrite");
  transaction.objectStore("sessionCandidates").delete(id);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not delete this session scan."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete this session scan."));
  });
}

export async function clearSessionCandidates() {
  const database = await openInventory();
  const transaction = database.transaction("sessionCandidates", "readwrite");
  transaction.objectStore("sessionCandidates").clear();
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not clear the archived session."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear the archived session."));
  });
}

export async function updateComponentDetails(id, details) {
  const database = await openInventory();
  const transaction = database.transaction("components", "readwrite");
  const store = transaction.objectStore("components");
  const request = store.get(id);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not update component details."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not update component details."));
    request.onerror = () => transaction.abort();
    request.onsuccess = () => {
      if (!request.result) {
        transaction.abort();
        return;
      }
      store.put({ ...request.result, ...details, id });
    };
  });
}

export async function deleteInventoryComponent(id) {
  const database = await openInventory();
  const transaction = database.transaction(["components", "items"], "readwrite");
  const components = transaction.objectStore("components");
  const items = transaction.objectStore("items");
  const request = items.index("componentId").openKeyCursor(IDBKeyRange.only(id));
  components.delete(id);

  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not delete the archived component."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete the archived component."));
    request.onerror = () => transaction.abort();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      items.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}

export function duplicateSuggestions(candidates, inventory) {
  const inventoryKeys = new Set(inventory.map((component) => component.normalizedName).filter(Boolean));
  const keyCounts = new Map();
  for (const candidate of candidates) {
    const key = normalizeMarking(candidate.name || candidate.marking);
    if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const suggestions = new Map();

  for (const candidate of candidates) {
    const key = normalizeMarking(candidate.name || candidate.marking);
    if (!key) continue;
    if (inventoryKeys.has(key)) {
      suggestions.set(candidate.id, "Similar marking is already in your inventory.");
    } else if (keyCounts.get(key) > 1) {
      suggestions.set(candidate.id, "Similar marking appears more than once in this capture session.");
    }
  }
  return suggestions;
}

export function suspectedBad(candidate) {
  const marking = String(candidate.marking ?? "").replace(/\s/g, "");
  return marking.length < 3 || !Number.isFinite(candidate.confidence) || candidate.confidence < 0.55;
}

export function filterInventory(components, query) {
  const normalizedQuery = String(query ?? "").trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...components];
  return components.filter((component) => {
    const values = [
      component.name,
      component.description,
      component.manufacturer,
      component.pinout,
      component.datasheetUrl,
      ...((component.items ?? []).map((item) => item.marking))
    ];
    return values.some((value) => String(value ?? "").toLocaleLowerCase().includes(normalizedQuery));
  });
}

export function paginate(items, page, pageSize) {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const safePage = Math.min(pageCount, Math.max(1, Math.floor(page)));
  const start = (safePage - 1) * safePageSize;
  return {
    page: safePage,
    pageSize: safePageSize,
    pageCount,
    total: items.length,
    start,
    end: Math.min(start + safePageSize, items.length),
    items: items.slice(start, start + safePageSize)
  };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

export function buildMarkdown(components) {
  const sorted = [...components].sort((a, b) => Number(a.id) - Number(b.id));
  const count = sorted.length;
  const plural = count === 1 ? "" : "s";
  const rows = sorted.map((component) =>
    `| ${component.id} | ${markdownCell(component.name)} | ${markdownCell(component.description)} | ${component.itemCount ?? 0} |`
  );
  return [
    "# Components",
    "",
    `${count} component${plural}.`,
    "",
    "| ID | Name | Description | Items |",
    "|---:|---|---|---:|",
    ...rows,
    ""
  ].join("\n");
}

export function downloadMarkdown(components) {
  const blob = new Blob([buildMarkdown(components)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "components.md";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
