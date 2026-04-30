import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export type HardwareInfo = {
  cpu: {
    arch: string;
    cores: number;
    model: string;
  };
  ram: {
    totalBytes: number;
    availableBytes: number;
  };
  gpu: {
    detected: boolean;
    nvidia: boolean;
    apple: boolean;
    name?: string;
    vramBytes?: number;
  };
};

export type SystemTools = {
  ollamaInstalled: boolean;
  ollamaPath?: string;
  llamacppInstalled: boolean;
  llamacppPath?: string;
  cmakeInstalled: boolean;
  cppCompilerInstalled: boolean;
  gitInstalled: boolean;
};

/**
 * Detect hardware: CPU arch/cores, RAM, GPU presence.
 * Best-effort and safe: if any probe fails, that field defaults to unknown/absent.
 */
export function detectHardware(): HardwareInfo {
  const cpus = os.cpus();
  return {
    cpu: {
      arch: process.arch,
      cores: cpus.length || 1,
      model: cpus[0]?.model ?? "unknown",
    },
    ram: {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem(),
    },
    gpu: detectGpu(),
  };
}

function detectGpu(): HardwareInfo["gpu"] {
  // NVIDIA GPU via /dev/nvidia0 or nvidia-smi (check first since it is most specific).
  const devExists = safeFileExists("/dev/nvidia0");
  if (devExists || hasNvidiaSmi()) {
    const smiInfo = queryNvidiaSmi();
    if (smiInfo) {
      return {
        detected: true,
        nvidia: true,
        apple: false,
        name: smiInfo.name,
        vramBytes: smiInfo.vramMb ? smiInfo.vramMb * 1024 * 1024 : undefined,
      };
    }
    return { detected: true, nvidia: true, apple: false };
  }

  // Apple Silicon: Metal GPU with unified memory (all system RAM is GPU-accessible).
  if (process.platform === "darwin" && process.arch === "arm64") {
    const chipName = queryAppleSiliconChip();
    return {
      detected: true,
      nvidia: false,
      apple: true,
      name: chipName ?? "Apple Silicon (Metal)",
      vramBytes: os.totalmem(),
    };
  }

  return { detected: false, nvidia: false, apple: false };
}

function queryAppleSiliconChip(): string | null {
  try {
    const output = execSync("sysctl -n machdep.cpu.brand_string", {
      timeout: 3_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function safeFileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** WSL2 nvidia-smi lives outside PATH at /usr/lib/wsl/lib/nvidia-smi. */
const WSL2_NVIDIA_SMI = "/usr/lib/wsl/lib/nvidia-smi";

function isWsl2(): boolean {
  try {
    return fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  } catch {
    return false;
  }
}

function findNvidiaSmi(): string | null {
  // Standard PATH lookup first.
  try {
    const p = execSync("which nvidia-smi", {
      timeout: 3_000,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (p) {
      return p;
    }
  } catch {
    // not on PATH
  }
  // WSL2 fallback: nvidia-smi is in /usr/lib/wsl/lib/ which is not always on PATH.
  if (isWsl2() && safeFileExists(WSL2_NVIDIA_SMI)) {
    return WSL2_NVIDIA_SMI;
  }
  return null;
}

function hasNvidiaSmi(): boolean {
  return findNvidiaSmi() !== null;
}

function queryNvidiaSmi(): { name: string; vramMb?: number } | null {
  const smiPath = findNvidiaSmi();
  if (!smiPath) {
    return null;
  }
  try {
    const output = execSync(
      `"${smiPath}" --query-gpu=name,memory.total --format=csv,noheader,nounits`,
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!output) {
      return null;
    }
    const parts = output.split(",").map((s) => s.trim());
    const name = parts[0] ?? "NVIDIA GPU";
    const vramMb = parts[1] ? Number.parseInt(parts[1], 10) : undefined;
    return { name, vramMb: vramMb && !Number.isNaN(vramMb) ? vramMb : undefined };
  } catch {
    return null;
  }
}

/**
 * Detect system-installed tools.
 * Uses PATH binaries before downloading.
 */
export function detectSystemTools(): SystemTools {
  return {
    ollamaInstalled: !!whichSync("ollama"),
    ollamaPath: whichSync("ollama"),
    llamacppInstalled: !!whichSync("llama-server"),
    llamacppPath: whichSync("llama-server"),
    cmakeInstalled: !!whichSync("cmake"),
    cppCompilerInstalled: !!whichSync("g++") || !!whichSync("clang++"),
    gitInstalled: !!whichSync("git"),
  };
}

function whichSync(cmd: string): string | undefined {
  try {
    const result = execSync(`which ${cmd}`, {
      timeout: 3_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format hardware info for display.
 */
export function formatHardwareInfo(hw: HardwareInfo): string[] {
  const ramGb = (hw.ram.totalBytes / 1024 ** 3).toFixed(1);
  const freeRamGb = (hw.ram.availableBytes / 1024 ** 3).toFixed(1);

  const lines: string[] = [
    `  CPU: ${hw.cpu.arch}, ${hw.cpu.cores} cores (${hw.cpu.model.trim()})`,
    `  RAM: ${ramGb} GB total, ${freeRamGb} GB available`,
  ];

  if (hw.gpu.detected) {
    if (hw.gpu.apple) {
      const unified = hw.gpu.vramBytes
        ? ` (${(hw.gpu.vramBytes / 1024 ** 3).toFixed(0)} GB unified memory)`
        : "";
      lines.push(`  GPU: ${hw.gpu.name ?? "Apple Silicon (Metal)"}${unified}`);
    } else if (hw.gpu.nvidia) {
      const vram = hw.gpu.vramBytes
        ? ` (${(hw.gpu.vramBytes / 1024 ** 3).toFixed(0)} GB VRAM)`
        : "";
      lines.push(`  GPU: ${hw.gpu.name ?? "NVIDIA GPU"}${vram}`);
    } else {
      lines.push(`  GPU: ${hw.gpu.name ?? "detected"}`);
    }
  } else {
    lines.push("  GPU: none detected");
  }

  return lines;
}
