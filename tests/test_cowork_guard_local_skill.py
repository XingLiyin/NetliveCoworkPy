"""本地 skill 的 cowork 归属隔离（guards/local_skill.py）。

这个洞真出过：界面能设归属、列表能显示、`local_skill_owners.json` 也写对了，
**但运行时一点不生效** —— 只有引用式 provider 接了过滤，本地 skill 走内核那个
provider，扫目录、有什么给什么。表现是「设了等于没设，且没有任何现象提示」。

所以这里逐条钉的是"读的那一侧"：六个入口都要认归属，少一个就有一条绕过去的路。
"""
from __future__ import annotations

import inspect

import pytest
from ctx_weft.protocols.capability import SkillCapabilityProvider

from netlivecowork.cowork.guards import CoworkScopedLocalSkillProvider


class _Cap:
    def __init__(self, name: str) -> None:
        self.name = name
        self.id = f"skill:{name}"


class _FakeInner(SkillCapabilityProvider):
    """假的内核 provider：有什么给什么，不认识归属（这正是被包的那一个的行为）。"""

    name = "skill"
    description = ""

    def __init__(self, names=("docx", "topology-drawing")) -> None:
        self._names = list(names)
        self.calls: list[tuple[str, str]] = []

    async def list(self, ctx):
        return [_Cap(n) for n in self._names]

    async def retrieve(self, ctx):
        return [_Cap(n) for n in self._names]

    async def describe(self, ctx):
        return "info"

    def invoke(self, capability_id, arguments, ctx):
        self.calls.append(("invoke", capability_id))
        return "ran"

    async def cancel(self, invocation_id, ctx):
        return True

    async def load_definition(self, skill_name, ctx):
        self.calls.append(("load_definition", skill_name))
        return "body"

    async def list_files(self, skill_name, pattern, limit, ctx):
        self.calls.append(("list_files", skill_name))
        return "files"

    async def load_resource(self, skill_name, resource_path, ctx):
        self.calls.append(("load_resource", skill_name))
        return "res"

    async def exec_script(self, skill_name, script_path, args, ctx):
        self.calls.append(("exec_script", skill_name))
        return "out"


class _Ctx:
    def __init__(self, session_id="ses_1") -> None:
        self.session_id = session_id


#: 归属表：topology-drawing 只给 ipmaster，docx 没记过（= 通用）。
LABELS = {"topology-drawing": ("ipmaster",)}


def _guard(inner=None, owned=frozenset({"sitemaster"}), labels=None):
    return CoworkScopedLocalSkillProvider(
        inner or _FakeInner(),
        owned_labels_fn=lambda sid: None if owned is None else set(owned),
        skill_labels_fn=(labels if labels is not None else LABELS).get,
    )


# ── 结构：两个坑 ─────────────────────────────────────────────────────────────


def test_it_is_a_real_subclass_not_a_lookalike():
    """内核建索引时是 `isinstance` 而不是鸭子类型——不是真子类的话，
    本地 skill 会整个从索引里消失，表现成「列表里有、就是调不动」。"""
    assert isinstance(_guard(), SkillCapabilityProvider)


def test_the_wrapper_covers_every_public_method_of_the_protocol():
    """**内核长出新方法就会静默漏一个洞。**

    内核以只读 wheel 交付且在持续更新。哪天协议多一个方法而包装器没覆盖，
    调用直接落到被包的 provider 上——隔离静默失效，没有任何报错。
    这条测试的价值在升级内核的那一刻才显现，而那正是没人会想起检查的时刻。
    """
    protocol = {n for n, _ in inspect.getmembers(SkillCapabilityProvider, callable)
                if not n.startswith("_")}
    ours = {n for n, _ in inspect.getmembers(CoworkScopedLocalSkillProvider, callable)
            if not n.startswith("_")}
    missing = protocol - ours
    assert missing == set(), (
        f"包装器没覆盖协议里的这些方法：{sorted(missing)}\n漏掉的会绕过隔离，且不报错"
    )


def test_the_name_is_passed_through():
    """内核按 name 建索引，包了之后名字不能变。"""
    assert _guard().name == "skill"


# ── 入口①② 列表 ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_retrieve_hides_a_skill_owned_by_another_cowork():
    """**模型手里有什么由 retrieve 说了算。** 漏了它，隔离等于没做。"""
    caps = await _guard().retrieve(_Ctx())
    assert [c.name for c in caps] == ["docx"]


@pytest.mark.asyncio
async def test_list_hides_it_too():
    caps = await _guard().list(_Ctx())
    assert [c.name for c in caps] == ["docx"]


@pytest.mark.asyncio
async def test_the_owning_cowork_still_sees_it():
    caps = await _guard(owned={"ipmaster"}).retrieve(_Ctx())
    assert sorted(c.name for c in caps) == ["docx", "topology-drawing"]


@pytest.mark.asyncio
async def test_a_skill_with_no_record_is_common():
    """存量 skill 一条记录都没有。读成"谁都不能用"会让用户已有的 skill
    在升级后一夜之间全部消失。"""
    caps = await _guard(labels={}).retrieve(_Ctx())
    assert sorted(c.name for c in caps) == ["docx", "topology-drawing"]


@pytest.mark.asyncio
async def test_wildcard_is_visible_everywhere():
    caps = await _guard(labels={"topology-drawing": ("*",)}).retrieve(_Ctx())
    assert sorted(c.name for c in caps) == ["docx", "topology-drawing"]


@pytest.mark.asyncio
async def test_no_owner_info_means_no_filtering():
    """历史会话、母版会话、内部任务，以及"还没装配好"——一律不过滤。
    收紧的话它们会突然少掉一批 skill，而那是静默的功能倒退。"""
    caps = await _guard(owned=None).retrieve(_Ctx())
    assert sorted(c.name for c in caps) == ["docx", "topology-drawing"]


# ── 入口③④⑤⑥ 按名字直取：看不见 ≠ 拿不到 ────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("call", [
    lambda g, ctx: g.load_definition("topology-drawing", ctx),
    lambda g, ctx: g.list_files("topology-drawing", "*", 10, ctx),
    lambda g, ctx: g.load_resource("topology-drawing", "a.md", ctx),
    lambda g, ctx: g.exec_script("topology-drawing", "s.py", "", ctx),
])
async def test_by_name_access_is_denied(call):
    """只过滤列表的话，模型确实"看不见"，但名字一旦出现过（历史消息、另一个 cowork
    的会话记录、SKILL.md 里的交叉引用）照样能读能跑。"""
    inner = _FakeInner()
    with pytest.raises(PermissionError):
        await call(_guard(inner), _Ctx())
    assert inner.calls == []          # 根本没走到内核那一层


@pytest.mark.asyncio
async def test_by_name_access_still_works_for_the_owner():
    inner = _FakeInner()
    out = await _guard(inner, owned={"ipmaster"}).load_definition("topology-drawing", _Ctx())
    assert out == "body"
    assert inner.calls == [("load_definition", "topology-drawing")]


def test_invoke_is_denied_by_capability_id():
    """**能力 id 可猜，看不见不等于拿不到。**"""
    inner = _FakeInner()
    with pytest.raises(PermissionError):
        _guard(inner).invoke("skill:topology-drawing", {}, _Ctx())
    assert inner.calls == []


def test_invoke_passes_through_for_the_owner():
    inner = _FakeInner()
    assert _guard(inner, owned={"ipmaster"}).invoke("skill:topology-drawing", {}, _Ctx()) == "ran"


# ── 绝不因归属这一层而挂 ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_broken_owner_lookup_costs_isolation_not_the_skills():
    """归属这一层出问题时，最坏的结果应当是"没做隔离"，而不是"skill 全都用不了"。"""
    def boom(_name):
        raise RuntimeError("归属库读不动")

    g = CoworkScopedLocalSkillProvider(
        _FakeInner(), owned_labels_fn=lambda sid: {"sitemaster"}, skill_labels_fn=boom,
    )
    caps = await g.retrieve(_Ctx())
    assert sorted(c.name for c in caps) == ["docx", "topology-drawing"]


@pytest.mark.asyncio
async def test_a_broken_session_lookup_also_falls_open():
    def boom(_sid):
        raise RuntimeError("scope 还没装好")

    g = CoworkScopedLocalSkillProvider(
        _FakeInner(), owned_labels_fn=boom, skill_labels_fn=LABELS.get,
    )
    assert len(await g.retrieve(_Ctx())) == 2


@pytest.mark.asyncio
async def test_unknown_attributes_fall_through():
    inner = _FakeInner()
    inner.some_new_kernel_method = lambda: 42
    assert _guard(inner).some_new_kernel_method() == 42


def test_invalidate_cache_forwards_exactly_once_to_inner():
    """缓存失效转发：协调器靠这个契约穿透包装层碰到内部目录索引（isinstance 穿不透）。
    显式方法而非只靠 __getattr__——稳定、可测试，类型工具也看得见。"""
    inner = _FakeInner()
    calls: list[str] = []
    inner.invalidate_cache = lambda: calls.append("inner")
    g = CoworkScopedLocalSkillProvider(
        inner, owned_labels_fn=lambda s: None, skill_labels_fn=LABELS.get,
    )
    g.invalidate_cache()
    g.invalidate_cache()          # 幂等语义由内部实现承担，转发本身可重复调用
    assert calls == ["inner", "inner"]
