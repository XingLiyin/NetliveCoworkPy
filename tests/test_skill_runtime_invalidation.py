"""本地 Skill 运行时缓存失效（fix-local-skill-runtime-refresh）。

核心回归不用 mock：真实 LocalSkillCapabilityProvider + CoworkScopedLocalSkillProvider +
ProviderRegistry + SkillExecutorCapabilityProvider，先预热两层索引，再改磁盘、触发统一刷新，
断言新任务无需重启即可读到——这正是线上"管理界面有、智能体说没有"的复现路径。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from ctx_weft.core.orchestrator.skill_executor_capability import (
    SkillExecutorCapabilityProvider,
)
from ctx_weft.core.runtime import ProviderRegistry
from ctx_weft.protocols.context import ProviderContext
from ctx_weft.providers.capability_skill_local.provider import (
    LocalSkillCapabilityProvider,
)

from netlivecowork.cowork.guards.local_skill import CoworkScopedLocalSkillProvider
from netlivecowork.providers.capability.skills.runtime.invalidation import (
    invalidate_local_skill_runtime,
)


def _write_skill(skills_dir: Path, name: str = "demo", body: str = "# 使用 demo\n") -> None:
    d = skills_dir / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name} 的描述\n---\n{body}", encoding="utf-8"
    )


def _runtime(skills_dir: Path, labels: dict[str, list[str]] | None = None):
    """真实装配：registry + executor + Cowork 包装后的本地 Provider。"""
    registry = ProviderRegistry()
    inner = LocalSkillCapabilityProvider(skills_dir)
    wrapper = CoworkScopedLocalSkillProvider(
        inner,
        owned_labels_fn=lambda session_id: None,   # 不设限（历史/内部会话的语义）
        skill_labels_fn=lambda name: labels.get(name, ["*"]) if labels else ["*"],
    )
    registry.register_capability(wrapper)
    executor = SkillExecutorCapabilityProvider(registry)
    registry.register_capability(executor)
    return registry, inner, wrapper, executor


@pytest.fixture
def primed(tmp_path: Path):
    """预热两层索引的空环境（list 过一次 = 两层缓存都已建立）。"""
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    registry, inner, wrapper, executor = _runtime(skills_dir)
    ctx = ProviderContext(session_id="s1")

    async def warm():
        assert (await wrapper.list(ctx)) == []          # 本地索引预热（空）
        await executor._ensure_index(ctx)               # executor 索引预热（空）
    asyncio.run(warm())
    return skills_dir, registry, inner, wrapper, executor, ctx


# ── 1.1 主回归：统一刷新让新 Skill 立即可读 ───────────────────────────────────


def test_refresh_after_primed_cache_makes_new_local_skill_readable(primed):
    skills_dir, registry, inner, wrapper, executor, ctx = primed
    _write_skill(skills_dir, "demo", "# 使用 demo\n正文一句话")

    invalidate_local_skill_runtime(registry)

    async def go():
        caps = await wrapper.list(ctx)
        assert [c.name for c in caps] == ["demo"]
        d = await wrapper.load_definition("demo", ctx)
        assert d is not None and "正文一句话" in d.instructions
        # executor 按名执行索引也吃到了新状态
        await executor._ensure_index(ctx)
        assert "local_skill__demo" in executor._index
    asyncio.run(go())


def test_refresh_after_delete_makes_old_name_consistently_missing(primed):
    skills_dir, registry, inner, wrapper, executor, ctx = primed
    _write_skill(skills_dir, "demo")
    invalidate_local_skill_runtime(registry)

    import shutil
    shutil.rmtree(skills_dir / "demo")
    invalidate_local_skill_runtime(registry)

    async def go():
        assert (await wrapper.list(ctx)) == []
        assert await wrapper.load_definition("demo", ctx) is None   # 内核语义：未找到 → None
        await executor._ensure_index(ctx)
        assert "local_skill__demo" not in executor._index
    asyncio.run(go())


def test_refresh_survives_metadata_and_body_edits(primed):
    skills_dir, registry, inner, wrapper, executor, ctx = primed
    _write_skill(skills_dir, "demo", "旧正文")
    invalidate_local_skill_runtime(registry)

    (skills_dir / "demo" / "SKILL.md").write_text(
        "---\nname: demo\ndescription: 新描述\n---\n新正文", encoding="utf-8"
    )
    invalidate_local_skill_runtime(registry)

    async def go():
        d = await wrapper.load_definition("demo", ctx)
        assert d is not None and "新正文" in d.instructions
        caps = await wrapper.list(ctx)
        assert caps[0].description == "新描述"
    asyncio.run(go())


# ── 1.4 幂等 / 隔离 / 异常不阻断 / 顺序 ─────────────────────────────────────


def test_repeated_refresh_is_idempotent(primed):
    skills_dir, registry, *_ = primed
    _write_skill(skills_dir)
    invalidate_local_skill_runtime(registry)
    invalidate_local_skill_runtime(registry)      # 重复通知：幂等，结果一致

    async def go():
        wrapper = primed[3]
        caps = await wrapper.list(primed[5])
        assert [c.name for c in caps] == ["demo"]
    asyncio.run(go())


def test_non_skill_providers_are_not_touched(primed):
    """协调器只对失效契约调用；普通工具 Provider 不被鸭子类型误伤。"""
    registry = primed[1]

    class FakeTool:
        name = "fake_tool"

        def invalidate_cache(self):  # 有同名方法也不是 SkillCapabilityProvider，不该被调
            raise AssertionError("非 Skill Provider 不应被调用")

    registry.register_capability(FakeTool())      # type: ignore[arg-type]
    invalidate_local_skill_runtime(registry)      # 不抛 = 没碰它


def test_one_participant_failure_does_not_block_others(primed, monkeypatch):
    skills_dir, registry, inner, wrapper, executor, ctx = primed
    _write_skill(skills_dir, "demo")
    boom = RuntimeError("participant boom")

    def exploding_invalidate():
        raise boom

    monkeypatch.setattr(wrapper, "invalidate_cache", exploding_invalidate)

    summary = invalidate_local_skill_runtime(registry)
    assert len(summary.failed) >= 1
    assert summary.ok is False
    # executor 仍被标脏：另一个参与者的失败没有中断循环
    assert executor._dirty is True


def test_providers_invalidated_before_executor(primed):
    """顺序：先把全部 Skill Provider 标脏，再标 executor——executor 重建时才不会
    从尚未失效的旧 provider 索引里拿旧列表。"""
    skills_dir, registry, inner, wrapper, executor, ctx = primed
    order: list[str] = []

    # 记录调用顺序：包装器失效 → executor 标脏
    orig_wrapper_inv = wrapper.invalidate_cache
    def wrapper_spy():
        order.append("wrapper")
        orig_wrapper_inv()
    wrapper.invalidate_cache = wrapper_spy

    orig_dirty = executor.mark_dirty
    def dirty_spy():
        order.append("executor")
        orig_dirty()
    executor.mark_dirty = dirty_spy

    invalidate_local_skill_runtime(registry)
    assert order == ["wrapper", "executor"]
