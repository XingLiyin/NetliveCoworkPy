"""Skill watcher 接线（任务 3.3 / 4.3 / 4.4）。

3.3：不存在的 Skill 根目录先创建再注册监控（首次空导入不漏监控），agents 行为不变。
4.3：一次回调同时使包装后的本地索引与 executor 索引失效（统一协调器，穿透包装器）。
4.4：真实 watcher 线程 + 短轮询周期下的收敛矩阵。
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from ctx_weft.core.orchestrator.skill_executor_capability import (
    SkillExecutorCapabilityProvider,
)
from ctx_weft.core.runtime import ProviderRegistry
from ctx_weft.protocols.context import ProviderContext
from ctx_weft.providers.capability_skill_local.provider import (
    LocalSkillCapabilityProvider,
)

from netlivecowork.bootstrap.lifecycle import _start_watcher
from netlivecowork.cowork.guards.local_skill import CoworkScopedLocalSkillProvider
from netlivecowork.providers.watcher import skill_tree_stamp


@pytest.fixture(autouse=True)
def _current_event_loop():
    """_start_watcher 用 asyncio.get_event_loop() 取投递目标。生产路径在 lifespan 的
    运行中 loop 里调用没有问题；但 pytest 里任何先行测试的 asyncio.run() 退出时会把
    主线程当前 loop 置空（set_event_loop(None)），再 get_event_loop() 就抛
    "no current event loop"。这里给本文件所有用例兜一个当前 loop。"""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop
    asyncio.set_event_loop(asyncio.new_event_loop())
    loop.close()


# ── 3.3：目录准备与注册 ───────────────────────────────────────────────────────


def _hr(skills_dir: Path, agents_dir: Path | None = None):
    """_start_watcher 只碰 hr.agents_dir / hr.skills_dir / hr.core.providers。"""
    registry = ProviderRegistry()
    core = SimpleNamespace(providers=registry)
    return SimpleNamespace(
        agents_dir=agents_dir or (skills_dir.parent / "agents"),
        skills_dir=skills_dir,
        # None 会让 _start_watcher 直接跳过 agents 监控；给个带 sync 的占位即可注册
        template_syncer=SimpleNamespace(sync=lambda d: _async_zero()),
        core=core,
    )


async def _async_zero() -> int:
    return 0


def test_start_watcher_creates_missing_skills_dir_and_registers(tmp_path: Path) -> None:
    skills = tmp_path / "skills"                     # 不存在
    hr = _hr(skills)
    watcher = _start_watcher(hr)
    try:
        assert skills.is_dir(), "不存在的 Skill 根目录应先创建再注册监控"
        watched = {e[0] for e in watcher._entries}
        assert skills in watched
        # skill 监控用的是递归 stamp，不是根 mtime
        skill_entry = next(e for e in watcher._entries if e[0] == skills)
        assert skill_entry[2] is skill_tree_stamp
    finally:
        watcher.stop()


def test_agents_watcher_unchanged_default_stamp(tmp_path: Path) -> None:
    agents = tmp_path / "agents"
    agents.mkdir()
    hr = _hr(tmp_path / "skills", agents_dir=agents)
    watcher = _start_watcher(hr)
    try:
        agent_entry = next(e for e in watcher._entries if e[0] == agents)
        assert agent_entry[2] == watcher._mtime       # 默认根 mtime，行为不变（绑定方法用 == 比）
    finally:
        watcher.stop()


# ── 4.3：回调一次 → 两层索引同时失效（穿包装） ───────────────────────────────


def test_watcher_callback_invalidates_both_layers_through_wrapper(tmp_path: Path) -> None:
    skills = tmp_path / "skills"
    skills.mkdir()
    registry = ProviderRegistry()
    inner = LocalSkillCapabilityProvider(skills)
    wrapper = CoworkScopedLocalSkillProvider(
        inner, owned_labels_fn=lambda s: None, skill_labels_fn=lambda n: ["*"],
    )
    registry.register_capability(wrapper)
    executor = SkillExecutorCapabilityProvider(registry)
    registry.register_capability(executor)

    hr = _hr(skills)
    hr.core.providers = registry                      # 回调扫的是 hr.core.providers
    watcher = _start_watcher(hr)
    try:
        ctx = ProviderContext(session_id="s")
        asyncio.run(executor._ensure_index(ctx))      # 先预热 executor（此刻为空）
        assert "local_skill__demo" not in executor._index

        (skills / "demo").mkdir()
        (skills / "demo" / "SKILL.md").write_text(
            "---\nname: demo\ndescription: d\n---\n正文", encoding="utf-8")

        # 直接驱动回调（4.4 再用真实线程轮询验证触发时机）
        cb = next(e[1] for e in watcher._entries if e[0] == skills)
        asyncio.run(cb())

        assert inner._index is None                   # 内部目录索引已失效（穿过了包装器）
        assert executor._dirty is True                # executor 已标脏
    finally:
        watcher.stop()


# ── 4.4：真实线程收敛矩阵（短轮询 + 明确超时，不用固定 sleep） ────────────────


def _write(d: Path, name: str, front: str, body: str) -> None:
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"{front}\n{body}", encoding="utf-8")


@pytest.mark.parametrize("scenario", [
    "add", "edit_meta", "edit_body", "invalidate_then_fix", "remove",
])
def test_real_watcher_convergence(tmp_path: Path, scenario: str) -> None:
    skills = tmp_path / "skills"
    skills.mkdir()
    registry = ProviderRegistry()
    inner = LocalSkillCapabilityProvider(skills)
    wrapper = CoworkScopedLocalSkillProvider(
        inner, owned_labels_fn=lambda s: None, skill_labels_fn=lambda n: ["*"],
    )
    registry.register_capability(wrapper)
    executor = SkillExecutorCapabilityProvider(registry)
    registry.register_capability(executor)
    ctx = ProviderContext(session_id="s")

    hr = _hr(skills)
    hr.core.providers = registry

    # 直接构造短周期 watcher（不走 _start_watcher 的 settings 间隔）
    from netlivecowork.providers.watcher import DirectoryWatcher
    from netlivecowork.providers.capability.skills.runtime.invalidation import (
        invalidate_local_skill_runtime,
    )
    watcher = DirectoryWatcher(poll_interval=0.05)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _on_change() -> None:
        invalidate_local_skill_runtime(registry)

    watcher.watch(skills, _on_change, stamp=skill_tree_stamp)
    watcher.start(loop)

    import shutil

    def settle(pred, timeout=8.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            loop.run_until_complete(asyncio.sleep(0.05))
            try:
                if pred():
                    return
            except Exception:
                pass
        raise AssertionError(f"watcher 未在 {timeout}s 内收敛：{scenario}")

    def names():
        return loop.run_until_complete(wrapper.list(ctx))

    def defn(name="demo"):
        return loop.run_until_complete(wrapper.load_definition(name, ctx))

    try:
        if scenario == "add":
            _write(skills / "demo", "demo", "---\nname: demo\ndescription: d\n---", "新增正文")
            settle(lambda: [c.name for c in names()] == ["demo"])
            assert defn() is not None

        elif scenario == "edit_meta":
            _write(skills / "demo", "demo", "---\nname: demo\ndescription: 旧\n---", "x")
            settle(lambda: len(names()) == 1)
            _write(skills / "demo", "demo", "---\nname: demo\ndescription: 新描述\n---", "x")
            settle(lambda: names()[0].description == "新描述")

        elif scenario == "edit_body":
            _write(skills / "demo", "demo", "---\nname: demo\ndescription: d\n---", "旧正文")
            settle(lambda: defn() is not None and "旧正文" in defn().instructions)
            _write(skills / "demo", "demo", "---\nname: demo\ndescription: d\n---", "新正文")
            settle(lambda: "新正文" in (defn().instructions if defn() else ""))

        elif scenario == "invalidate_then_fix":
            (skills / "demo").mkdir()
            (skills / "demo" / "SKILL.md").write_text("不是有效 frontmatter", encoding="utf-8")
            settle(lambda: True)                       # 基线建立（无效文件在场）
            _write(skills / "demo", "demo", "---\nname: demo\ndescription: d\n---", "修复正文")
            settle(lambda: [c.name for c in names()] == ["demo"])

        elif scenario == "remove":
            _write(skills / "demo", "demo", "---\nname: demo\ndescription: d\n---", "x")
            settle(lambda: [c.name for c in names()] == ["demo"])
            shutil.rmtree(skills / "demo")
            settle(lambda: names() == [])
    finally:
        watcher.stop()
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())
