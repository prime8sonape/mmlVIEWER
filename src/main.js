import { IframeWrapper, MMLScene, registerCustomElementsToWindow } from "@mml-io/mml-web";
import { EditableNetworkedDOM, IframeObservableDOMFactory, MMLWebRunnerClient } from "@mml-io/mml-web-runner";
import { StandaloneThreeJSAdapter, StandaloneThreeJSAdapterControlsType } from "@mml-io/mml-web-threejs-standalone";

// ---- Config ----
const SOURCE_ROOT = "https://prime8s.s3.us-east-2.amazonaws.com/mml/";

// Controls how "studio" the lighting looks.
const LIGHT_PRESETS = {
  standard: {
    key: { x: 2.2, y: 4.0, z: 3.0, intensity: 90 },
    fill: { x: -3.0, y: 2.2, z: 2.0, intensity: 35 },
    rim: { x: 0.0, y: 3.2, z: -3.0, intensity: 55 },
    ambient: 0.35,
    groundOpacity: 0.25
  },
  studio: {
    key: { x: 2.4, y: 4.5, z: 2.6, intensity: 130 },
    fill: { x: -3.4, y: 2.6, z: 2.4, intensity: 55 },
    rim: { x: 0.0, y: 3.6, z: -3.6, intensity: 85 },
    ambient: 0.28,
    groundOpacity: 0.32
  },
  warm: {
    key: { x: 2.2, y: 4.0, z: 3.0, intensity: 105, color: "#ffd2a1" },
    fill: { x: -3.0, y: 2.2, z: 2.0, intensity: 35, color: "#fff1e5" },
    rim: { x: 0.0, y: 3.2, z: -3.0, intensity: 65, color: "#ffcc88" },
    ambient: 0.32,
    groundOpacity: 0.28
  },
  cool: {
    key: { x: 2.2, y: 4.0, z: 3.0, intensity: 95, color: "#b9d7ff" },
    fill: { x: -3.0, y: 2.2, z: 2.0, intensity: 35, color: "#dcecff" },
    rim: { x: 0.0, y: 3.2, z: -3.0, intensity: 60, color: "#9cc7ff" },
    ambient: 0.30,
    groundOpacity: 0.26
  }
};

// HDRI textbox is currently stored for future enhancement.
// We'll keep it in the UI so you can later swap in a real environment map pipeline.

// ---- UI State ----
let favorites = JSON.parse(localStorage.getItem("prime8s_favs_offset")) || [];
let lightingMode = "studio";
let intensity = 1.0;

// ---- DOM ----
const el = (id) => document.getElementById(id);
const idInput = el("idInput");
const lightSlider = el("lightSlider");
const lightValDisplay = el("lightValDisplay");
const envInput = el("envInput");
const viewerHost = el("viewerHost");
const loading = el("loading");
const err = el("err");
const errMsg = el("errMsg");

const favList = el("favList");

// ---- MML Runtime ----
let iframeWindow;
let iframeBody;
let networkedDOMDocument;
let mmlScene;
let client;
let graphicsAdapter;

function setStatusLoading(on, message = "Loading Prime8…") {
  loading.style.display = on ? "flex" : "none";
  const pill = loading.querySelector(".pill");
  if (pill) pill.textContent = message;
}

function setError(message) {
  err.style.display = "block";
  errMsg.textContent = message;
}

function clearError() {
  err.style.display = "none";
  errMsg.textContent = "";
}

function updateLightDisplay() {
  lightValDisplay.textContent = Number(lightSlider.value).toFixed(1);
}

function wrapWithLights(mmlContent) {
  const preset = LIGHT_PRESETS[lightingMode] || LIGHT_PRESETS.studio;
  const scale = Number(intensity);

  const mkLight = (id, cfg) => {
    const colorAttr = cfg.color ? ` color="${cfg.color}"` : "";
    // Use spotlight because it supports cast-shadow in MML and gives nicer falloff.
    return `
      <m-light id="${id}" type="spotlight" x="${cfg.x}" y="${cfg.y}" z="${cfg.z}" intensity="${(cfg.intensity * scale).toFixed(2)}" angle="55" cast-shadow="true"${colorAttr}></m-light>
    `;
  };

  // A subtle ground plane to catch shadows (nearly black so it doesn't look like a stage).
  // NOTE: m-plane is oriented vertically by default in some engines; we rotate it flat.
  const ground = `
    <m-plane id="ground" x="0" y="0" z="0" rx="-90" ry="0" rz="0" width="14" height="14" color="#050505"></m-plane>
  `;

  // Ambient is simulated via a low-intensity point light high above.
  const ambientPoint = `
    <m-light id="ambient" type="point" x="0" y="6" z="0" intensity="${(preset.ambient * 60 * scale).toFixed(2)}" distance="0" cast-shadow="false"></m-light>
  `;

  // Ensure we don't duplicate <html>/<body> wrappers if the MML file is a full HTML doc.
  const contentOnly = String(mmlContent || "").replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");

  return `
    ${mkLight("key", preset.key)}
    ${mkLight("fill", preset.fill)}
    ${mkLight("rim", preset.rim)}
    ${ambientPoint}
    ${ground}
    ${contentOnly}
  `;
}

async function initMMLOnce() {
  if (graphicsAdapter) return;

  // Create iframe sandbox for running scripts inside MML safely.
  const wrap = await IframeWrapper.create();
  iframeWindow = wrap.iframeWindow;
  iframeBody = wrap.iframeBody;

  // Register MML elements inside iframe.
  registerCustomElementsToWindow(iframeWindow);

  // Networked DOM document (acts as in-memory "server")
  networkedDOMDocument = new EditableNetworkedDOM("http://prime8.local/index.html", IframeObservableDOMFactory, true);

  // Rendering container
  viewerHost.innerHTML = "";
  viewerHost.style.background = "#0b0b0b";

  // MML scene and client
  mmlScene = new MMLScene(viewerHost);
  client = new MMLWebRunnerClient(iframeWindow, iframeBody, mmlScene);

  graphicsAdapter = await StandaloneThreeJSAdapter.create(viewerHost, {
    controlsType: StandaloneThreeJSAdapterControlsType.Orbit
  });

  mmlScene.init(graphicsAdapter);
  client.connect(networkedDOMDocument);
}

async function loadPrime8(displayId) {
  clearError();
  setStatusLoading(true, `Loading Prime8 #${displayId}…`);

  const fileId = Number(displayId) - 1;
  if (!Number.isFinite(fileId) || fileId < 0) {
    setStatusLoading(false);
    return;
  }

  try {
    await initMMLOnce();

    const url = `${SOURCE_ROOT}${fileId}.mml`;
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`Failed to fetch MML (${res.status})`);

    const mmlText = await res.text();
    const injected = wrapWithLights(mmlText);

    networkedDOMDocument.load(injected);

    renderFavorites();
    setStatusLoading(false);
  } catch (e) {
    console.error(e);
    setStatusLoading(false);
    setError(String(e?.message || e));
  }
}

function renderFavorites() {
  favList.innerHTML = "";
  favorites
    .slice()
    .sort((a, b) => Number(a) - Number(b))
    .forEach((id) => {
      const item = document.createElement("div");
      item.className = "fav-item";
      item.innerHTML = `<span>#${id}</span> <button title="Remove">×</button>`;
      item.onclick = () => {
        idInput.value = id;
        updateViewer();
      };
      item.querySelector("button").onclick = (ev) => {
        ev.stopPropagation();
        favorites = favorites.filter((f) => f !== id);
        localStorage.setItem("prime8s_favs_offset", JSON.stringify(favorites));
        renderFavorites();
      };
      favList.appendChild(item);
    });
}

function exportFavs() {
  const blob = new Blob([favorites.join("\n")], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "prime8s_favorites.txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function copyLink() {
  const id = Number(idInput.value);
  const params = new URLSearchParams({
    id: String(id),
    preset: lightingMode,
    intensity: String(Number(intensity).toFixed(1)),
    env: envInput.value || ""
  });
  const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  navigator.clipboard.writeText(url);
  alert("Link copied!");
}

function setLighting(mode, newIntensity) {
  lightingMode = mode;
  intensity = Number(newIntensity);
  lightSlider.value = String(intensity);
  updateLightDisplay();
  updateViewer();
}

function updateViewer() {
  intensity = Number(lightSlider.value);
  updateLightDisplay();
  loadPrime8(Number(idInput.value));
}

function changeID(delta) {
  let next = Number(idInput.value) + delta;
  if (next < 1) next = 1;
  if (next > 3333) next = 3333;
  idInput.value = String(next);
  updateViewer();
}

function randomID() {
  idInput.value = String(Math.floor(Math.random() * 3333) + 1);
  updateViewer();
}

function toggleFavorite() {
  const displayId = Number(idInput.value);
  if (!favorites.includes(displayId)) {
    favorites.push(displayId);
    localStorage.setItem("prime8s_favs_offset", JSON.stringify(favorites));
    renderFavorites();
  }
}

function toggleTheater() {
  document.body.classList.toggle("theater-mode");
}

function applyURLState() {
  const qs = new URLSearchParams(window.location.search);
  const id = Number(qs.get("id"));
  const preset = qs.get("preset");
  const inten = Number(qs.get("intensity"));
  const env = qs.get("env") || "";

  if (Number.isFinite(id) && id >= 1 && id <= 3333) idInput.value = String(id);
  if (preset && LIGHT_PRESETS[preset]) lightingMode = preset;
  if (Number.isFinite(inten) && inten >= 0.1 && inten <= 3.0) {
    intensity = inten;
    lightSlider.value = String(intensity);
  }
  envInput.value = env;
  updateLightDisplay();
}

// ---- Wire UI ----
window.addEventListener("DOMContentLoaded", () => {
  applyURLState();

  el("presetStandard").onclick = () => setLighting("standard", 1.0);
  el("presetWarm").onclick = () => setLighting("warm", 1.2);
  el("presetCool").onclick = () => setLighting("cool", 0.9);
  el("presetStudio").onclick = () => setLighting("studio", 1.6);

  idInput.onchange = updateViewer;
  lightSlider.oninput = updateLightDisplay;
  lightSlider.onchange = updateViewer;

  el("toggleTheater").onclick = toggleTheater;

  el("prevBtn").onclick = () => changeID(-1);
  el("nextBtn").onclick = () => changeID(1);
  el("randBtn").onclick = randomID;
  el("favBtn").onclick = toggleFavorite;
  el("copyBtn").onclick = copyLink;
  el("exportFavs").onclick = exportFavs;

  window.addEventListener("keydown", (e) => {
    if (e.target && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
    if (e.key === "ArrowRight") changeID(1);
    if (e.key === "ArrowLeft") changeID(-1);
    if (e.key.toLowerCase() === "r") randomID();
    if (e.key.toLowerCase() === "f") toggleFavorite();
    if (e.key.toLowerCase() === "t") toggleTheater();
  });

  renderFavorites();
  updateViewer();
});
