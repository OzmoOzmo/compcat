import {
  addAcceptedCandidates,
  deleteInventoryComponent,
  deleteSessionCandidate,
  duplicateSuggestions,
  filterInventory,
  listInventory,
  listSessionCandidates,
  openInventory,
  paginate,
  putSessionCandidate,
  suspectedBad,
  updateComponentDetails,
  downloadMarkdown,
  DEFAULT_PAGE_SIZE
} from "./inventory.js";
import { cropAlignedComponent, detectComponentBounds } from "./vision.js?v=2";
import { recognizeComponent } from "./ocr/browser-ocr.js?v=4";
import { requestGeminiDetails } from "./gemini.js?v=1";

const GEMINI_KEY_STORAGE = "component-identifier.gemini-api-key";
const MAX_IMAGE_SIDE = 1100;

const byId = (id) => document.getElementById(id);
const state = {
  stream: null,
  candidates: [],
  inventory: [],
  candidateUrls: new Map(),
  historyPage: 1,
  historyPageSize: DEFAULT_PAGE_SIZE,
  detailRequests: new Set(),
  pendingDeleteId: null
};

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = `status-line${kind ? ` ${kind}` : ""}`;
}

function setNotice(element, message, kind = "") {
  element.replaceChildren();
  if (!message) return;
  const notice = document.createElement("div");
  notice.className = `notice${kind ? ` ${kind}` : ""}`;
  notice.textContent = message;
  element.append(notice);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function releaseUrls() {
  const activeIds = new Set(state.candidates.map((candidate) => candidate.id));
  for (const [id, entry] of state.candidateUrls) {
    if (activeIds.has(id)) continue;
    state.candidateUrls.delete(id);
    setTimeout(() => URL.revokeObjectURL(entry.url), 1000);
  }
}

function createPhotoUrl(candidate) {
  const existing = state.candidateUrls.get(candidate.id);
  if (existing?.blob === candidate.photo) return existing.url;
  if (existing) URL.revokeObjectURL(existing.url);
  const url = URL.createObjectURL(candidate.photo);
  state.candidateUrls.set(candidate.id, { blob: candidate.photo, url });
  return url;
}

function revokeAllPhotoUrls() {
  for (const entry of state.candidateUrls.values()) URL.revokeObjectURL(entry.url);
  state.candidateUrls.clear();
}

function normalizeTab(tabName) {
  const names = ["tools", "session", "history", "about", "config"];
  return names.includes(tabName) ? tabName : "tools";
}

function activateTab(tabName, options = {}) {
  const target = normalizeTab(tabName);
  if (target !== "tools" && state.stream) stopCamera();

  for (const name of ["tools", "session", "history", "about", "config"]) {
    const active = name === target;
    byId(`tab-${name}`).classList.toggle("active", active);
    byId(`tab-${name}`).setAttribute("aria-selected", String(active));
    byId(`${name}View`).hidden = !active;
  }
  if (options.updateHash !== false && location.hash !== `#${target}`) {
    history.replaceState(null, "", `#${target}`);
  }
  if (target === "session") renderSession();
  if (target === "history") renderHistory();
  if (target === "config") updateConfigState();
}

async function refreshData() {
  const [inventory, candidates] = await Promise.all([listInventory(), listSessionCandidates()]);
  state.inventory = inventory;
  state.candidates = candidates.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  renderSession();
  renderHistory();
}

function updateTabCounts() {
  const sessionCount = state.candidates.length;
  const historyCount = state.inventory.length;
  const sessionBadge = byId("sessionTabCount");
  sessionBadge.textContent = String(sessionCount);
  sessionBadge.hidden = sessionCount === 0;
  byId("sessionCount").textContent = `${sessionCount} ${sessionCount === 1 ? "scan" : "scans"}`;
  byId("sessionFooterCount").textContent = `${sessionCount} ${sessionCount === 1 ? "scan" : "scans"}`;
  byId("scannerSessionCount").textContent = String(sessionCount);

  const historyBadge = byId("historyTabCount");
  historyBadge.textContent = String(historyCount);
  historyBadge.hidden = historyCount === 0;
  byId("historyCount").textContent = `${historyCount} ${historyCount === 1 ? "component" : "components"}`;
  byId("historyExportButton").disabled = historyCount === 0;
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function formatDate(value, options = { month: "short", day: "numeric", year: "numeric" }) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, options);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : `${formatDate(value, { month: "short", day: "numeric" })} · ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function updateSessionDuplicateFlags() {
  const suggestions = duplicateSuggestions(state.candidates, state.inventory);
  const rows = byId("sessionTableBody").querySelectorAll("[data-candidate-id]");
  for (const row of rows) {
    const candidate = state.candidates.find((item) => item.id === row.dataset.candidateId);
    const duplicate = suggestions.get(row.dataset.candidateId);
    const bad = candidate && suspectedBad(candidate);
    row.classList.toggle("row-duplicate", Boolean(duplicate));
    row.classList.toggle("row-suspect", Boolean(bad));
    const status = row.querySelector(".row-status");
    status.replaceChildren();
    if (duplicate) status.append(createElement("span", "status-chip duplicate-chip", "Duplicate"));
    if (bad) status.append(createElement("span", "status-chip suspect-chip", "Check marking"));
    if (!duplicate && !bad) status.append(createElement("span", "status-chip review-chip", "Review"));
    row.title = [duplicate, bad ? "Marking is empty or OCR confidence is low." : ""].filter(Boolean).join(" ");
  }
}

function renderSession() {
  updateTabCounts();
  const body = byId("sessionTableBody");
  body.replaceChildren();
  releaseUrls();
  const suggestions = duplicateSuggestions(state.candidates, state.inventory);

  for (const candidate of state.candidates) {
    const row = document.createElement("tr");
    row.dataset.candidateId = candidate.id;
    const photoCell = document.createElement("td");
    const thumbnail = createElement("span", "session-thumbnail");
    if (candidate.photo) {
      const image = document.createElement("img");
      image.src = createPhotoUrl(candidate);
      image.alt = "";
      thumbnail.append(image);
    } else {
      thumbnail.textContent = "IC";
      thumbnail.setAttribute("aria-hidden", "true");
    }
    photoCell.append(thumbnail);

    const nameCell = document.createElement("td");
    const nameInput = createElement("input", "inline-name-input");
    nameInput.type = "text";
    nameInput.value = candidate.name || "";
    nameInput.placeholder = "Unidentified part";
    nameInput.setAttribute("aria-label", "Edit component name");
    nameInput.addEventListener("change", async () => {
      candidate.name = nameInput.value.trim();
      try {
        await putSessionCandidate(candidate);
        updateSessionDuplicateFlags();
      } catch (error) {
        setNotice(byId("sessionNotice"), `Could not save your edit: ${error.message}`, "error");
      }
    });
    nameCell.append(nameInput);

    const markingCell = document.createElement("td");
    const markingInput = createElement("input", "inline-marking-input");
    markingInput.type = "text";
    markingInput.value = candidate.marking || "";
    markingInput.placeholder = "No marking read";
    markingInput.setAttribute("aria-label", "Edit recognized marking");
    markingInput.addEventListener("change", async () => {
      candidate.marking = markingInput.value.trim();
      if (!candidate.name) {
        candidate.name = candidate.marking.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
      }
      try {
        await putSessionCandidate(candidate);
        renderSession();
      } catch (error) {
        setNotice(byId("sessionNotice"), `Could not save your edit: ${error.message}`, "error");
      }
    });
    markingCell.append(markingInput);
    const confidenceCell = document.createElement("td");
    const confidence = Math.round((candidate.confidence || 0) * 100);
    confidenceCell.append(createElement(
      "span",
      `confidence-chip${confidence >= 75 ? " confidence-good" : confidence < 55 ? " confidence-low" : ""}`,
      `${confidence}%`
    ));
    const capturedCell = createElement("td", "date-cell", formatTime(candidate.capturedAt));
    const statusCell = createElement("td", "row-status");
    const duplicate = suggestions.get(candidate.id);
    const bad = suspectedBad(candidate);
    row.classList.toggle("row-duplicate", Boolean(duplicate));
    row.classList.toggle("row-suspect", bad);
    if (duplicate) statusCell.append(createElement("span", "status-chip duplicate-chip", "Duplicate"));
    if (bad) statusCell.append(createElement("span", "status-chip suspect-chip", "Check marking"));
    if (!duplicate && !bad) statusCell.append(createElement("span", "status-chip review-chip", "Review"));

    const actionCell = document.createElement("td");
    const deleteButton = createElement("button", "row-delete-button", "Delete");
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `Delete session scan ${candidate.name || candidate.marking || ""}`);
    deleteButton.addEventListener("click", () => deleteSessionScan(candidate));
    actionCell.append(deleteButton);
    row.append(photoCell, nameCell, markingCell, confidenceCell, capturedCell, statusCell, actionCell);
    body.append(row);
  }

  const hasCandidates = state.candidates.length > 0;
  byId("sessionEmpty").hidden = hasCandidates;
  byId("archiveButton").disabled = !hasCandidates;
  byId("sessionSummary").textContent = hasCandidates
    ? `${hasCandidates ? state.candidates.length : 0} pending scan${state.candidates.length === 1 ? "" : "s"}`
    : "No scans yet";
  byId("sessionTableBody").closest(".table-scroll").hidden = !hasCandidates;
  byId("sessionSummary").closest(".table-toolbar").hidden = !hasCandidates;
  byId("sessionFooterCount").parentElement.hidden = !hasCandidates;
  if (!hasCandidates) setNotice(byId("sessionNotice"), "");
}

function renderHistory() {
  updateTabCounts();
  const body = byId("historyTableBody");
  body.replaceChildren();
  const filtered = filterInventory(state.inventory, byId("historySearch").value);
  const page = paginate(filtered, state.historyPage, state.historyPageSize);
  state.historyPage = page.page;

  for (const component of page.items) {
    const row = document.createElement("tr");
    const partCell = document.createElement("td");
    partCell.append(createElement("span", "history-part-name", component.name || "Unidentified component"));
    const marking = component.items.map((item) => item.marking).find(Boolean);
    if (marking && marking !== component.name) partCell.append(createElement("span", "history-marking", marking));

    const descriptionCell = document.createElement("td");
    descriptionCell.append(createElement("span", "history-description", component.description || "No description yet"));
    if (component.manufacturer) descriptionCell.append(createElement("span", "history-manufacturer", component.manufacturer));

    const countCell = document.createElement("td");
    countCell.append(createElement("span", "item-count-chip", String(component.itemCount)));
    const latestCell = createElement("td", "date-cell", formatDate(component.items[0]?.capturedAt));

    const actionCell = createElement("td", "history-actions-cell");
    const details = createElement("button", "row-icon-button", "Details");
    details.type = "button";
    details.setAttribute("aria-label", `Ask Gemini for details about ${component.name}`);
    details.addEventListener("click", () => requestComponentDetails(component));
    actionCell.append(details);
    if (component.datasheetUrl && isHttpUrl(component.datasheetUrl)) {
      const datasheet = createElement("a", "row-icon-button", "Datasheet");
      datasheet.href = component.datasheetUrl;
      datasheet.target = "_blank";
      datasheet.rel = "noopener noreferrer";
      actionCell.append(datasheet);
    }
    const remove = createElement("button", "row-delete-button", "Delete");
    remove.type = "button";
    remove.addEventListener("click", () => confirmHistoryDelete(component));
    actionCell.append(remove);
    row.append(partCell, descriptionCell, countCell, latestCell, actionCell);
    body.append(row);
  }

  const query = byId("historySearch").value.trim();
  byId("historyEmpty").hidden = state.inventory.length > 0 && filtered.length > 0;
  byId("historyEmpty").classList.toggle("search-empty", state.inventory.length > 0 && filtered.length === 0);
  byId("historyTableBody").closest(".table-scroll").hidden = page.total === 0;
  byId("historySummary").closest(".table-toolbar").hidden = page.total === 0;
  byId("historySummary").textContent = query
    ? `${page.total} result${page.total === 1 ? "" : "s"} for “${query}”`
    : `${page.total} component${page.total === 1 ? "" : "s"} in your history`;
  byId("historyRange").textContent = `${page.total ? page.start + 1 : 0}–${page.end} of ${page.total} components`;
  byId("pageIndicator").textContent = `Page ${page.page} of ${page.pageCount}`;
  byId("previousPageButton").disabled = page.page <= 1;
  byId("nextPageButton").disabled = page.page >= page.pageCount;
  byId("historyEmpty").querySelector("h3").textContent =
    state.inventory.length > 0 && query ? "No matching components" : "Your history starts here";
  byId("historyEmpty").querySelector("p").textContent =
    state.inventory.length > 0 && query
      ? "Try another search term. Search matches any part of a component record."
      : "Capture components and archive them from Session to build your inventory.";
  byId("historyEmpty").querySelector("[data-open-scanner]").hidden = state.inventory.length > 0;
}

function showDetails(component) {
  byId("detailsTitle").textContent = component.name;
  const content = byId("detailsContent");
  content.replaceChildren();
  if (component.manufacturer) appendDetail(content, "Manufacturer", component.manufacturer);
  if (component.description) appendDetail(content, "Description", component.description);
  if (component.pinout) appendDetail(content, "Pinout", component.pinout);
  if (component.datasheetUrl && isHttpUrl(component.datasheetUrl)) {
    const line = createElement("p", "");
    line.append(createElement("span", "detail-label", "Datasheet: "));
    const link = createElement("a", "", component.datasheetUrl);
    link.href = component.datasheetUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    line.append(link);
    content.append(line);
  }
  if (!content.childElementCount) content.append(createElement("p", "", "No details have been saved yet."));
  content.append(createElement("p", "muted", "AI-generated details can be wrong. Check important information against the manufacturer datasheet."));
  if (!byId("detailsDialog").open) byId("detailsDialog").showModal();
}

function appendDetail(parent, label, value) {
  const paragraph = createElement("p", "");
  paragraph.append(createElement("span", "detail-label", `${label}: `), document.createTextNode(value));
  parent.append(paragraph);
}

async function requestComponentDetails(component) {
  if (state.detailRequests.has(component.id)) return;
  let key;
  try {
    key = localStorage.getItem(GEMINI_KEY_STORAGE);
  } catch (error) {
    byId("detailsTitle").textContent = component.name;
    byId("detailsContent").replaceChildren(createElement("p", "status-line error", `Browser storage is unavailable: ${error.message || "cannot read saved key"}.`));
    if (!byId("detailsDialog").open) byId("detailsDialog").showModal();
    return;
  }
  if (!key) {
    activateTab("config");
    byId("keyStatus").textContent = "Add a Gemini API key to request component details.";
    byId("geminiKeyInput").focus();
    return;
  }

  byId("detailsTitle").textContent = component.name;
  byId("detailsContent").replaceChildren(createElement("p", "", "Asking Gemini for part details…"));
  byId("detailsDialog").showModal();
  const prompt = [
    "Identify this electronic component from the package marking below.",
    `Marking or current name: ${component.name}`,
    component.description ? `Existing description: ${component.description}` : "",
    "Return concise JSON fields: manufacturer, description, datasheetUrl, and pinout.",
    "If the marking is ambiguous, say so in the description. Do not invent a datasheet URL or pinout; use an empty string when unsure.",
    "A datasheetUrl must be an official manufacturer datasheet URL when known."
  ].filter(Boolean).join("\n");

  state.detailRequests.add(component.id);
  try {
    const details = await requestGeminiDetails(prompt, key);
    await updateComponentDetails(component.id, {
      manufacturer: String(details.manufacturer ?? ""),
      description: String(details.description ?? ""),
      datasheetUrl: isHttpUrl(details.datasheetUrl) ? details.datasheetUrl : "",
      pinout: String(details.pinout ?? "")
    });
    await refreshData();
    const updated = state.inventory.find((item) => item.id === component.id);
    if (updated) showDetails(updated);
  } catch (error) {
    byId("detailsContent").replaceChildren(createElement("p", "status-line error", error.message || "Could not retrieve Gemini details."));
  } finally {
    state.detailRequests.delete(component.id);
  }
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not prepare this photo."));
    }, "image/jpeg", 0.9);
  });
}

function prepareWorkCanvas(bitmap) {
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser could not prepare the photo for recognition.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function processPhoto(blob, label) {
  if (!(blob instanceof Blob) || !blob.type.startsWith("image/")) throw new Error("Choose a supported image file.");
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = prepareWorkCanvas(bitmap);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const { regions } = detectComponentBounds(imageData.data, canvas.width, canvas.height);
    if (regions.length === 0) {
      setStatus(byId("captureStatus"), `No separate component was found in ${label}. Try a plain, contrasting background.`);
      return 0;
    }

    let added = 0;
    for (let index = 0; index < regions.length; index += 1) {
      const crop = cropAlignedComponent(bitmap, regions[index], canvas.width);
      setStatus(byId("captureStatus"), `Reading component ${index + 1} of ${regions.length} in ${label} with on-device OCR…`);
      const recognition = await recognizeComponent(crop);
      const marking = recognition.text.trim();
      const firstLine = marking.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
      const candidate = {
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: firstLine,
        marking,
        confidence: recognition.confidence,
        photo: await canvasToBlob(crop),
        capturedAt: new Date().toISOString()
      };
      await putSessionCandidate(candidate);
      state.candidates.push(candidate);
      added += 1;
      renderSession();
    }
    return added;
  } finally {
    bitmap.close();
  }
}

async function processPhotoBatch(files) {
  if (state.processing) return;
  state.processing = true;
  byId("captureNowButton").disabled = true;
  byId("scannerChoosePhotosButton").disabled = true;
  byId("progressTrack").hidden = false;
  byId("progressBar").value = 8;
  let totalAdded = 0;
  let failures = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      byId("progressBar").value = Math.max(8, Math.round(((index + 1) / files.length) * 100));
      try {
        totalAdded += await processPhoto(files[index], `photo ${index + 1} of ${files.length}`);
      } catch (error) {
        failures += 1;
        setStatus(byId("captureStatus"), `Could not process photo ${index + 1}: ${error.message || "Unexpected recognition error."}`, "error");
      }
    }
    if (totalAdded > 0) {
      setStatus(byId("captureStatus"), `${totalAdded} component ${totalAdded === 1 ? "scan" : "scans"} added to Session.`, failures ? "" : "success");
      stopCamera();
      activateTab("session");
    } else if (failures === 0) {
      setStatus(byId("captureStatus"), "No component candidates found. Try a clearer photo with parts spaced apart.");
    }
  } finally {
    state.processing = false;
    byId("captureNowButton").disabled = !state.stream;
    byId("scannerChoosePhotosButton").disabled = false;
    byId("progressTrack").hidden = true;
    renderSession();
  }
}

function showScanner() {
  activateTab("tools");
  byId("toolsLanding").hidden = true;
  byId("scannerPanel").hidden = false;
  if (state.stream) return;
  startCamera();
}

function closeScanner() {
  stopCamera();
  byId("scannerPanel").hidden = true;
  byId("toolsLanding").hidden = false;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    byId("cameraPlaceholder").hidden = false;
    setStatus(byId("captureStatus"), "Live camera access is not available here. Choose a photo instead.", "error");
    return;
  }
  stopCamera();
  setStatus(byId("captureStatus"), "Waiting for camera permission…");
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    byId("cameraPreview").srcObject = state.stream;
    await byId("cameraPreview").play();
    byId("cameraPreview").hidden = false;
    byId("cameraPlaceholder").hidden = true;
    byId("captureNowButton").disabled = false;
    setStatus(byId("captureStatus"), "Camera ready. Capture to process a photo and add results to Session.");
  } catch (error) {
    if (state.stream) for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
    byId("cameraPreview").srcObject = null;
    byId("cameraPreview").hidden = true;
    byId("cameraPlaceholder").hidden = false;
    const reason = error.name === "NotAllowedError"
      ? "Camera permission was not granted. Allow camera access or choose a photo."
      : error.name === "NotFoundError"
        ? "No camera was found. Choose a photo instead."
        : error.message || "Could not start the camera.";
    setStatus(byId("captureStatus"), reason, "error");
  }
}

function stopCamera() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  const video = byId("cameraPreview");
  if (video) {
    video.srcObject = null;
    video.hidden = true;
  }
  const placeholder = byId("cameraPlaceholder");
  if (placeholder) placeholder.hidden = false;
  const capture = byId("captureNowButton");
  if (capture) capture.disabled = true;
}

async function captureCurrentFrame() {
  const video = byId("cameraPreview");
  if (!state.stream || !video.videoWidth || state.processing) return;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    setStatus(byId("captureStatus"), "This browser could not capture the camera frame.", "error");
    return;
  }
  context.drawImage(video, 0, 0);
  try {
    await processPhotoBatch([await canvasToBlob(canvas)]);
  } catch (error) {
    setStatus(byId("captureStatus"), error.message || "Could not capture this photo.", "error");
  }
}

async function processPickedFiles(event) {
  const files = [...event.target.files];
  event.target.value = "";
  if (files.length === 0) return;
  activateTab("tools");
  byId("toolsLanding").hidden = true;
  byId("scannerPanel").hidden = false;
  if (state.stream) stopCamera();
  await processPhotoBatch(files);
}

async function deleteSessionScan(candidate) {
  if (!window.confirm(`Delete this session scan${candidate.name ? ` for ${candidate.name}` : ""}? It will not be archived.`)) return;
  try {
    await deleteSessionCandidate(candidate.id);
    state.candidates = state.candidates.filter((item) => item.id !== candidate.id);
    renderSession();
  } catch (error) {
    setNotice(byId("sessionNotice"), error.message || "Could not delete the session scan.", "error");
  }
}

async function archiveSession() {
  if (state.candidates.length === 0) return;
  const count = state.candidates.length;
  byId("archiveButton").disabled = true;
  try {
    await addAcceptedCandidates(state.candidates);
    state.candidates = [];
    await refreshData();
    setNotice(byId("historyNotice"), `${count} scan${count === 1 ? "" : "s"} archived to History.`, "success");
    activateTab("history");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    setNotice(byId("sessionNotice"), `Could not archive this session: ${error.message || "storage error"}. Your scans remain in Session.`, "error");
    byId("archiveButton").disabled = false;
  }
}

function confirmHistoryDelete(component) {
  state.pendingDeleteId = component.id;
  const count = component.itemCount;
  byId("deleteMessage").textContent =
    `This permanently removes ${component.name} and ${count} archived ${count === 1 ? "capture" : "captures"} from this device.`;
  byId("deleteDialog").showModal();
}

async function deleteHistoryComponent() {
  const id = state.pendingDeleteId;
  if (id === null) return;
  byId("confirmDeleteButton").disabled = true;
  try {
    await deleteInventoryComponent(id);
    state.pendingDeleteId = null;
    byId("deleteDialog").close();
    await refreshData();
    setNotice(byId("historyNotice"), "Component and archived captures deleted.", "success");
  } catch (error) {
    setNotice(byId("historyNotice"), error.message || "Could not delete the component.", "error");
  } finally {
    byId("confirmDeleteButton").disabled = false;
  }
}

function updateConfigState() {
  let saved = false;
  try {
    saved = Boolean(localStorage.getItem(GEMINI_KEY_STORAGE));
  } catch (error) {
    setStatus(byId("keyStatus"), `Browser storage is unavailable: ${error.message || "cannot read settings"}.`, "error");
  }
  byId("keySavedBadge").hidden = !saved;
  byId("removeKeyButton").disabled = !saved;
}

function saveGeminiKey(event) {
  event.preventDefault();
  const key = byId("geminiKeyInput").value.trim();
  if (!key) {
    setStatus(byId("keyStatus"), "Enter a Gemini API key before saving.", "error");
    return;
  }
  try {
    localStorage.setItem(GEMINI_KEY_STORAGE, key);
    byId("geminiKeyInput").value = "";
    byId("geminiKeyInput").placeholder = "Key saved on this device";
    setStatus(byId("keyStatus"), "Gemini API key saved in this browser.", "success");
    updateConfigState();
  } catch (error) {
    setStatus(byId("keyStatus"), `Could not save the key: ${error.message || "browser storage unavailable"}.`, "error");
  }
}

function removeGeminiKey() {
  try {
    localStorage.removeItem(GEMINI_KEY_STORAGE);
    byId("geminiKeyInput").value = "";
    byId("geminiKeyInput").placeholder = "Paste your Gemini API key";
    setStatus(byId("keyStatus"), "Saved Gemini API key removed from this browser.", "success");
    updateConfigState();
  } catch (error) {
    setStatus(byId("keyStatus"), `Could not remove the key: ${error.message || "browser storage unavailable"}.`, "error");
  }
}

function closeDialog(id) {
  const dialog = byId(id);
  if (dialog.open) dialog.close();
}

function attachEvents() {
  for (const button of document.querySelectorAll(".tab-button[role='tab']")) {
    button.addEventListener("click", () => activateTab(button.id.replace("tab-", "")));
  }
  byId("openScannerButton").addEventListener("click", showScanner);
  byId("enableCameraButton").addEventListener("click", startCamera);
  byId("closeScannerButton").addEventListener("click", closeScanner);
  byId("captureNowButton").addEventListener("click", captureCurrentFrame);
  byId("scannerChoosePhotosButton").addEventListener("click", () => byId("scannerFileInput").click());
  byId("choosePhotosButton").addEventListener("click", () => byId("photoFileInput").click());
  byId("photoFileInput").addEventListener("change", processPickedFiles);
  byId("scannerFileInput").addEventListener("change", processPickedFiles);
  byId("openSessionButton").addEventListener("click", () => activateTab("session"));
  byId("sessionScanButton").addEventListener("click", showScanner);
  byId("archiveButton").addEventListener("click", archiveSession);
  byId("historySearch").addEventListener("input", () => {
    state.historyPage = 1;
    renderHistory();
  });
  byId("pageSizeSelect").addEventListener("change", () => {
    state.historyPageSize = Number(byId("pageSizeSelect").value) || DEFAULT_PAGE_SIZE;
    state.historyPage = 1;
    renderHistory();
  });
  byId("previousPageButton").addEventListener("click", () => {
    state.historyPage -= 1;
    renderHistory();
  });
  byId("nextPageButton").addEventListener("click", () => {
    state.historyPage += 1;
    renderHistory();
  });
  byId("historyExportButton").addEventListener("click", () => {
    try {
      downloadMarkdown(state.inventory);
    } catch (error) {
      setNotice(byId("historyNotice"), `Could not export Markdown: ${error.message || "download failed"}.`, "error");
    }
  });
  byId("keyForm").addEventListener("submit", saveGeminiKey);
  byId("removeKeyButton").addEventListener("click", removeGeminiKey);
  byId("toggleKeyVisibility").addEventListener("click", () => {
    const input = byId("geminiKeyInput");
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    byId("toggleKeyVisibility").textContent = visible ? "Hide" : "Show";
  });
  byId("confirmDeleteButton").addEventListener("click", deleteHistoryComponent);
  for (const button of document.querySelectorAll("[data-close-dialog]")) {
    button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
  }
  for (const button of document.querySelectorAll("[data-open-scanner]")) {
    button.addEventListener("click", showScanner);
  }
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      activateTab("history");
      byId("historySearch").focus();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.stream) {
      stopCamera();
      setStatus(byId("captureStatus"), "Camera paused while this page is in the background. Enable it again when you return.");
    }
  });
  window.addEventListener("pagehide", () => {
    stopCamera();
    revokeAllPhotoUrls();
  });
}

async function initialize() {
  attachEvents();
  updateConfigState();
  try {
    await openInventory();
    await refreshData();
    activateTab("tools", { updateHash: false });
  } catch (error) {
    setNotice(byId("sessionNotice"), `Local inventory is unavailable: ${error.message || "storage could not be opened"}.`, "error");
    activateTab("tools", { updateHash: false });
  }
}

initialize();
