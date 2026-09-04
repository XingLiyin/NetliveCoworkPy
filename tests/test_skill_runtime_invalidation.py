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


# ── 2.3 API 级回归：路由自身的刷新路径接到真实运行时 ───────────────────────────


class _FakeImportService:
    """只负责把"zip"落到磁盘——真实 Provider 自己扫目录。"""

    def __init__(self, skills_dir: Path):
        self._dir = skills_dir

    def import_skill(self, data: bytes) -> dict:
        _write_skill(self._dir, "demo", "# API 导入的正文\n")
        return {"skill_id": "demo", "name": "demo", "description": "d",
                "version": "1.0", "triggers": []}

    def delete_skill(self, skill_id: str) -> None:
        import shutil
        shutil.rmtree(self._dir / skill_id)

    def read_skill_zip(self, skill_id: str):
        raise NotImplementedError


class _FakeOwners:
    def __init__(self) -> None:
        self.labels: dict[str, list[str]] = {}

    def set_labels(self, sid: str, labels) -> None:
        self.labels[sid] = list(labels)

    def forget(self, sid: str) -> None:
        self.labels.pop(sid, None)


class _FakeRefStore:
    def get_by_id(self, rid): return None
    def get_reference(self, s, r): return None


class _RuntimeStub:
    """路由刷新入口只认 rt.providers——把真实 registry 挂上去。"""

    def __init__(self, registry) -> None:
        self.providers = registry


def _wire_runtime(monkeypatch, registry, owners):
    from netlivecowork.api import deps as deps_mod
    from netlivecowork.api import skills as skills_api

    monkeypatch.setattr(deps_mod, "get_runtime_optional", lambda: _RuntimeStub(registry))
    monkeypatch.setattr(skills_api, "_local_owners", lambda: owners)


def test_api_import_then_delete_roundtrip_without_restart(primed, monkeypatch):
    """缓存预热 → import 路由 → SkillExecutor 按名读到正文 → delete 路由 → 一致消失。
    全程不重建 runtime、不手工调用失效函数——走的就是路由自己的刷新路径。"""
    from netlivecowork.api import skills as skills_api
    from netlivecowork.providers.capability.skills.errors import SkillError  # noqa: F401

    skills_dir, registry, inner, wrapper, executor, ctx = primed
    owners = _FakeOwners()
    _wire_runtime(monkeypatch, registry, owners)
    svc = _FakeImportService(skills_dir)

    import asyncio

    class _File:
        async def read(self):
            return b"zip"

    asyncio.run(skills_api.import_local_skill(file=_File(), coworks="*", service=svc))

    async def after_import():
        await executor._ensure_index(ctx)               # 按名执行索引重建
        entry = executor._index.get("local_skill__demo")
        assert entry is not None, "导入后 executor 按名索引应包含新 skill"
        provider, bare = entry
        d = await provider.load_definition(bare, ctx)
        assert d is not None and "API 导入的正文" in d.instructions
    asyncio.run(after_import())

    skills_api.delete_local_skill("demo", service=svc, ref_store=_FakeRefStore(),
                                  reconciler=type("R", (), {
                                      "user_delete": staticmethod(lambda rid: True),
                                      "user_set_labels": staticmethod(lambda rid, l: True),
                                      "user_reference": staticmethod(lambda ref, pid: ""),
                                  })())

    async def after_delete():
        assert (await wrapper.list(ctx)) == []
        await executor._ensure_index(ctx)
        assert "local_skill__demo" not in executor._index
    asyncio.run(after_delete())


# ── 2.4 归属切换：通用 ↔ 限定，相交/不相交会话的可见性随刷新生效 ───────────────


def test_visibility_flips_with_label_change(primed, monkeypatch):
    skills_dir, registry, inner, wrapper, executor, ctx = primed
    _write_skill(skills_dir, "demo")
    owners: dict[str, list[str]] = {"demo": ["*"]}
    wrapper._skill_labels_fn = lambda name: owners.get(name, ["*"])

    invalidate_local_skill_runtime(registry)

    async def owned(session_labels):
        wrapper._owned_labels_fn = lambda s: set(session_labels)
        return [c.name for c in await wrapper.list(ctx)]

    import asyncio
    assert asyncio.run(owned(None)) == ["demo"]            # 不设限：可见（预热+通用）

    owners["demo"] = ["ipmaster"]                           # 通用 → 限定
    invalidate_local_skill_runtime(registry)
    assert asyncio.run(owned({"ipmaster"})) == ["demo"]     # 相交：可见
    assert asyncio.run(owned({"mbb"})) == []                # 不相交：不可见

    owners["demo"] = ["*"]                                  # 恢复通用
    invalidate_local_skill_runtime(registry)
    assert asyncio.run(owned({"mbb"})) == ["demo"]          # 又可见
