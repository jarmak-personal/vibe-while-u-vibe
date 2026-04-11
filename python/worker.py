#!/usr/bin/env python3
"""
vibe-while-u-vibe local music worker.

Long-running process that hosts a MusicGen model and serves generation
requests over localhost HTTP. Spawned by the daemon (src/generators/local.ts),
one instance per daemon. The worker prints 'VIBE_WORKER_READY' to stdout once
the model is loaded so the daemon knows when to start routing requests.

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
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import torch
import torchaudio
from audiocraft.models import MusicGen


# Module-level state — populated in main(). Single-threaded HTTPServer means
# no locking needed; the handler runs in the main thread.
MODEL: MusicGen | None = None
DEVICE: str = ""
MODEL_NAME: str = ""
AUTH_TOKEN: str = ""
SERVER: HTTPServer | None = None


def pick_device(preference: str) -> str:
    if preference != "auto":
        return preference
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(size: str, device: str) -> None:
    """Downloads weights on first call (via huggingface_hub), cached to HF_HOME."""
    global MODEL, MODEL_NAME
    MODEL_NAME = f"facebook/musicgen-{size}"
    MODEL = MusicGen.get_pretrained(MODEL_NAME, device=device)


def generate(prompt: str, duration_s: int, output_path: str) -> dict:
    if MODEL is None:
        return {"ok": False, "error": "model not loaded"}
    t0 = time.time()
    MODEL.set_generation_params(duration=duration_s)
    # MusicGen.generate returns a batch tensor: [batch, channels, samples].
    # We send one prompt, so squeeze the batch dim for torchaudio.save which
    # wants [channels, samples].
    wav = MODEL.generate([prompt], progress=False)
    wav = wav[0].cpu()
    # torchaudio.save infers format from the extension. MusicGen outputs 32kHz
    # mono/stereo; use the model's reported sample rate to be safe.
    torchaudio.save(output_path, wav, MODEL.sample_rate)
    elapsed_ms = int((time.time() - t0) * 1000)
    return {"ok": True, "path": output_path, "duration_ms": elapsed_ms}


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
            ready = MODEL is not None
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
        # Suppress default per-request access log.
        pass


def install_signal_handlers() -> None:
    def handle(signum, frame):  # noqa: ARG001
        # HTTPServer.shutdown() must be called from a thread other than the
        # one running serve_forever. We can't call it directly from a signal
        # handler either — easiest is to os._exit after a tiny grace period.
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)


def main() -> None:
    global DEVICE, AUTH_TOKEN, SERVER

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--size", choices=["small", "medium", "large"], default="medium"
    )
    parser.add_argument(
        "--device", choices=["mps", "cuda", "cpu", "auto"], default="auto"
    )
    args = parser.parse_args()

    AUTH_TOKEN = os.environ.get("VIBE_WORKER_TOKEN", "")
    DEVICE = pick_device(args.device)

    SERVER = HTTPServer(("127.0.0.1", args.port), Handler)
    load_model(args.size, DEVICE)

    # Signal readiness only after the HTTP server is bound and the model is
    # loaded. The daemon still probes /health, but this ordering avoids a
    # needless race where READY is printed before the socket exists.
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
