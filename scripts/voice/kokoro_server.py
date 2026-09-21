#!/usr/bin/env python3
"""Small, local-only HTTP worker for a preinstalled Kokoro ONNX model.

No model files are downloaded by this program. Example:
  KELLY_KOKORO_TOKEN='replace-with-at-least-24-random-characters' python kokoro_server.py \\
    --model /models/kokoro-v1.0.onnx --voices /models/voices-v1.0.bin
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import threading
import wave
from array import array
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HOST = "127.0.0.1"
SAMPLE_RATE = 24_000
MAX_BODY_BYTES = 64 * 1024
MAX_TEXT_CHARS = 4_000
MAX_AUDIO_SECONDS = 90
MAX_TOKENS = 2_000
SOCKET_TIMEOUT_SECONDS = 10
INFERENCE_TIMEOUT_SECONDS = 120
CPU_THREADS = max(1, min(4, os.cpu_count() or 1))


def load_model(model_path: str, voices_path: str) -> Any:
    """Load the local ONNX assets once, limiting ONNX Runtime CPU threads."""
    try:
        import onnxruntime as ort
        from kokoro_onnx import Kokoro
    except ImportError as exc:
        raise RuntimeError(
            "TTS dependencies are missing; install scripts/voice/requirements.txt"
        ) from exc

    options = ort.SessionOptions()
    options.intra_op_num_threads = CPU_THREADS
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

    session = ort.InferenceSession(
        model_path,
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    # The installed 0.4.9 API exposes from_session; its ordinary constructor
    # would create a second, unbounded default ONNX Runtime session.
    return Kokoro.from_session(session, voices_path)


def pcm_wav(samples: Any, sample_rate: int) -> bytes:
    """Convert Kokoro float samples into a mono signed-16-bit PCM WAV."""
    import numpy as np

    pcm = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not len(pcm):
        raise ValueError("Synthesis returned empty audio")
    if len(pcm) > SAMPLE_RATE * MAX_AUDIO_SECONDS:
        raise ValueError("Generated audio exceeds the duration limit")
    pcm = np.nan_to_num(pcm, nan=0.0, posinf=1.0, neginf=-1.0)
    encoded = array("h", np.clip(pcm, -1.0, 1.0).__mul__(32767).astype("<i2"))
    if sys.byteorder != "little":
        encoded.byteswap()
    from io import BytesIO

    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(encoded.tobytes())
    return output.getvalue()


def token_count(text: str) -> int:
    # Conservative approximate guard; actual language tokenization is model-side.
    return len(text.split()) + sum(1 for char in text if ord(char) > 0x2FFF)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_handler(model: Any, token: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "KellyKokoro/1.0"
        sys_version = ""

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(SOCKET_TIMEOUT_SECONDS)

        def log_message(self, fmt: str, *args: Any) -> None:
            # No request bodies or user text are ever logged.
            sys.stderr.write("kokoro: %s - %s\n" % (self.address_string(), fmt % args))

        def _json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            # Browsers cannot set this custom header cross-origin without a
            # preflight, and all Origin-bearing requests are rejected anyway.
            if self.headers.get("Origin"):
                self._json(403, {"error": "browser origins are not allowed"})
                return False
            supplied = self.headers.get("Authorization", "")
            prefix = "Bearer "
            candidate = supplied[len(prefix):] if supplied.startswith(prefix) else ""
            if not secrets.compare_digest(candidate, token):
                self._json(401, {"error": "unauthorized"})
                return False
            return True

        def do_OPTIONS(self) -> None:
            self._json(405, {"error": "method not allowed"})

        def do_GET(self) -> None:
            if self.path != "/health":
                self._json(404, {"error": "not found"})
                return
            if not self._authorized():
                return
            self._json(200, {"ready": True, "voices": model.get_voices()})

        def do_POST(self) -> None:
            if self.path != "/synthesize":
                self._json(404, {"error": "not found"})
                return
            if not self._authorized():
                return
            if self.headers.get_content_type() != "application/json":
                self._json(415, {"error": "application/json required"})
                return
            length_header = self.headers.get("Content-Length", "")
            try:
                length = int(length_header)
            except ValueError:
                self._json(411, {"error": "valid Content-Length required"})
                return
            if length < 1 or length > MAX_BODY_BYTES:
                self._json(413, {"error": "request body too large"})
                return
            try:
                payload = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._json(400, {"error": "invalid JSON"})
                return
            if not isinstance(payload, dict) or set(payload) != {"text", "language"}:
                self._json(400, {"error": "expected exactly text and language"})
                return
            text = payload["text"]
            language = payload["language"]
            if not isinstance(text, str) or not text.strip():
                self._json(400, {"error": "text must be a non-empty string"})
                return
            if len(text) > MAX_TEXT_CHARS or token_count(text) > MAX_TOKENS:
                self._json(413, {"error": "text exceeds synthesis limits"})
                return
            if language not in ("hi", "en"):
                self._json(400, {"error": "language must be hi or en"})
                return
            if language == "hi" and not any("\u0900" <= c <= "\u097f" for c in text):
                self._json(400, {"error": "Hindi requests must use Devanagari text"})
                return

            voice = "hf_alpha" if language == "hi" else "af_heart"
            model_language = "hi" if language == "hi" else "en-us"
            with self.server.synthesis_lock:
                # ONNX Runtime cannot safely cancel a single in-process inference.
                # If one wedges, stop this local worker so a supervisor can restart
                # it instead of leaving an indefinitely blocked process behind.
                watchdog = threading.Timer(INFERENCE_TIMEOUT_SECONDS, os._exit, args=(70,))
                watchdog.daemon = True
                watchdog.start()
                try:
                    samples, sample_rate = model.create(
                        text.strip(), voice=voice, lang=model_language, speed=1.0
                    )
                    if sample_rate != SAMPLE_RATE:
                        raise ValueError(f"unexpected sample rate: {sample_rate}")
                    audio = pcm_wav(samples, sample_rate)
                except ValueError as exc:
                    self._json(422, {"error": str(exc)[:200]})
                    return
                except Exception:
                    self._json(500, {"error": "synthesis failed"})
                    return
                finally:
                    watchdog.cancel()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(audio)

    return Handler


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="local Kokoro ONNX model path")
    parser.add_argument("--voices", required=True, help="local voices .bin/.npz path")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not 1 <= args.port <= 65535:
        print("port must be between 1 and 65535", file=sys.stderr)
        return 2
    for label, value in (("model", args.model), ("voices", args.voices)):
        if not Path(value).is_file():
            print(f"{label} file does not exist: {value}", file=sys.stderr)
            return 2
    token = os.environ.get("KELLY_KOKORO_TOKEN", "")
    if len(token) < 24:
        print("KELLY_KOKORO_TOKEN must contain at least 24 characters", file=sys.stderr)
        return 2
    try:
        model = load_model(args.model, args.voices)
    except Exception as exc:
        print(f"could not load local Kokoro model: {exc}", file=sys.stderr)
        return 1
    server = Server((HOST, args.port), make_handler(model, token))
    server.synthesis_lock = threading.Lock()
    print(f"Kokoro worker listening on http://{HOST}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
