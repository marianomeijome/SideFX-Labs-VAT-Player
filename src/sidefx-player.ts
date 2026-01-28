/**
 * SideFX Labs VAT Player for Babylon.js
 *
 * Plays vertex animation textures exported from Houdini's SideFX Labs tools.
 * Uses a custom ShaderMaterial that samples vertex positions directly from
 * a texture, supporting soft-body, cloth, fluid, and destruction animations.
 */

import {
  AppendSceneAsync,
  ArcRotateCamera,
  Color3,
  Color4,
  Effect,
  Engine,
  HemisphericLight,
  Matrix,
  Mesh,
  Scene,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  VertexBuffer
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import "@babylonjs/inspector";

// ─────────────────────────────────────────────────────────────────────────────
// Shader code for SideFX Labs VAT (Soft mode)
// ─────────────────────────────────────────────────────────────────────────────

const VAT_VERTEX_SHADER = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec2 uv2;

// Thin instance attributes (rows of the world matrix)
#ifdef INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
attribute float instanceTimeOffset;
#endif

// Uniforms
uniform mat4 world;
uniform mat4 viewProjection;
uniform mat4 worldViewProjection;

uniform sampler2D positionTexture;
uniform sampler2D normalTexture;
uniform float vatTime;
uniform float numFrames;
uniform float fps;
uniform vec3 posMin;
uniform vec3 posMax;
uniform vec2 texSize;
uniform float useNormalTex;
uniform float isPacked;
uniform float debugMode;
uniform float flipV;
uniform float useOffset;

// Varyings
varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vPosition;
varying vec3 vDebugColor;

void main() {
    // Build instance world matrix if instancing is enabled
    #ifdef INSTANCES
    mat4 instanceWorld = mat4(world0, world1, world2, world3);
    float effectiveTime = vatTime + instanceTimeOffset;
    #else
    mat4 instanceWorld = world;
    float effectiveTime = vatTime;
    #endif

    // SideFX Labs "Soft" method with tiled texture layout:
    // - Texture has multiple rows per frame (when vertices > texture width)
    // - UV2 contains the base coordinate for frame 0
    // - To get frame N, add frameOffset to UV2.y
    
    // Calculate current frame (loop)
    float frame = floor(mod(effectiveTime * fps, numFrames));
    
    // Frame offset: each frame occupies (1.0 / numFrames) of the texture height
    float frameOffset = frame / numFrames;
    
    // UV2 is the coordinate within frame 0, add offset for current frame
    float finalU = uv2.x;
    float finalV = uv2.y + frameOffset;
    
    // Handle flipV if needed (some exports have frame 0 at bottom)
    if (flipV > 0.5) {
        finalV = 1.0 - finalV;
    }
    
    vec2 posUV = vec2(finalU, finalV);
    vec4 posSample = texture2D(positionTexture, posUV);

    // Decode position from texture
    vec3 texPos;
    if (isPacked > 0.5) {
        // Packed PNG: decode from 0-1 range using bounds
        // SideFX formula: pos = boundMin + (boundMax - boundMin) * textureValue
        texPos = posMin + (posMax - posMin) * posSample.xyz;
    } else {
        // Unpacked (HDR): use raw values directly
        texPos = posSample.xyz;
    }

    // Final position: either replace or add as offset
    vec3 animPos;
    if (useOffset > 0.5) {
        animPos = position + texPos;
    } else {
        animPos = texPos;
    }

    // Debug colors
    if (debugMode > 2.5) {
        vDebugColor = posSample.xyz;
    } else {
        vDebugColor = vec3(uv2.x, uv2.y * 10.0, frame / numFrames);
    }

    // Sample normal texture if available
    vec3 animNormal = normal;
    if (useNormalTex > 0.5) {
        vec4 normSample = texture2D(normalTexture, posUV);
        animNormal = normalize(normSample.xyz * 2.0 - 1.0);
    }

    vNormal = normalize((instanceWorld * vec4(animNormal, 0.0)).xyz);
    vUV = uv;
    vPosition = (instanceWorld * vec4(animPos, 1.0)).xyz;

    gl_Position = viewProjection * instanceWorld * vec4(animPos, 1.0);
}
`;

const VAT_FRAGMENT_SHADER = `
precision highp float;

varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vPosition;
varying vec3 vDebugColor;

uniform vec3 lightDirection;
uniform vec3 lightColor;
uniform vec3 ambientColor;
uniform vec3 diffuseColor;
uniform sampler2D diffuseTexture;
uniform float useDiffuseTex;
uniform float debugMode;

void main() {
    // Debug mode 1: show UV2 as color (vertex index visualization)
    if (debugMode > 0.5 && debugMode < 1.5) {
        gl_FragColor = vec4(vDebugColor, 1.0);
        return;
    }
    
    // Debug mode 2: show normals
    if (debugMode > 1.5 && debugMode < 2.5) {
        gl_FragColor = vec4(vNormal * 0.5 + 0.5, 1.0);
        return;
    }
    
    // Debug mode 3: show sampled texture color (raw)
    if (debugMode > 2.5) {
        gl_FragColor = vec4(vDebugColor, 1.0);
        return;
    }

    vec3 normal = normalize(vNormal);
    float NdotL = max(dot(normal, normalize(lightDirection)), 0.0);

    vec3 baseColor = diffuseColor;
    if (useDiffuseTex > 0.5) {
        baseColor *= texture2D(diffuseTexture, vUV).rgb;
    }

    vec3 color = ambientColor * baseColor + lightColor * baseColor * NdotL;
    gl_FragColor = vec4(color, 1.0);
}
`;

// Register shader
Effect.ShadersStore["sidefxVatVertexShader"] = VAT_VERTEX_SHADER;
Effect.ShadersStore["sidefxVatFragmentShader"] = VAT_FRAGMENT_SHADER;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface VatMetadata {
  numFrames: number;
  fps: number;
  posMin: [number, number, number];
  posMax: [number, number, number];
  normalMin?: [number, number, number];
  normalMax?: [number, number, number];
  method?: "soft" | "rigid" | "fluid";
  packed?: boolean;
  width?: number;
  height?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM Elements
// ─────────────────────────────────────────────────────────────────────────────

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const modelInput = document.getElementById("modelInput") as HTMLInputElement;
const posTexInput = document.getElementById("posTexInput") as HTMLInputElement;
const normalTexInput = document.getElementById("normalTexInput") as HTMLInputElement;
const metaInput = document.getElementById("metaInput") as HTMLInputElement;
const meshSelect = document.getElementById("meshSelect") as HTMLSelectElement;
const numFramesInput = document.getElementById("numFrames") as HTMLInputElement;
const fpsInput = document.getElementById("fps") as HTMLInputElement;
const speedInput = document.getElementById("speedInput") as HTMLInputElement;
const posMinX = document.getElementById("posMinX") as HTMLInputElement;
const posMinY = document.getElementById("posMinY") as HTMLInputElement;
const posMinZ = document.getElementById("posMinZ") as HTMLInputElement;
const posMaxX = document.getElementById("posMaxX") as HTMLInputElement;
const posMaxY = document.getElementById("posMaxY") as HTMLInputElement;
const posMaxZ = document.getElementById("posMaxZ") as HTMLInputElement;
const applyButton = document.getElementById("applyButton") as HTMLButtonElement;
const playButton = document.getElementById("playButton") as HTMLButtonElement;
const pauseButton = document.getElementById("pauseButton") as HTMLButtonElement;
const resetButton = document.getElementById("resetButton") as HTMLButtonElement;
const flipVCheckbox = document.getElementById("flipV") as HTMLInputElement;
const useOffsetCheckbox = document.getElementById("useOffset") as HTMLInputElement;
const debugModeSelect = document.getElementById("debugMode") as HTMLSelectElement;
const instancedModeCheckbox = document.getElementById("instancedMode") as HTMLInputElement;
const instanceCountInput = document.getElementById("instanceCount") as HTMLInputElement;
const instanceSpacingInput = document.getElementById("instanceSpacing") as HTMLInputElement;
const inspectorToggle = document.getElementById("inspectorToggle") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLPreElement;

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const engine = new Engine(canvas, true);
let scene = createScene(engine);

let positionTexture: Texture | null = null;
let normalTexture: Texture | null = null;
let vatMaterial: ShaderMaterial | null = null;
let vatMaterialInstanced: ShaderMaterial | null = null;
let originalMaterials = new Map<number, any>();
let vatTime = 0;
let isPlaying = false;
let isPacked = true; // Assume packed (PNG) unless EXR
let currentVatMesh: Mesh | null = null;
let isInstancedMode = false;
let isInspectorVisible = false;

// ─────────────────────────────────────────────────────────────────────────────
// Engine loop
// ─────────────────────────────────────────────────────────────────────────────

engine.runRenderLoop(() => {
  scene.render();
  if (isPlaying) {
    const speed = Number(speedInput.value) || 1;
    vatTime += (engine.getDeltaTime() / 1000) * speed;
    if (vatMaterial) {
      vatMaterial.setFloat("vatTime", vatTime);
    }
    if (vatMaterialInstanced) {
      vatMaterialInstanced.setFloat("vatTime", vatTime);
    }
  }
});

window.addEventListener("resize", () => engine.resize());

// ─────────────────────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────────────────────

modelInput.addEventListener("change", async () => {
  const file = modelInput.files?.[0];
  if (!file) return;

  resetState();
  setStatus("Loading mesh...");

  scene.dispose();
  scene = createScene(engine);

  try {
    await AppendSceneAsync(file, scene);
    populateMeshSelect();
    setStatus(`Loaded: ${file.name}`);
    updateButtons();
  } catch (err) {
    setStatus(`Failed to load mesh: ${err}`);
  }
});

posTexInput.addEventListener("change", async () => {
  const file = posTexInput.files?.[0];
  if (!file) return;

  setStatus("Loading position texture...");

  try {
    positionTexture?.dispose();
    positionTexture = await loadTextureFromFile(file, scene);

    // Detect if packed (PNG/JPG) or unpacked (EXR/TIFF)
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    isPacked = !["exr", "tiff", "tif", "hdr"].includes(ext);

    setStatus(`Position texture loaded: ${file.name} (${isPacked ? "packed" : "HDR"})`);
    updateButtons();
  } catch (err) {
    setStatus(`Failed to load position texture: ${err}`);
  }
});

normalTexInput.addEventListener("change", async () => {
  const file = normalTexInput.files?.[0];
  if (!file) return;

  try {
    normalTexture?.dispose();
    normalTexture = await loadTextureFromFile(file, scene);
    setStatus(`Normal texture loaded: ${file.name}`);
  } catch (err) {
    setStatus(`Failed to load normal texture: ${err}`);
  }
});

metaInput.addEventListener("change", async () => {
  const file = metaInput.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    let meta: Partial<VatMetadata>;

    // Check if it's a Unity material file (YAML) or JSON
    if (text.includes("%YAML") || text.includes("_boundMinX:") || text.includes("_frameCount:")) {
      meta = parseUnityMaterial(text);
      setStatus(`Unity material loaded: ${file.name}`);
    } else {
      meta = JSON.parse(text) as Partial<VatMetadata>;
      setStatus(`Metadata JSON loaded: ${file.name}`);
    }

    applyMetadata(meta);
  } catch (err) {
    setStatus(`Failed to parse metadata: ${err}`);
  }
});

applyButton.addEventListener("click", applyVat);
playButton.addEventListener("click", () => {
  isPlaying = true;
  setStatus("Playing...");
});
pauseButton.addEventListener("click", () => {
  isPlaying = false;
  setStatus("Paused.");
});
resetButton.addEventListener("click", () => {
  vatTime = 0;
  if (vatMaterial) vatMaterial.setFloat("vatTime", 0);
  if (vatMaterialInstanced) vatMaterialInstanced.setFloat("vatTime", 0);
  setStatus("Reset to frame 0.");
});

debugModeSelect.addEventListener("change", () => {
  if (vatMaterial) {
    vatMaterial.setFloat("debugMode", Number(debugModeSelect.value));
  }
  if (vatMaterialInstanced) {
    vatMaterialInstanced.setFloat("debugMode", Number(debugModeSelect.value));
  }
});

flipVCheckbox.addEventListener("change", () => {
  if (vatMaterial) {
    vatMaterial.setFloat("flipV", flipVCheckbox.checked ? 1.0 : 0.0);
  }
  if (vatMaterialInstanced) {
    vatMaterialInstanced.setFloat("flipV", flipVCheckbox.checked ? 1.0 : 0.0);
  }
});

useOffsetCheckbox.addEventListener("change", () => {
  if (vatMaterial) {
    vatMaterial.setFloat("useOffset", useOffsetCheckbox.checked ? 1.0 : 0.0);
  }
  if (vatMaterialInstanced) {
    vatMaterialInstanced.setFloat("useOffset", useOffsetCheckbox.checked ? 1.0 : 0.0);
  }
});

instancedModeCheckbox.addEventListener("change", () => {
  if (currentVatMesh) {
    applyInstancing(instancedModeCheckbox.checked);
  }
});

instanceCountInput.addEventListener("change", () => {
  if (currentVatMesh && instancedModeCheckbox.checked) {
    applyInstancing(true);
  }
});

instanceSpacingInput.addEventListener("change", () => {
  if (currentVatMesh && instancedModeCheckbox.checked) {
    applyInstancing(true);
  }
});

inspectorToggle.addEventListener("click", () => {
  if (isInspectorVisible) {
    scene.debugLayer.hide();
    inspectorToggle.textContent = "Show Inspector";
    isInspectorVisible = false;
  } else {
    scene.debugLayer.show({
      embedMode: true,
      overlay: true,
      showExplorer: true,
      showInspector: true
    });
    inspectorToggle.textContent = "Hide Inspector";
    isInspectorVisible = true;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Core functions
// ─────────────────────────────────────────────────────────────────────────────

function createScene(activeEngine: Engine): Scene {
  const newScene = new Scene(activeEngine);
  newScene.clearColor = new Color4(0.06, 0.08, 0.12, 1);

  const camera = new ArcRotateCamera(
    "camera",
    Math.PI / 2,
    Math.PI / 3,
    5,
    Vector3.Zero(),
    newScene
  );
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 50;
  camera.minZ = 0.01;

  const light = new HemisphericLight("light", new Vector3(0.3, 1, 0.2), newScene);
  light.intensity = 1.2;

  return newScene;
}

function resetState() {
  // Hide inspector before disposing scene
  if (isInspectorVisible) {
    scene.debugLayer.hide();
    isInspectorVisible = false;
    inspectorToggle.textContent = "Show Inspector";
  }
  
  vatMaterial?.dispose();
  vatMaterial = null;
  vatMaterialInstanced?.dispose();
  vatMaterialInstanced = null;
  positionTexture?.dispose();
  positionTexture = null;
  normalTexture?.dispose();
  normalTexture = null;
  originalMaterials.clear();
  vatTime = 0;
  isPlaying = false;
  currentVatMesh = null;
  isInstancedMode = false;
  instancedModeCheckbox.checked = false;
}

function populateMeshSelect() {
  meshSelect.innerHTML = "";
  const meshes = scene.meshes.filter(
    (m) => m instanceof Mesh && m.getTotalVertices() > 0
  ) as Mesh[];

  for (const mesh of meshes) {
    const option = document.createElement("option");
    option.value = String(mesh.uniqueId);
    option.textContent = mesh.name || `Mesh_${mesh.uniqueId}`;
    meshSelect.appendChild(option);
  }

  meshSelect.disabled = meshes.length === 0;
}

function updateButtons() {
  const hasMesh = !meshSelect.disabled;
  const hasPosTex = positionTexture !== null;
  const ready = hasMesh && hasPosTex;

  applyButton.disabled = !ready;
  playButton.disabled = !ready;
  pauseButton.disabled = !ready;
  resetButton.disabled = !ready;
}

function applyMetadata(meta: Partial<VatMetadata>) {
  if (meta.numFrames !== undefined) {
    numFramesInput.value = String(meta.numFrames);
  }
  if (meta.fps !== undefined) {
    fpsInput.value = String(meta.fps);
  }
  if (meta.posMin) {
    posMinX.value = String(meta.posMin[0]);
    posMinY.value = String(meta.posMin[1]);
    posMinZ.value = String(meta.posMin[2]);
  }
  if (meta.posMax) {
    posMaxX.value = String(meta.posMax[0]);
    posMaxY.value = String(meta.posMax[1]);
    posMaxZ.value = String(meta.posMax[2]);
  }
  if (meta.packed !== undefined) {
    isPacked = meta.packed;
  }
}

function applyVat() {
  if (!positionTexture) {
    setStatus("Load a position texture first.");
    return;
  }

  const meshId = Number(meshSelect.value);
  const mesh = scene.meshes.find((m) => m.uniqueId === meshId) as Mesh | undefined;
  if (!mesh) {
    setStatus("Select a mesh first.");
    return;
  }

  // Check if mesh has UV2 (required for vertex index lookup)
  if (!mesh.isVerticesDataPresent(VertexBuffer.UV2Kind)) {
    setStatus(
      "Mesh has no UV2 channel. SideFX Labs VAT requires UV2 for vertex indexing.\n" +
        "Re-export the mesh with UV2 from Houdini."
    );
    return;
  }

  try {
    // Stop any skeletal animations
    scene.stopAllAnimations();
    scene.animationGroups.forEach((g) => g.stop());
    if (mesh.skeleton) {
      mesh.skeleton.returnToRest();
    }

    // Store original material
    if (!originalMaterials.has(mesh.uniqueId)) {
      originalMaterials.set(mesh.uniqueId, mesh.material);
    }

    // Get diffuse texture from original material if available
    let diffuseTex: Texture | null = null;
    const origMat = originalMaterials.get(mesh.uniqueId);
    if (origMat && "diffuseTexture" in origMat) {
      diffuseTex = origMat.diffuseTexture;
    } else if (origMat && "albedoTexture" in origMat) {
      diffuseTex = origMat.albedoTexture;
    }

    // Create VAT shader material
    vatMaterial = new ShaderMaterial(
      "vatMaterial",
      scene,
      {
        vertex: "sidefxVat",
        fragment: "sidefxVat"
      },
      {
        attributes: ["position", "normal", "uv", "uv2"],
        uniforms: [
          "world",
          "viewProjection",
          "worldViewProjection",
          "positionTexture",
          "normalTexture",
          "vatTime",
          "numFrames",
          "fps",
          "posMin",
          "posMax",
          "texSize",
          "useNormalTex",
          "isPacked",
          "flipV",
          "useOffset",
          "debugMode",
          "lightDirection",
          "lightColor",
          "ambientColor",
          "diffuseColor",
          "diffuseTexture",
          "useDiffuseTex"
        ],
        samplers: ["positionTexture", "normalTexture", "diffuseTexture"]
      }
    );

    const numFrames = Number(numFramesInput.value) || 24;
    const fps = Number(fpsInput.value) || 24;
    const posMin = new Vector3(
      Number(posMinX.value),
      Number(posMinY.value),
      Number(posMinZ.value)
    );
    const posMax = new Vector3(
      Number(posMaxX.value),
      Number(posMaxY.value),
      Number(posMaxZ.value)
    );

    const texSize = positionTexture.getSize();

    vatMaterial.setTexture("positionTexture", positionTexture);
    vatMaterial.setFloat("vatTime", 0);
    vatMaterial.setFloat("numFrames", numFrames);
    vatMaterial.setFloat("fps", fps);
    vatMaterial.setVector3("posMin", posMin);
    vatMaterial.setVector3("posMax", posMax);
    vatMaterial.setVector2("texSize", new Vector2(texSize.width, texSize.height));
    vatMaterial.setFloat("isPacked", isPacked ? 1.0 : 0.0);
    vatMaterial.setFloat("flipV", flipVCheckbox.checked ? 1.0 : 0.0);
    vatMaterial.setFloat("useOffset", useOffsetCheckbox.checked ? 1.0 : 0.0);
    vatMaterial.setFloat("debugMode", Number(debugModeSelect.value));

    // Normal texture
    if (normalTexture) {
      vatMaterial.setTexture("normalTexture", normalTexture);
      vatMaterial.setFloat("useNormalTex", 1.0);
    } else {
      vatMaterial.setFloat("useNormalTex", 0.0);
    }

    // Lighting
    vatMaterial.setVector3("lightDirection", new Vector3(0.5, 1, 0.3));
    vatMaterial.setColor3("lightColor", new Color3(1, 1, 1));
    vatMaterial.setColor3("ambientColor", new Color3(0.15, 0.15, 0.18));
    vatMaterial.setColor3("diffuseColor", new Color3(0.9, 0.9, 0.9));

    // Diffuse texture
    if (diffuseTex) {
      vatMaterial.setTexture("diffuseTexture", diffuseTex);
      vatMaterial.setFloat("useDiffuseTex", 1.0);
    } else {
      vatMaterial.setFloat("useDiffuseTex", 0.0);
    }

    vatMaterial.backFaceCulling = false;

    mesh.material = vatMaterial;
    vatTime = 0;
    isPlaying = false;
    currentVatMesh = mesh;
    
    // Apply instancing if checkbox is already checked
    if (instancedModeCheckbox.checked) {
      applyInstancing(true);
    }

    // Log debug info
    const hasUV2 = mesh.isVerticesDataPresent(VertexBuffer.UV2Kind);
    const uv2Data = hasUV2 ? mesh.getVerticesData(VertexBuffer.UV2Kind) : null;
    const uv2Sample = uv2Data ? `[${uv2Data[0]?.toFixed(4)}, ${uv2Data[1]?.toFixed(4)}]` : "N/A";
    
    console.log("VAT Debug Info:", {
      meshName: mesh.name,
      vertexCount: mesh.getTotalVertices(),
      hasUV2,
      uv2FirstVertex: uv2Sample,
      textureSize: texSize,
      numFrames,
      fps,
      posMin: [posMin.x, posMin.y, posMin.z],
      posMax: [posMax.x, posMax.y, posMax.z],
      isPacked,
      flipV: flipVCheckbox.checked,
      useOffset: useOffsetCheckbox.checked
    });

    setStatus(
      `VAT applied to "${mesh.name}".\n` +
        `Vertices: ${mesh.getTotalVertices()}, UV2: ${hasUV2 ? "Yes" : "NO!"}\n` +
        `Texture: ${texSize.width}×${texSize.height}\n` +
        `Frames: ${numFrames}, FPS: ${fps}\n` +
        `Bounds: [${posMin.x.toFixed(2)}, ${posMin.y.toFixed(2)}, ${posMin.z.toFixed(2)}] → ` +
        `[${posMax.x.toFixed(2)}, ${posMax.y.toFixed(2)}, ${posMax.z.toFixed(2)}]\n` +
        `UV2 sample: ${uv2Sample}\n` +
        `Click Play to animate.`
    );
  } catch (err) {
    setStatus(`Failed to apply VAT: ${err}`);
  }
}

async function loadTextureFromFile(file: File, targetScene: Scene): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const texture = new Texture(
      url,
      targetScene,
      false, // noMipmap
      true, // invertY
      Texture.NEAREST_NEAREST, // sampling mode for precise pixel lookup
      () => {
        URL.revokeObjectURL(url);
        resolve(texture);
      },
      (message) => {
        URL.revokeObjectURL(url);
        reject(new Error(message || "Failed to load texture"));
      }
    );
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  });
}

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

/**
 * Parse Unity material file (YAML) exported by SideFX Labs VAT
 * Extracts: _boundMin/Max X/Y/Z, _frameCount, _houdiniFPS
 */
function parseUnityMaterial(text: string): Partial<VatMetadata> {
  const meta: Partial<VatMetadata> = {};

  // Helper to extract float value from "- _varName: value" format
  const extractFloat = (name: string): number | undefined => {
    const regex = new RegExp(`-\\s*${name}:\\s*([\\d.\\-e]+)`, "i");
    const match = text.match(regex);
    return match ? parseFloat(match[1]) : undefined;
  };

  const boundMinX = extractFloat("_boundMinX");
  const boundMinY = extractFloat("_boundMinY");
  const boundMinZ = extractFloat("_boundMinZ");
  const boundMaxX = extractFloat("_boundMaxX");
  const boundMaxY = extractFloat("_boundMaxY");
  const boundMaxZ = extractFloat("_boundMaxZ");
  const frameCount = extractFloat("_frameCount");
  const fps = extractFloat("_houdiniFPS");

  if (boundMinX !== undefined && boundMinY !== undefined && boundMinZ !== undefined) {
    meta.posMin = [boundMinX, boundMinY, boundMinZ];
  }
  if (boundMaxX !== undefined && boundMaxY !== undefined && boundMaxZ !== undefined) {
    meta.posMax = [boundMaxX, boundMaxY, boundMaxZ];
  }
  if (frameCount !== undefined) {
    meta.numFrames = Math.round(frameCount);
  }
  if (fps !== undefined) {
    meta.fps = fps;
  }

  console.log("Parsed Unity material:", meta);
  return meta;
}

/**
 * Apply or remove instancing to the current VAT mesh
 * Creates a 10x10 grid of instances with staggered animation offsets
 */
function applyInstancing(enable: boolean) {
  if (!currentVatMesh || !vatMaterial || !positionTexture) {
    return;
  }

  isInstancedMode = enable;

  if (!enable) {
    // Remove instances
    currentVatMesh.thinInstanceCount = 0;
    currentVatMesh.material = vatMaterial;
    vatMaterialInstanced?.dispose();
    vatMaterialInstanced = null;
    setStatus("Instancing disabled. Single mesh mode.");
    return;
  }

  // Create instanced shader material with INSTANCES define
  vatMaterialInstanced?.dispose();
  vatMaterialInstanced = new ShaderMaterial(
    "vatMaterialInstanced",
    scene,
    {
      vertex: "sidefxVat",
      fragment: "sidefxVat"
    },
    {
      attributes: ["position", "normal", "uv", "uv2", "world0", "world1", "world2", "world3", "instanceTimeOffset"],
      uniforms: [
        "world",
        "viewProjection",
        "worldViewProjection",
        "positionTexture",
        "normalTexture",
        "vatTime",
        "numFrames",
        "fps",
        "posMin",
        "posMax",
        "texSize",
        "useNormalTex",
        "isPacked",
        "flipV",
        "useOffset",
        "debugMode",
        "lightDirection",
        "lightColor",
        "ambientColor",
        "diffuseColor",
        "diffuseTexture",
        "useDiffuseTex"
      ],
      samplers: ["positionTexture", "normalTexture", "diffuseTexture"],
      defines: ["INSTANCES"]
    }
  );

  // Copy all uniform values from the non-instanced material
  const numFrames = Number(numFramesInput.value) || 24;
  const fps = Number(fpsInput.value) || 24;
  const posMin = new Vector3(
    Number(posMinX.value),
    Number(posMinY.value),
    Number(posMinZ.value)
  );
  const posMax = new Vector3(
    Number(posMaxX.value),
    Number(posMaxY.value),
    Number(posMaxZ.value)
  );
  const texSize = positionTexture.getSize();

  vatMaterialInstanced.setTexture("positionTexture", positionTexture);
  vatMaterialInstanced.setFloat("vatTime", vatTime);
  vatMaterialInstanced.setFloat("numFrames", numFrames);
  vatMaterialInstanced.setFloat("fps", fps);
  vatMaterialInstanced.setVector3("posMin", posMin);
  vatMaterialInstanced.setVector3("posMax", posMax);
  vatMaterialInstanced.setVector2("texSize", new Vector2(texSize.width, texSize.height));
  vatMaterialInstanced.setFloat("isPacked", isPacked ? 1.0 : 0.0);
  vatMaterialInstanced.setFloat("flipV", flipVCheckbox.checked ? 1.0 : 0.0);
  vatMaterialInstanced.setFloat("useOffset", useOffsetCheckbox.checked ? 1.0 : 0.0);
  vatMaterialInstanced.setFloat("debugMode", Number(debugModeSelect.value));

  if (normalTexture) {
    vatMaterialInstanced.setTexture("normalTexture", normalTexture);
    vatMaterialInstanced.setFloat("useNormalTex", 1.0);
  } else {
    vatMaterialInstanced.setFloat("useNormalTex", 0.0);
  }

  vatMaterialInstanced.setVector3("lightDirection", new Vector3(0.5, 1, 0.3));
  vatMaterialInstanced.setColor3("lightColor", new Color3(1, 1, 1));
  vatMaterialInstanced.setColor3("ambientColor", new Color3(0.15, 0.15, 0.18));
  vatMaterialInstanced.setColor3("diffuseColor", new Color3(0.9, 0.9, 0.9));
  vatMaterialInstanced.setFloat("useDiffuseTex", 0.0);
  vatMaterialInstanced.backFaceCulling = false;

  // Get instance count and calculate grid size
  const instanceCount = Math.max(1, Math.min(10000, Number(instanceCountInput.value) || 100));
  const gridSize = Math.ceil(Math.sqrt(instanceCount));
  const spacing = Number(instanceSpacingInput.value) || 3;
  
  // Calculate animation duration for offset distribution
  const animDuration = numFrames / fps;

  // Prepare instance matrices (16 floats per instance)
  const matricesData = new Float32Array(instanceCount * 16);
  
  // Prepare time offsets (1 float per instance)
  const timeOffsets = new Float32Array(instanceCount);

  // Calculate grid offset to center the grid
  const gridOffset = ((gridSize - 1) * spacing) / 2;

  for (let i = 0; i < instanceCount; i++) {
    const row = Math.floor(i / gridSize);
    const col = i % gridSize;

    // Position in grid, centered around origin
    const x = col * spacing - gridOffset;
    const z = row * spacing - gridOffset;

    // Create transformation matrix
    const matrix = Matrix.Translation(x, 0, z);
    matrix.copyToArray(matricesData, i * 16);

    // Distribute time offsets evenly across the animation duration
    // This creates a wave-like effect across the grid
    timeOffsets[i] = ((row + col) / (gridSize * 2 - 2)) * animDuration;
  }

  // Apply thin instances
  currentVatMesh.thinInstanceSetBuffer("matrix", matricesData, 16, false);
  
  // Register custom time offset buffer
  currentVatMesh.thinInstanceSetBuffer("instanceTimeOffset", timeOffsets, 1, false);
  
  // Set the instanced material
  currentVatMesh.material = vatMaterialInstanced;

  setStatus(
    `Instancing enabled: ${instanceCount} instances in ${gridSize}×${gridSize} grid.\n` +
    `Spacing: ${spacing} units, Animation offsets: 0 to ${animDuration.toFixed(2)}s`
  );

  console.log("Instanced VAT debug mode enabled:", {
    instanceCount,
    gridSize,
    spacing,
    animDuration,
    timeOffsetRange: [0, animDuration]
  });
}

