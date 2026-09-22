# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["laya==0.3.4", "fastapi>=0.115,<1", "uvicorn>=0.30,<1"]
# ///
"""Opt-in, single-checkpoint Laya Choice bridge. Run with uv run --script server.py.

No model is loaded on import. Startup loads a real checkpoint once and fails if
loading fails. This is a development/self-hosting bridge, not a public gateway.
"""

import argparse
from contextlib import asynccontextmanager
import hmac
import json
import math
import os
import threading
from typing import Any, Callable, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

MAX_REQUEST_BYTES = 65_536
DEFAULT_CHECKPOINT = "convaiinnovations/laya"


class ContextLimitError(ValueError):
    """The SDK would silently truncate evidence, instructions, or options."""


class ChoiceQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["choice"]
    instructions: str = Field(min_length=1)
    criteria: dict[str, str | None] = Field(min_length=2)

    @field_validator("instructions")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Empty instructions")
        return value

    @field_validator("criteria")
    @classmethod
    def valid_choices(cls, value: dict[str, str | None]) -> dict[str, str | None]:
        if any(not key.strip() or key != key.strip()
               or (description is not None and not description.strip())
               for key, description in value.items()):
            raise ValueError("Invalid choices")
        return value


class Questions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    decision: ChoiceQuestion


class ChoiceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    model: str = Field(min_length=1)
    state: str = Field(min_length=1)
    questions: Questions

    @field_validator("state", "model")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Empty value")
        return value


def check_context(tokenizer: Any, state: str, instructions: str, options: list[str],
                  max_len: int, head_max_len: int) -> None:
    """Reject every truncation path in the pinned Laya 0.3.4 Choice formatter."""
    def count(text: str) -> int:
        return len(tokenizer(text.replace(tokenizer.mask_token, " "),
                             add_special_tokens=False)["input_ids"])

    head = count(f"choice question: {instructions}")
    option_lengths = [count(" " + option) for option in options]
    # The SDK first caps individual option descriptions at 48 tokens, then may
    # shrink all options to reserve 16 tokens of its question/option head budget.
    option_tokens = sum(length + 1 for length in option_lengths)  # MASK per option
    budget = head_max_len - option_tokens
    if (any(length > 48 for length in option_lengths) or budget < 16
            or head > max(8, budget)
            or head + option_tokens + count(state) + 4 > max_len):
        raise ContextLimitError("Request exceeds the checkpoint's untruncated context budget")


def load_predictor(checkpoint: str, subfolder: str | None, device: str | None) -> Any:
    # Optional ML dependencies are deliberately imported only during startup.
    import laya
    from laya.common import render_options

    agent = laya.load(checkpoint, subfolder=subfolder, device=device)

    class Predictor:
        def predict(self, state: str, questions: dict[str, Any]) -> Any:
            for question in questions.values():
                internal = {"t": "choice", "ins": question["instructions"], "crit": question["criteria"]}
                check_context(agent.tok, state, question["instructions"], render_options(internal),
                              agent.cfg.get("max_len", 512), agent.cfg.get("head_max_len", 192))
            return agent.predict(state, questions)

    return Predictor()


def normalized_response(raw: Any, model: str, choices: dict[str, Any]) -> dict[str, Any]:
    """Only validated classification fields leave the bridge, never SDK diagnostics."""
    answer = raw["answers"]["decision"]
    probabilities = answer["probabilities"]
    confidence = answer["confidence"]
    choice = answer["choice"]

    def probability(value: Any) -> bool:
        return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1

    if (answer["type"] != "choice" or not isinstance(choice, str) or choice not in choices
            or not isinstance(probabilities, dict) or probabilities.keys() != choices.keys()
            or not all(probability(value) for value in probabilities.values())
            or abs(sum(probabilities.values()) - 1) > 0.001
            or probabilities[choice] < max(probabilities.values())
            or not probability(confidence)):
        raise ValueError("Invalid Choice result")
    # The server's configured identifier names its loaded checkpoint; the request
    # cannot select arbitrary Hugging Face repositories or local filesystem paths.
    return {"model": model, "answers": {"decision": {
        "type": "choice", "choice": choice,
        "probabilities": probabilities, "confidence": confidence,
    }}}


def create_app(*, model: str = "laya", checkpoint: str = DEFAULT_CHECKPOINT,
               subfolder: str | None = None, device: str | None = None,
               api_key: str | None = None, loader: Callable[[], Any] | None = None) -> FastAPI:
    if not model.strip() or not checkpoint.strip():
        raise ValueError("Model and checkpoint must be non-empty")
    if api_key is not None and (not api_key or any(not 33 <= ord(char) <= 126 for char in api_key)):
        raise ValueError("LAYA_API_KEY must be a non-empty ASCII Bearer token")
    inference_lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.predictor = await run_in_threadpool(
            loader if loader is not None else lambda: load_predictor(checkpoint, subfolder, device)
        )
        try:
            yield
        finally:
            del app.state.predictor

    app = FastAPI(title="Machines Laya Choice bridge", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)

    def authorize(request: Request) -> None:
        if api_key is not None and not hmac.compare_digest(
            request.headers.get("authorization", "").encode(), f"Bearer {api_key}".encode()
        ):
            raise HTTPException(401, "Unauthorized")

    @app.get("/health")
    def health(request: Request) -> dict[str, Any]:
        authorize(request)
        if not hasattr(app.state, "predictor"):
            raise HTTPException(503, "Checkpoint not loaded")
        return {"status": "ready", "service": "machines-laya", "model": model}

    def evaluate(payload: ChoiceRequest) -> dict[str, Any]:
        # Reject concurrent work instead of creating an unbounded inference queue.
        if not inference_lock.acquire(blocking=False):
            raise HTTPException(503, "Laya is busy; no automatic retry")
        try:
            try:
                raw = app.state.predictor.predict(payload.state, payload.questions.model_dump())
            except ContextLimitError:
                raise HTTPException(413, "Request exceeds the checkpoint's untruncated context budget") from None
            except Exception:
                raise HTTPException(500, "Laya inference failed") from None
            try:
                return normalized_response(raw, model, payload.questions.decision.criteria)
            except Exception:
                raise HTTPException(502, "Laya returned an invalid Choice response") from None
        finally:
            inference_lock.release()

    @app.post("/v1/systemone")
    async def system_one(request: Request) -> dict[str, Any]:
        authorize(request)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_REQUEST_BYTES:
                raise HTTPException(413, "Request exceeds 64 KiB")
        try:
            payload = ChoiceRequest.model_validate(json.loads(body))
        except (ValueError, ValidationError, UnicodeError):
            # Default validation errors can echo the original evidence.
            raise HTTPException(422, "Expected one Choice question named decision and string state") from None
        if payload.model != model:
            raise HTTPException(404, "Unknown served model")
        return await run_in_threadpool(evaluate, payload)

    return app


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--model", default="laya", help="Public identifier expected by LAYA_MODEL")
    parser.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT)
    parser.add_argument("--subfolder", default=None)
    parser.add_argument("--device", default=None, help="For example cpu, cuda, or mps")
    args = parser.parse_args()
    api_key = os.environ.get("LAYA_API_KEY")
    if args.host not in ("127.0.0.1", "::1", "localhost") and not api_key:
        parser.error("Non-loopback binding requires LAYA_API_KEY; use a TLS proxy on untrusted networks")
    app = create_app(model=args.model, checkpoint=args.checkpoint, subfolder=args.subfolder,
                     device=args.device, api_key=api_key)
    # One process, one resident model. No auto-reload or request/evidence logging.
    uvicorn.run(app, host=args.host, port=args.port, access_log=False)


if __name__ == "__main__":
    main()
