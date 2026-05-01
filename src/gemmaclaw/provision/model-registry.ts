import type { BackendId } from "./types.js";

export type RuntimeArtifact = {
  version: string;
  urlTemplate: string;
  sha256?: Record<string, string>;
};

export type ModelArtifact = {
  id: string;
  displayName: string;
  backend: BackendId;
  /** For Ollama: the tag to pull (e.g. "gemma3:1b"). */
  ollamaTag?: string;
  /** For llama.cpp / gemma.cpp: direct download URL. */
  url?: string;
  /** Expected sha256 of the downloaded model file. */
  sha256?: string;
  /** Approximate download size in bytes. */
  sizeBytes?: number;
};

// -----------------------------------------------------------------------
// Runtime binaries
// -----------------------------------------------------------------------

export const OLLAMA_RUNTIME: RuntimeArtifact = {
  version: "0.21.2",
  urlTemplate: "https://github.com/ollama/ollama/releases/download/v{version}/ollama-{os}-{arch}",
};

export const LLAMACPP_RUNTIME: RuntimeArtifact = {
  version: "b5460",
  urlTemplate:
    "https://github.com/ggerganov/llama.cpp/releases/download/{version}/llama-{version}-bin-ubuntu-x64.zip",
};

export const GEMMACPP_REPO = "https://github.com/google/gemma.cpp.git";
export const GEMMACPP_TAG = "v0.1.0";

// -----------------------------------------------------------------------
// Default models (smallest known-working for each backend)
// -----------------------------------------------------------------------

export const DEFAULT_MODELS: Record<BackendId, ModelArtifact> = {
  ollama: {
    id: "gemma3:1b",
    displayName: "Gemma 3 1B (Ollama)",
    backend: "ollama",
    ollamaTag: "gemma3:1b",
    sizeBytes: 815_000_000,
  },
  "llama-cpp": {
    id: "tinyllama-1.1b-chat-v1.0.Q2_K",
    displayName: "TinyLlama 1.1B Chat Q2_K (GGUF)",
    backend: "llama-cpp",
    url: "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q2_K.gguf",
    sizeBytes: 482_000_000,
  },
  "gemma-cpp": {
    id: "gemma-2-2b-it",
    displayName: "Gemma 2 2B IT (gemma.cpp)",
    backend: "gemma-cpp",
    // gemma.cpp uses its own weight format; weights are downloaded via HuggingFace.
    // The exact URL depends on HF auth. Model download is handled by the manager.
    sizeBytes: 5_000_000_000,
  },
  vertex: {
    id: "gemma-3-27b-it",
    displayName: "Gemma 3 27B IT (Vertex AI)",
    backend: "vertex",
    sizeBytes: 0,
  },
};

// -----------------------------------------------------------------------
// Gemma model catalog (benchmark-ready presets)
// -----------------------------------------------------------------------

export type GemmaModelPreset = {
  id: string;
  displayName: string;
  family: "gemma3" | "gemma4";
  architecture: "dense" | "moe";
  parameterCount: string;
  ollamaTag?: string;
  ggufPath?: string;
  defaultContextLength: number;
  recommendedGpuLayers?: number;
  sizeBytes?: number;
};

export const GEMMA_MODEL_PRESETS: GemmaModelPreset[] = [
  // Gemma 3
  {
    id: "gemma3-1b",
    displayName: "Gemma 3 1B",
    family: "gemma3",
    architecture: "dense",
    parameterCount: "1B",
    ollamaTag: "gemma3:1b",
    defaultContextLength: 32768,
    sizeBytes: 815_000_000,
  },
  {
    id: "gemma3-4b",
    displayName: "Gemma 3 4B",
    family: "gemma3",
    architecture: "dense",
    parameterCount: "4B",
    ollamaTag: "gemma3:4b",
    defaultContextLength: 32768,
    sizeBytes: 3_300_000_000,
  },
  // Gemma 4
  {
    id: "gemma4-26b-moe",
    displayName: "Gemma 4 26B MoE (A4B)",
    family: "gemma4",
    architecture: "moe",
    parameterCount: "26B",
    ollamaTag: "gemma4:26b",
    ggufPath: "gemma4-26b-a4b-it-Q4_K_M.gguf",
    defaultContextLength: 128000,
    recommendedGpuLayers: 99,
    sizeBytes: 17_000_000_000,
  },
  {
    id: "gemma4-31b-dense",
    displayName: "Gemma 4 31B Dense",
    family: "gemma4",
    architecture: "dense",
    parameterCount: "31B",
    ollamaTag: "gemma4:31b",
    ggufPath: "gemma4-31b-it-Q4_K_M.gguf",
    defaultContextLength: 128000,
    recommendedGpuLayers: 99,
    sizeBytes: 19_000_000_000,
  },
  {
    id: "gemma4-31b-dense-q5",
    displayName: "Gemma 4 31B Dense Q5_K_M",
    family: "gemma4",
    architecture: "dense",
    parameterCount: "31B",
    ollamaTag: "gemma4-31b-q5km",
    ggufPath: "gemma4-31b-it-Q5_K_M.gguf",
    defaultContextLength: 128000,
    recommendedGpuLayers: 99,
    sizeBytes: 21_000_000_000,
  },
  {
    id: "gemma4-e4b",
    displayName: "Gemma 4 E4B (Nano)",
    family: "gemma4",
    architecture: "dense",
    parameterCount: "E4B",
    ollamaTag: "gemma4:e4b",
    defaultContextLength: 32768,
    sizeBytes: 9_600_000_000,
  },
];

export function findPreset(modelIdOrTag: string): GemmaModelPreset | undefined {
  const lower = modelIdOrTag.toLowerCase();
  return GEMMA_MODEL_PRESETS.find(
    (p) =>
      p.id === lower || p.ollamaTag?.toLowerCase() === lower || p.ggufPath?.toLowerCase() === lower,
  );
}

export type OllamaArtifactInfo = {
  url: string;
  /** "tgz" for Linux archives, "zip" for the macOS app bundle. */
  format: "tgz" | "zip";
};

export function resolveOllamaBinaryUrl(): OllamaArtifactInfo {
  const isDarwin = process.platform === "darwin";

  if (isDarwin) {
    const url = `https://github.com/ollama/ollama/releases/download/v${OLLAMA_RUNTIME.version}/Ollama-darwin.zip`;
    return { url, format: "zip" };
  }

  const arch = process.arch === "x64" ? "amd64" : "arm64";
  const url =
    OLLAMA_RUNTIME.urlTemplate
      .replace("{version}", OLLAMA_RUNTIME.version)
      .replace("{os}", "linux")
      .replace("{arch}", arch) + ".tgz";
  return { url, format: "tgz" };
}

export function resolveLlamaCppUrl(): string {
  return LLAMACPP_RUNTIME.urlTemplate.replace(/{version}/g, LLAMACPP_RUNTIME.version);
}
