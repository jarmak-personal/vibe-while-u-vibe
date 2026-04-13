#!/usr/bin/env python3
"""
vibe-while-u-vibe local music worker.

Long-running process that hosts a local music model (ACE-Step or MusicGen)
and serves generation requests over localhost HTTP. Spawned by the daemon
(src/generators/local.ts), one instance per daemon. The worker prints
'VIBE_WORKER_READY' to stdout once the model is loaded so the daemon knows
when to start routing requests.

Protocol:
  GET  /health    → { "ready": bool, "device": str, "model": str }
  POST /generate  → { "ok": bool, "path": str, "duration_ms": int }
                    body: { "prompt": str, "duration_s": int, "output_path": str }

All POSTs require X-Vibe-Token header matching VIBE_WORKER_TOKEN env var when
set — cheap shared-secret auth so random localhost processes can't hit the
generator. The daemon generates the token at spawn time.

Shutdown is driven by the parent: daemon sends SIGTERM, worker exits cleanly.
"""
import argparse
import json
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import soundfile as sf
import torch


# ── Module-level state ──────────────────────────────────────────────────────
# Populated in main(). Single-threaded HTTPServer means no locking needed.
BACKEND: str = ""
DEVICE: str = ""
MODEL_NAME: str = ""
AUTH_TOKEN: str = ""
SERVER: HTTPServer | None = None
MODEL_CACHE_DIR: str = ""

# MusicGen state
MUSICGEN_MODEL = None

# ACE-Step state
ACE_PIPELINE = None


def pick_device(preference: str) -> str:
    if preference != "auto":
        return preference
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ── MusicGen backend ────────────────────────────────────────────────────────

def load_musicgen(size: str, device: str) -> None:
    global MUSICGEN_MODEL, MODEL_NAME
    from audiocraft.models import MusicGen

    MODEL_NAME = f"facebook/musicgen-{size}"
    MUSICGEN_MODEL = MusicGen.get_pretrained(MODEL_NAME, device=device)


def save_audio(output_path: str, tensor: torch.Tensor, sample_rate: int) -> None:
    audio = tensor.detach().cpu().float()
    if audio.dim() == 1:
        audio = audio.unsqueeze(0)
    # soundfile expects [frames, channels]
    audio_np = audio.transpose(0, 1).contiguous().numpy()
    sf.write(output_path, audio_np, sample_rate)


def transcode_to_mp3(input_path: str, output_path: str) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError(
            "ffmpeg not found on PATH. Install ffmpeg and re-run `npm run setup:local`."
        )
    result = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-i",
            input_path,
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "192k",
            output_path,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip() or "unknown ffmpeg error"
        raise RuntimeError(f"ffmpeg mp3 transcode failed: {stderr}")


class VibeACEStepPipeline:
    def __init__(self, inner_pipeline) -> None:
        self.inner = inner_pipeline

    def load_checkpoint(self, checkpoint_dir: str | None = None) -> None:
        self.inner.load_checkpoint(checkpoint_dir)

    def __call__(self, *args, **kwargs):
        return self.inner(*args, **kwargs)

    def save_wav_file(
        self, target_wav, idx, save_path=None, sample_rate=48000, format="wav"
    ):
        if save_path is None:
            base_path = "./outputs"
            os.makedirs(base_path, exist_ok=True)
            output_path = (
                f"{base_path}/output_{time.strftime('%Y%m%d%H%M%S')}_{idx}.{format}"
            )
        elif os.path.isdir(save_path):
            output_path = os.path.join(
                save_path, f"output_{time.strftime('%Y%m%d%H%M%S')}_{idx}.{format}"
            )
        else:
            output_path = save_path
        save_audio(output_path, target_wav, sample_rate)
        return output_path


def generate_musicgen(prompt: str, duration_s: int, output_path: str) -> dict:
    if MUSICGEN_MODEL is None:
        return {"ok": False, "error": "MusicGen model not loaded"}
    t0 = time.time()
    MUSICGEN_MODEL.set_generation_params(duration=duration_s)
    wav = MUSICGEN_MODEL.generate([prompt], progress=False)
    wav = wav[0].cpu()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        save_audio(tmp_path, wav, MUSICGEN_MODEL.sample_rate)
        transcode_to_mp3(tmp_path, output_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    elapsed_ms = int((time.time() - t0) * 1000)
    return {"ok": True, "path": output_path, "duration_ms": elapsed_ms}


# ── ACE-Step backend ────────────────────────────────────────────────────────

def load_ace_step(dit_model: str, lm_model: str | None, device: str) -> None:
    global ACE_PIPELINE, MODEL_NAME
    from acestep.pipeline_ace_step import ACEStepPipeline

    # The current official ACE-Step package exposes a single pipeline whose
    # checkpoint repo is managed internally, so the branch's DiT/LM selection
    # inputs are retained for config compatibility but not applied here.
    MODEL_NAME = "ACE-Step/ACE-Step-v1-3.5B"
    pipeline = ACEStepPipeline(
        checkpoint_dir=MODEL_CACHE_DIR,
        overlapped_decode=True,
    )
    ACE_PIPELINE = VibeACEStepPipeline(pipeline)
    ACE_PIPELINE.inner.save_wav_file = ACE_PIPELINE.save_wav_file
    ACE_PIPELINE.load_checkpoint(MODEL_CACHE_DIR)


def generate_ace_step(prompt: str, duration_s: int, output_path: str) -> dict:
    if ACE_PIPELINE is None:
        return {"ok": False, "error": "ACE-Step model not loaded"}

    t0 = time.time()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        result = ACE_PIPELINE(
            format="wav",
            audio_duration=float(duration_s),
            prompt=prompt,
            lyrics="",
            infer_step=27,
            save_path=tmp_path,
            batch_size=1,
        )
        if not isinstance(result, list) or len(result) == 0:
            error_msg = "ACE-Step generation returned no audio"
            return {"ok": False, "error": error_msg}
        audio_path = result[0]
        transcode_to_mp3(audio_path, output_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    elapsed_ms = int((time.time() - t0) * 1000)
    return {"ok": True, "path": output_path, "duration_ms": elapsed_ms}


# ── HTTP server ─────────────────────────────────────────────────────────────

def generate(prompt: str, duration_s: int, output_path: str) -> dict:
    if BACKEND == "ace-step":
        return generate_ace_step(prompt, duration_s, output_path)
    return generate_musicgen(prompt, duration_s, output_path)


class Handler(BaseHTTPRequestHandler):
    def _write_json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _auth_ok(self) -> bool:
        if not AUTH_TOKEN:
            return True
        return self.headers.get("X-Vibe-Token", "") == AUTH_TOKEN

    def do_GET(self) -> None:
        if self.path == "/health":
            ready = (
                MUSICGEN_MODEL is not None
                if BACKEND == "musicgen"
                else ACE_PIPELINE is not None
            )
            self._write_json(
                200 if ready else 503,
                {"ready": ready, "device": DEVICE, "model": MODEL_NAME},
            )
        else:
            self._write_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._auth_ok():
            self._write_json(401, {"error": "unauthorized"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw)
        except Exception:
            self._write_json(400, {"error": "invalid json"})
            return

        if self.path == "/generate":
            prompt = body.get("prompt", "")
            duration_s = int(body.get("duration_s", 30))
            output_path = body.get("output_path", "")
            if not prompt or not output_path:
                self._write_json(400, {"error": "missing prompt or output_path"})
                return
            try:
                result = generate(prompt, duration_s, output_path)
                self._write_json(200 if result.get("ok") else 500, result)
            except Exception as e:
                self._write_json(500, {"ok": False, "error": str(e)})
        else:
            self._write_json(404, {"error": "not found"})

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass


def install_signal_handlers() -> None:
    def handle(signum, frame):  # noqa: ARG001
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)


def main() -> None:
    global BACKEND, DEVICE, AUTH_TOKEN, SERVER, MODEL_CACHE_DIR

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--backend", choices=["ace-step", "musicgen"], default="musicgen")
    parser.add_argument(
        "--size", choices=["small", "medium", "large"], default="medium",
        help="MusicGen model size (only used when --backend=musicgen)",
    )
    parser.add_argument(
        "--dit-model", default="acestep-v15-turbo",
        help="ACE-Step DiT model ID (only used when --backend=ace-step)",
    )
    parser.add_argument(
        "--lm-model", default=None,
        help="ACE-Step LM model ID, omit for DiT-only mode (only used when --backend=ace-step)",
    )
    parser.add_argument(
        "--device", choices=["mps", "cuda", "cpu", "auto"], default="auto"
    )
    args = parser.parse_args()

    BACKEND = args.backend
    AUTH_TOKEN = os.environ.get("VIBE_WORKER_TOKEN", "")
    MODEL_CACHE_DIR = os.environ.get(
        "HF_HOME",
        os.path.join(os.path.expanduser("~"), ".cache", "huggingface"),
    )
    DEVICE = pick_device(args.device)

    SERVER = HTTPServer(("127.0.0.1", args.port), Handler)

    if BACKEND == "ace-step":
        load_ace_step(args.dit_model, args.lm_model, DEVICE)
    else:
        load_musicgen(args.size, DEVICE)

    print("VIBE_WORKER_READY", flush=True)

    install_signal_handlers()
    try:
        SERVER.serve_forever()
    except SystemExit:
        pass
    finally:
        if SERVER is not None:
            SERVER.server_close()


if __name__ == "__main__":
    main()
