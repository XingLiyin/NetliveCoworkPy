"""Host LLM adapter subclasses.

Override core adapter seams for internal-deployment concerns without modifying
ctx_weft:
  - OpenAI chat-endpoint inference (_chat_url)
  - OpenAI-compatible reasoning dialect normalization
  - corporate-CA SSL (_make_client)  ← added in the SSL phase
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

from ctx_weft.providers.llm.anthropic import AnthropicAdapter
from ctx_weft.providers.llm.openai import OpenAIAdapter

_VERSION_SEG = re.compile(r"v\d+", re.IGNORECASE)
_SSE_DATA_PREFIX = "data: "
_DONE_LINE = "data: [DONE]"
_REASONING_KEYS = ("reasoning_content", "reasoning", "thinking")
_REASONING_MARKERS = ('"reasoning"', '"thinking"')


def _first_reasoning(*containers: Any) -> str:
    """First non-empty reasoning text among containers, dialect priority order."""
    for container in containers:
        if not isinstance(container, dict):
            continue
        for key in _REASONING_KEYS:
            value = container.get(key)
            if isinstance(value, str) and value:
                return value
    return ""


class _ReasoningHold:
    """Per-stream buffer for reasoning delivered outside ``delta``.

    Gateways that stream the non-streaming shape (aigateway doc: full
    ``chat.completion`` objects carrying ``message.reasoning``) resend
    cumulative text, others may send fragments.  Hold the best-guess full
    text — replace when the new value extends the old, concatenate otherwise
    — and inject it once when the stream ends.  Never guessing mid-stream
    keeps genuine incremental streams intact.
    """

    __slots__ = ("held", "delta_seen")

    def __init__(self) -> None:
        self.held = ""
        self.delta_seen = False

    def observe(self, text: str) -> None:
        if not text or self.delta_seen:
            return
        if self.held and text.startswith(self.held):
            self.held = text
        elif self.held:
            self.held += text
        else:
            self.held = text

    def take(self) -> str:
        held, self.held = self.held, ""
        return held


def _normalize_reasoning_sse_line(line: str, hold: _ReasoningHold) -> str:
    """Surface reasoning from any OpenAI-compatible dialect onto ``delta``.

    ctx_weft's parser reads only ``choices[0].delta.reasoning_content``, so
    every known dialect is normalized onto that one seam:
      - ``delta.reasoning_content`` (DeepSeek) passes through untouched;
      - ``delta.reasoning`` (vLLM) is moved onto ``reasoning_content``;
      - reasoning outside ``delta`` (``message.*`` / event level) is held and
        injected once at stream end by the caller.
    """
    if not line.startswith(_SSE_DATA_PREFIX):
        return line
    if not any(marker in line for marker in _REASONING_MARKERS):
        return line

    try:
        event = json.loads(line[len(_SSE_DATA_PREFIX):])
    except json.JSONDecodeError:
        return line
    if not isinstance(event, dict):
        return line

    choices = event.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
    if choice is None:
        return line

    delta = choice.get("delta")
    if not isinstance(delta, dict):
        delta = {}
    if isinstance(delta.get("reasoning_content"), str) and delta["reasoning_content"]:
        return line  # native DeepSeek dialect — the parser reads it as-is

    live = _first_reasoning(delta)
    if live:
        if not hold.delta_seen:
            hold.delta_seen = True
            hold.held = ""  # delta carries the reasoning live; drop any held copy
        delta["reasoning_content"] = live
        if choice.get("delta") is not delta:
            choice["delta"] = delta
        return _SSE_DATA_PREFIX + json.dumps(event, ensure_ascii=False, separators=(",", ":"))

    hold.observe(_first_reasoning(choice.get("message"), event))
    return line


class _ReasoningCompatResponse:
    """Response facade that changes only OpenAI-compatible SSE data lines."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self._hold = _ReasoningHold()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._response, name)

    @staticmethod
    def _held_line(text: str) -> str:
        synth = {"choices": [{"index": 0, "delta": {"reasoning_content": text}}]}
        return _SSE_DATA_PREFIX + json.dumps(synth, ensure_ascii=False, separators=(",", ":"))

    async def aiter_lines(self) -> AsyncIterator[str]:
        async for line in self._response.aiter_lines():
            if line == _DONE_LINE:
                text = self._hold.take()
                if text:
                    yield self._held_line(text)
                yield line
                continue
            yield _normalize_reasoning_sse_line(line, self._hold)
        text = self._hold.take()  # stream ended without [DONE]
        if text:
            yield self._held_line(text)


class _ReasoningCompatClient(httpx.AsyncClient):
    """httpx client that normalizes only streamed reasoning events."""

    @asynccontextmanager
    async def stream(self, *args: Any, **kwargs: Any) -> AsyncIterator[_ReasoningCompatResponse]:
        async with super().stream(*args, **kwargs) as response:
            yield _ReasoningCompatResponse(response)


def _resolve_chat_url(base: str) -> str:
    """Infer the chat-completions endpoint from a configured base_url.

    - already a full endpoint (.../chat/completions) → unchanged
    - ends with a version segment (/v1, /paas/v4)     → append /chat/completions
    - bare host (https://api.openai.com)              → append /v1/chat/completions
    """
    b = base.rstrip("/")
    if b.lower().endswith("/chat/completions"):
        return b
    last = b.rsplit("/", 1)[-1]
    if _VERSION_SEG.fullmatch(last):
        return f"{b}/chat/completions"
    return f"{b}/v1/chat/completions"


def _resolve_verify(ssl_verify):
    """httpx verify arg: bool / ssl.SSLContext / CA-bundle path.

    Defaults to True (secure) only when ssl_verify is None; an explicit False
    disables verification (internal/self-signed endpoints).
    """
    return ssl_verify if ssl_verify is not None else True


class HostOpenAIAdapter(OpenAIAdapter):
    def __init__(self, *args, ssl_verify: bool | str = False, **kwargs) -> None:
        # Set before super().__init__: the core ctor calls self._make_client().
        self._ssl_verify = ssl_verify
        super().__init__(*args, **kwargs)

    def _chat_url(self) -> str:
        return _resolve_chat_url(self._base_url)

    def _make_client(self) -> httpx.AsyncClient:
        return _ReasoningCompatClient(
            timeout=self._timeout,
            trust_env=False,
            verify=_resolve_verify(self._ssl_verify),
        )


class HostAnthropicAdapter(AnthropicAdapter):
    def __init__(self, *args, ssl_verify: bool | str = False, **kwargs) -> None:
        self._ssl_verify = ssl_verify
        super().__init__(*args, **kwargs)

    def _make_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=self._timeout, trust_env=False, verify=_resolve_verify(self._ssl_verify))
