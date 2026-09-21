"""Protocol tests for the local Kokoro worker (no model files required)."""

from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kokoro_server as worker  # noqa: E402


TOKEN = "test-token-with-more-than-24-characters"


class FakeModel:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, float]] = []

    def get_voices(self) -> list[str]:
        return ["af_heart", "hf_alpha"]

    def create(self, text: str, voice: str, lang: str, speed: float):
        import numpy as np

        self.calls.append((text, voice, lang, speed))
        return np.zeros(240, dtype=np.float32), worker.SAMPLE_RATE


class WorkerProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.model = FakeModel()
        self.server = worker.Server(
            (worker.HOST, 0), worker.make_handler(self.model, TOKEN)
        )
        self.server.synthesis_lock = threading.Lock()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://{worker.HOST}:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path: str, *, body: bytes | None = None, headers=None):
        return urllib.request.Request(
            self.base_url + path, data=body, headers=headers or {}
        )

    def assert_http_error(self, request, status: int) -> None:
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=3)
        self.assertEqual(caught.exception.code, status)

    def test_health_requires_bearer_and_lists_ready_voices(self) -> None:
        self.assert_http_error(self.request("/health"), 401)
        request = self.request("/health", headers={"Authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(request, timeout=3) as response:
            payload = json.load(response)
        self.assertEqual(payload, {"ready": True, "voices": ["af_heart", "hf_alpha"]})

    def test_origin_header_is_rejected_even_with_token(self) -> None:
        request = self.request(
            "/health",
            headers={"Authorization": f"Bearer {TOKEN}", "Origin": "https://example.invalid"},
        )
        self.assert_http_error(request, 403)

    def test_synthesize_returns_24khz_wav_and_uses_hindi_voice(self) -> None:
        body = json.dumps(
            {"text": "नमस्ते", "language": "hi"}, ensure_ascii=False
        ).encode("utf-8")
        request = self.request(
            "/synthesize",
            body=body,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            audio = response.read()
            self.assertEqual(response.headers.get_content_type(), "audio/wav")
        self.assertEqual(audio[:4], b"RIFF")
        self.assertEqual(int.from_bytes(audio[24:28], "little"), worker.SAMPLE_RATE)
        self.assertEqual(self.model.calls, [("नमस्ते", "hf_alpha", "hi", 1.0)])

    def test_bad_content_type_and_bad_payload_are_rejected(self) -> None:
        headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "text/plain"}
        self.assert_http_error(
            self.request("/synthesize", body=b"{}", headers=headers), 415
        )
        headers["Content-Type"] = "application/json"
        self.assert_http_error(
            self.request("/synthesize", body=b"{bad", headers=headers), 400
        )
        self.assertEqual(self.model.calls, [])

    def test_unsupported_language_and_romanized_hindi_are_rejected(self) -> None:
        headers = {
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        }
        for payload in (
            {"text": "hello", "language": "fr"},
            {"text": "namaste", "language": "hi"},
        ):
            request = self.request(
                "/synthesize",
                body=json.dumps(payload).encode("utf-8"),
                headers=headers,
            )
            self.assert_http_error(request, 400)
        self.assertEqual(self.model.calls, [])


if __name__ == "__main__":
    unittest.main()
