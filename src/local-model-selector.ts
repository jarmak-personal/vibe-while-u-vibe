import type {
  LocalBackend,
  AceStepDitModel,
  AceStepLmModel,
  AceStepConfig,
  LocalModelSize,
} from "./config.js";

export interface HardwareProfile {
  platform: "darwin" | "linux" | "win32";
  backend: "mps" | "cuda" | "cpu";
  vramGb?: number;
  unifiedMemoryGb?: number;
  prefersQuality?: boolean;
}

export interface LocalModelRecommendation {
  localBackend: LocalBackend;
  aceStep?: AceStepConfig;
  musicgenSize?: LocalModelSize;
  reason: string;
}

export function recommendLocalMusicModel(
  hw: HardwareProfile
): LocalModelRecommendation {
  if (hw.backend === "mps") {
    return recommendForAppleSilicon(hw);
  }
  if (hw.backend === "cuda") {
    return recommendForCuda(hw);
  }
  // CPU fallback — MusicGen small is the only practical option.
  return {
    localBackend: "musicgen",
    musicgenSize: "small",
    reason: "CPU-only: MusicGen small is the only practical option (ACE-Step needs a GPU).",
  };
}

// Apple Silicon uses unified memory shared with the system, so we apply
// conservative thresholds compared to dedicated VRAM on Nvidia GPUs.
function recommendForAppleSilicon(
  hw: HardwareProfile
): LocalModelRecommendation {
  const mem = hw.unifiedMemoryGb ?? 0;

  if (mem < 8) {
    return {
      localBackend: "musicgen",
      musicgenSize: "small",
      reason: `${mem} GB unified memory: too constrained for ACE-Step, falling back to MusicGen small.`,
    };
  }

  if (mem < 16) {
    return aceRec(
      "acestep-v15-turbo",
      null,
      `${mem} GB unified memory: DiT-only turbo for low memory headroom.`,
    );
  }

  if (mem < 24) {
    return aceRec(
      "acestep-v15-turbo",
      "acestep-5Hz-lm-0.6B",
      `${mem} GB unified memory: turbo DiT + small LM.`,
    );
  }

  if (mem < 32) {
    return aceRec(
      "acestep-v15-sft",
      "acestep-5Hz-lm-1.7B",
      `${mem} GB unified memory: quality SFT DiT + medium LM.`,
    );
  }

  if (mem < 48) {
    return aceRec(
      "acestep-v15-xl-turbo",
      "acestep-5Hz-lm-1.7B",
      `${mem} GB unified memory: XL turbo DiT + medium LM.`,
    );
  }

  // 48 GB+ — try the largest config.
  return aceRec(
    "acestep-v15-xl-sft",
    "acestep-5Hz-lm-4B",
    `${mem} GB unified memory: XL quality DiT + large LM.`,
  );
}

function recommendForCuda(hw: HardwareProfile): LocalModelRecommendation {
  const vram = hw.vramGb ?? 0;

  if (vram <= 6) {
    return aceRec(
      "acestep-v15-turbo",
      null,
      `${vram} GB VRAM: DiT-only turbo (no LM fits alongside the DiT).`,
    );
  }

  if (vram < 12) {
    return aceRec(
      "acestep-v15-turbo",
      "acestep-5Hz-lm-0.6B",
      `${vram} GB VRAM: turbo DiT + small LM.`,
    );
  }

  if (vram < 16) {
    return aceRec(
      "acestep-v15-sft",
      "acestep-5Hz-lm-1.7B",
      `${vram} GB VRAM: quality SFT DiT + medium LM.`,
    );
  }

  if (vram < 20) {
    return aceRec(
      "acestep-v15-xl-turbo",
      "acestep-5Hz-lm-1.7B",
      `${vram} GB VRAM: XL turbo DiT + medium LM.`,
    );
  }

  if (vram < 24) {
    return aceRec(
      "acestep-v15-xl-sft",
      "acestep-5Hz-lm-1.7B",
      `${vram} GB VRAM: XL quality DiT + medium LM.`,
    );
  }

  // 24 GB+ — full quality config.
  return aceRec(
    "acestep-v15-xl-sft",
    "acestep-5Hz-lm-4B",
    `${vram} GB VRAM: XL quality DiT + large LM.`,
  );
}

function aceRec(
  ditModel: AceStepDitModel,
  lmModel: AceStepLmModel,
  reason: string,
): LocalModelRecommendation {
  return {
    localBackend: "ace-step",
    aceStep: { ditModel, lmModel },
    reason,
  };
}
