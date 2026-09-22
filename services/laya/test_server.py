# /// script
# requires-python = ">=3.12"
# dependencies = ["fastapi>=0.115,<1", "httpx>=0.27,<1", "uvicorn>=0.30,<1"]
# ///
"""Bridge contract tests with an injected predictor: no Laya, torch, or weights."""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import uvicorn

from server import check_context, ContextLimitError, create_app, load_predictor

REQUEST = {"model": "laya", "state": "Synthetic evidence", "questions": {"decision": {
    "type": "choice", "instructions": "What failed?", "criteria": {"code": "A defect", "environment": None},
}}}
ANSWER = {"type": "choice", "choice": "code", "probabilities": {"code": 0.9, "environment": 0.1}, "confidence": 0.8}


class FakePredictor:
    def __init__(self, response=None, error=None):
        self.calls = []
        self.response = response if response is not None else {"answers": {"decision": ANSWER}}
        self.error = error

    def predict(self, state, questions):
        self.calls.append((state, questions))
        if self.error:
            raise self.error
        return self.response


class Tokenizer:
    mask_token = "[MASK]"

    def __call__(self, text, **kwargs):
        return {"input_ids": list(range(len(text.split())))}


class BridgeTests(unittest.TestCase):
    def test_startup_loads_once_and_reports_configured_model(self):
        predictor = FakePredictor(response={"model": "sdk-generic-name", "diagnostics": "private", "answers": {
            "decision": {**ANSWER, "action": {"act_probability": 1}, "private": "not-forwarded"},
        }})
        loads = []
        def loader():
            loads.append(True)
            return predictor
        app = create_app(loader=loader)
        self.assertEqual(loads, [])
        with TestClient(app) as client:
            self.assertEqual(client.get("/health").json()["status"], "ready")
            for _ in range(2):
                response = client.post("/v1/systemone", json=REQUEST)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"model": "laya", "answers": {"decision": ANSWER}})
            self.assertEqual(len(loads), 1)
            self.assertEqual(predictor.calls, [(REQUEST["state"], REQUEST["questions"])] * 2)

    def test_load_failure_prevents_ready_service(self):
        def loader():
            raise RuntimeError("Checkpoint missing")
        with self.assertRaisesRegex(RuntimeError, "Checkpoint missing"):
            with TestClient(create_app(loader=loader)):
                self.fail("Startup must fail")

    def test_authentication_before_validation_and_inference(self):
        predictor = FakePredictor()
        with TestClient(create_app(api_key="fixture-key", loader=lambda: predictor)) as client:
            for headers in [{}, {"Authorization": "Bearer wrong"}, {"Authorization": "Basic fixture-key"}]:
                self.assertEqual(client.post("/v1/systemone", content="private", headers=headers).status_code, 401)
                self.assertEqual(client.get("/health", headers=headers).status_code, 401)
            self.assertEqual(predictor.calls, [])
            response = client.post("/v1/systemone", json=REQUEST, headers={"Authorization": "Bearer fixture-key"})
            self.assertEqual(response.status_code, 200)

    def test_unknown_model_does_not_load_or_infer(self):
        predictor = FakePredictor()
        with TestClient(create_app(loader=lambda: predictor)) as client:
            for model in ["another-model", "/private/checkpoint", "../checkpoint"]:
                self.assertEqual(client.post("/v1/systemone", json={**REQUEST, "model": model}).status_code, 404)
            self.assertEqual(predictor.calls, [])

    def test_only_one_choice_question_and_string_evidence_are_accepted(self):
        bad = [None, {}, {**REQUEST, "state": {}}, {**REQUEST, "state": " "}, {**REQUEST, "extra": "private"},
               {**REQUEST, "questions": {}}, {**REQUEST, "questions": {**REQUEST["questions"], "other": REQUEST["questions"]["decision"]}}]
        for update in [{"type": "score"}, {"type": "noul"}, {"instructions": " "},
                       {"criteria": {"only": None}}, {"criteria": {"code": 1, "environment": None}},
                       {"criteria": {" code": None, "environment": None}}, {"criteria": {"code": " ", "environment": None}}]:
            bad.append({**REQUEST, "questions": {"decision": {**REQUEST["questions"]["decision"], **update}}})
        predictor = FakePredictor()
        with TestClient(create_app(loader=lambda: predictor)) as client:
            for body in bad:
                response = client.post("/v1/systemone", content=json.dumps(body))
                self.assertEqual(response.status_code, 422, body)
                self.assertNotIn("private", response.text)
            self.assertEqual(client.post("/v1/systemone", content="not-json-private").status_code, 422)
            self.assertEqual(predictor.calls, [])

    def test_body_budget_is_enforced(self):
        predictor = FakePredictor()
        with TestClient(create_app(loader=lambda: predictor)) as client:
            self.assertEqual(client.post("/v1/systemone", content="x" * 65_537).status_code, 413)
            self.assertEqual(predictor.calls, [])

    def test_inference_errors_are_sanitized_and_context_limit_is_explicit(self):
        for error, status in [(RuntimeError("secret evidence"), 500), (ContextLimitError("secret evidence"), 413)]:
            with TestClient(create_app(loader=lambda: FakePredictor(error=error))) as client:
                response = client.post("/v1/systemone", json=REQUEST)
                self.assertEqual(response.status_code, status)
                self.assertNotIn("secret", response.text)

    def test_bad_predictor_responses_fail_closed(self):
        for update in [{"choice": "not-declared"}, {"choice": "environment"}, {"confidence": True},
                       {"confidence": float("nan")}, {"probabilities": {"code": 1}},
                       {"probabilities": {"code": 0.5, "environment": 0.1}}, {"probabilities": [0.9, 0.1]}]:
            predictor = FakePredictor(response={"answers": {"decision": {**ANSWER, **update}}})
            with TestClient(create_app(loader=lambda: predictor)) as client:
                self.assertEqual(client.post("/v1/systemone", json=REQUEST).status_code, 502)

    def test_concurrent_inference_is_rejected_not_queued(self):
        entered, release = threading.Event(), threading.Event()
        class BlockingPredictor(FakePredictor):
            def predict(self, state, questions):
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("Test did not release inference")
                return super().predict(state, questions)
        with TestClient(create_app(loader=BlockingPredictor)) as client:
            responses = []
            first = threading.Thread(target=lambda: responses.append(client.post("/v1/systemone", json=REQUEST)))
            first.start()
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(client.post("/v1/systemone", json=REQUEST).status_code, 503)
            finally:
                release.set()
                first.join(5)
            self.assertEqual(responses[0].status_code, 200)

    def test_context_checks_evidence_question_options_and_option_budget(self):
        tok = Tokenizer()
        check_context(tok, "short evidence", "which", ["code", "environment"], 512, 192)
        cases = [
            ("evidence " * 510, "which", ["a", "b"], 512, 192),
            ("short", "instructions " * 192, ["a", "b"], 512, 192),
            ("short", "which", ["option " * 49, "b"], 512, 192),
            ("short", "which", ["a", "b"] * 50, 512, 192),
        ]
        for args in cases:
            with self.assertRaises(ContextLimitError):
                check_context(tok, *args)

    def test_real_loader_wiring_without_importing_ml_dependencies(self):
        predictor = FakePredictor()
        predictor.tok = Tokenizer()
        predictor.cfg = {"max_len": 512, "head_max_len": 192}
        calls = []
        fake_laya = types.ModuleType("laya")
        def load(checkpoint, **kwargs):
            calls.append((checkpoint, kwargs))
            return predictor
        fake_laya.load = load
        common = types.ModuleType("laya.common")
        common.render_options = lambda q: list(q["crit"])
        with patch.dict(sys.modules, {"laya": fake_laya, "laya.common": common}):
            wrapped = load_predictor("local/checkpoint", "multilingual", "cpu")
            wrapped.predict(REQUEST["state"], REQUEST["questions"])
            self.assertEqual(calls, [("local/checkpoint", {"subfolder": "multilingual", "device": "cpu"})])
            with self.assertRaises(ContextLimitError):
                wrapped.predict("word " * 1000, REQUEST["questions"])
            self.assertEqual(len(predictor.calls), 1)

    def test_node_provider_to_real_http_bridge_with_fake_predictor(self):
        """Actual Node -> HTTP -> Python path; predictor is deliberately a fixture."""
        predictor = FakePredictor()
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(create_app(loader=lambda: predictor), log_level="error", access_log=False))
        thread = threading.Thread(target=lambda: server.run(sockets=[sock]))
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(server.started)
            module = (Path(__file__).resolve().parents[2] / "src/laya.ts").as_uri()
            code = f'''import assert from 'node:assert/strict';
import {{ layaAgent }} from {json.dumps(module)};
const result = await layaAgent({{ baseUrl:'http://127.0.0.1:{port}', apiKey:'fixture-only' }})({{
 prompt:'Synthetic evidence', outcomes:['code','environment']
}});
assert.equal(result.type,'code');
assert.equal(result.decision.provider,'laya');
assert.deepEqual(result.decision.probabilities,{{code:0.9,environment:0.1}});
'''
            environment = {key: value for key, value in os.environ.items() if not key.startswith("LAYA_")}
            result = subprocess.run(["node", "--input-type=module", "--eval", code],
                                    capture_output=True, text=True, timeout=10, env=environment)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(predictor.calls), 1)
        finally:
            server.should_exit = True
            thread.join(5)
            sock.close()
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main(verbosity=2)
