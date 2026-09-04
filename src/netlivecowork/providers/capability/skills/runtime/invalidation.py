"""本地 Skill 运行时缓存失效的统一协调器。

## 为什么要有这一层

本地 skill 有**两层惰性索引**：内核 ``LocalSkillCapabilityProvider`` 的目录索引
（模型看得见哪些 skill）和 ``SkillExecutorCapabilityProvider`` 的按名执行索引
（read_file/exec_script 那条直取路）。两层都要作废，只作废一边的现象是
"管理界面有、智能体说 SKILL_NOT_FOUND"。

此前 API 与热更新各自复制一段 ``isinstance(LocalSkillCapabilityProvider)`` 循环，
但注册表里的实际对象是 Cowork 包装器——类型判断穿不透包装层，内部索引从未失效。
本模块按**失效协议**（可调用的 ``invalidate_cache()``）而非具体类型寻找参与者。

## 语义

- 顺序固定：先对全部 Skill Provider 失效，再标 executor——executor 重建时才不会
  从尚未失效的旧 provider 里拿旧列表。
- 惰性：只切 dirty 状态，不在这里扫盘；下一次能力解析/执行时统一从真实目录重建。
- 容错：逐项隔离异常并计数，一个参与者失败不阻断其余（调用方拿到摘要自行记录）。
- 幂等：重复通知安全，重建结果一致。

依赖方向：本模块只认识"Provider 可迭代对象"，不 import 装配/api 层——
watcher 回调与 API 路由各自把 registry 的 providers 传进来。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Iterable

from ctx_weft.core.orchestrator.skill_executor_capability import (
    SkillExecutorCapabilityProvider,
)
from ctx_weft.protocols.capability import SkillCapabilityProvider

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class InvalidationSummary:
    """刷新结果摘要：调用方用于日志/诊断；不做重试，失败留给下一次通知恢复。"""

    refreshed: int = 0
    failed: list[tuple[str, str]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failed


def invalidate_local_skill_runtime(providers: Iterable[Any]) -> InvalidationSummary:
    """使本地 skill 的发现索引与按名执行索引共同失效（幂等、惰性、逐项容错）。

    ``providers`` 通常是 ``runtime.providers.get_capability_providers()`` 的返回值；
    传 ProviderRegistry 也可（duck-typed ``get_capability_providers``）。
    """
    items = list(providers.get_capability_providers() if hasattr(providers, "get_capability_providers") else providers)

    summary = InvalidationSummary()
    failures: list[tuple[str, str]] = []

    # 第一阶段：Skill Provider 的发现/定义索引（包装与否都按协议穿透）。
    for p in items:
        if not isinstance(p, SkillCapabilityProvider):
            continue
        inv = getattr(p, "invalidate_cache", None)
        if not callable(inv):
            continue
        try:
            inv()
            summary = InvalidationSummary(refreshed=summary.refreshed + 1)
        except Exception as e:  # noqa: BLE001 —— 单个参与者失败不阻断其余
            failures.append((getattr(p, "name", type(p).__name__), repr(e)))
            logger.warning("本地 skill 缓存失效失败：provider=%s", getattr(p, "name", "?"), exc_info=True)

    # 第二阶段：executor 按名执行索引（重建时读取第一阶段已刷新的 provider）。
    for p in items:
        if isinstance(p, SkillExecutorCapabilityProvider):
            try:
                p.mark_dirty()
                summary = InvalidationSummary(refreshed=summary.refreshed + 1)
            except Exception as e:  # noqa: BLE001
                failures.append((getattr(p, "name", type(p).__name__), repr(e)))
                logger.warning("skill executor 标脏失败", exc_info=True)

    return InvalidationSummary(refreshed=summary.refreshed, failed=failures)
