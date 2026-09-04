"""按 cowork 归属过滤**本地 skill** 的包装层。

# 这一层为什么必须存在

归属这件事原先只做了一半：界面能设、列表能显示、`local_skill_owners.json` 也确实写对了，
但运行时**一点不生效** —— 只有"引用式"那个 provider 接了归属过滤，本地 skill 走的是内核的
`LocalSkillCapabilityProvider`，它扫目录、有什么给什么。

结果是：给一个 skill 设了"只给 IPMaster"，别的 cowork 照样用得上，而界面上那个归属标签
言之凿凿地写着它归谁。**设了等于没设，且没有任何现象提示你**。

# 与 MCP 那个包装的区别

MCP 是**一个 server 一个 provider**，所以"可不可见"是整个 provider 的开关。
本地 skill 是**一个 provider 装着全部** —— 判据下沉到每个 skill 名字。

# 两个坑（与 guards/mcp.py 同源，此处再踩一遍）

## ① 必须是**真子类**

内核建索引时有 `isinstance(p, SkillCapabilityProvider)`，而它是 ABC 不是 Protocol
—— 鸭子类型不算数。写成普通类 + `__getattr__` 透传，会变成"列表里有、就是调不动"。

## ② 六个入口都要管，只改 `list` 等于没做

    retrieve         **模型手里有什么由它说了算** —— 漏了它，隔离等于没做
    list             管理面与路由读它
    load_definition  Level 2：按**名字**取正文
    list_files       Level 3：按名字列目录
    load_resource    Level 3：按名字读文件
    exec_script      Level 3：按名字跑脚本

后四个都以 `skill_name` 为入参 —— 它们是**绕过列表直接按名字拿**的路径。只过滤 `list`
的话，模型确实"看不见"这个 skill，但只要名字被猜到或在别处出现过（历史消息、另一个
cowork 的会话记录、SKILL.md 里的交叉引用），照样能读能跑。看不见 ≠ 拿不到。
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from ctx_weft.protocols.capability import (
    Capability,
    CapabilityProviderInfo,
    SkillCapabilityProvider,
    SkillDefinition,
)
from ctx_weft.protocols.context import ProviderContext

logger = logging.getLogger(__name__)

#: 通配标签 —— 谁都能用。与引用库、local_skill_owners.json 同一套语义。
ANY_LABEL = "*"


class CoworkScopedLocalSkillProvider(SkillCapabilityProvider):
    """把内核的本地 skill provider 包起来，按会话归属逐个 skill 决定可不可见。

    两个函数都由装配层注入，本类**不认识 cowork 也不认识归属库**：

        owned_labels_fn(session_id) -> set[str] | None
            这条会话拥有哪些标签。``None`` = 不设限（历史会话、母版会话、内部任务，
            以及"还没装配好"）。

        skill_labels_fn(skill_name) -> 可迭代的标签
            这个 skill 归谁。没记过的读成通配 —— 存量 skill 一条记录都没有，
            读成"谁都不能用"会让用户已有的 skill 在升级后一夜之间全部消失。
    """

    def __init__(
        self,
        inner: Any,
        owned_labels_fn: Callable[[str | None], set[str] | None],
        skill_labels_fn: Callable[[str], Any],
    ) -> None:
        self._inner = inner
        self._owned_labels_fn = owned_labels_fn
        self._skill_labels_fn = skill_labels_fn

    # ── 身份透传：内核按 name 建索引，包了之后名字不能变 ────────────────────────

    @property
    def name(self) -> str:
        return getattr(self._inner, "name", "skill")

    @property
    def description(self) -> str:
        return getattr(self._inner, "description", "")

    # ── 缓存失效转发 ────────────────────────────────────────────────────────────
    # 显式同步且幂等：__getattr__ 理论上可透传，但显式方法是稳定、可测试的契约，
    # 运行时刷新协调器靠它穿透包装层碰到内部目录索引（isinstance 穿不透包装器）。
    # 归属不在此清：包装器每次经 skill_labels_fn 现读，本就不存标签快照。

    def invalidate_cache(self) -> None:
        invalidate = getattr(self._inner, "invalidate_cache", None)
        if callable(invalidate):
            invalidate()

    # ── 判据 ──────────────────────────────────────────────────────────────────

    def _owned(self, ctx: ProviderContext | None) -> set[str] | None:
        """这条会话拥有哪些标签。取不到一律 ``None``（不过滤）。

        **绝不因此抛错**：归属这一层出问题时，最坏的结果应当是"没做隔离"，
        而不是"skill 全都用不了"。
        """
        try:
            return self._owned_labels_fn(getattr(ctx, "session_id", None))
        except Exception:
            logger.debug("cowork：取会话归属失败，本次不过滤 skill", exc_info=True)
            return None

    def _visible(self, skill_name: str, owned: set[str] | None) -> bool:
        if owned is None:
            return True
        try:
            labels = tuple(self._skill_labels_fn(skill_name) or ())
        except Exception:
            logger.debug("cowork：取 skill %r 的归属失败，按通用处理", skill_name, exc_info=True)
            return True
        if not labels or ANY_LABEL in labels:
            return True
        return bool(set(labels) & owned)

    @staticmethod
    def _name_of(cap: Any) -> str:
        """从 Capability 上取 skill 名字。

        优先用 ``name``；退回从 ``id`` 里取最后一段（形如 ``skill:<name>``）——
        取不到就返回空串，而空串在 ``_visible`` 里按"没记过归属"处理，即放行。
        宁可漏掉一次过滤，也不要因为形状不对而把所有 skill 都挡掉。
        """
        n = getattr(cap, "name", None)
        if n:
            return str(n)
        cid = str(getattr(cap, "id", "") or "")
        return cid.rsplit(":", 1)[-1] if cid else ""

    def _deny(self, skill_name: str, ctx: ProviderContext | None, what: str):
        logger.info(
            "cowork：拦下越权访问 —— 会话 %s 不拥有 skill %r（%s）",
            getattr(ctx, "session_id", None), skill_name, what,
        )
        return PermissionError(f"当前 cowork 没有 {skill_name} 这个 skill")

    # ── 入口①② 列表 ──────────────────────────────────────────────────────────

    async def retrieve(self, ctx: ProviderContext) -> list[Capability]:
        """**模型手里有什么由它说了算。** 漏了它，隔离等于没做。"""
        owned = self._owned(ctx)
        caps = await self._inner.retrieve(ctx)
        if owned is None:
            return caps
        return [c for c in caps if self._visible(self._name_of(c), owned)]

    async def list(self, ctx: ProviderContext) -> list[Capability]:
        owned = self._owned(ctx)
        caps = await self._inner.list(ctx)
        if owned is None:
            return caps
        return [c for c in caps if self._visible(self._name_of(c), owned)]

    # ── 入口③④⑤⑥ 按名字直取 ──────────────────────────────────────────────────

    async def load_definition(
        self, skill_name: str, ctx: ProviderContext,
    ) -> SkillDefinition | None:
        if not self._visible(skill_name, self._owned(ctx)):
            raise self._deny(skill_name, ctx, "load_definition")
        return await self._inner.load_definition(skill_name, ctx)

    async def list_files(
        self, skill_name: str, pattern: str, limit: int, ctx: ProviderContext,
    ) -> str:
        if not self._visible(skill_name, self._owned(ctx)):
            raise self._deny(skill_name, ctx, "list_files")
        return await self._inner.list_files(skill_name, pattern, limit, ctx)

    async def load_resource(
        self, skill_name: str, resource_path: str, ctx: ProviderContext,
    ) -> str:
        if not self._visible(skill_name, self._owned(ctx)):
            raise self._deny(skill_name, ctx, "load_resource")
        return await self._inner.load_resource(skill_name, resource_path, ctx)

    async def exec_script(
        self, skill_name: str, script_path: str, args: str, ctx: ProviderContext,
    ) -> str:
        if not self._visible(skill_name, self._owned(ctx)):
            raise self._deny(skill_name, ctx, "exec_script")
        return await self._inner.exec_script(skill_name, script_path, args, ctx)

    # ── invoke：能力 id 可猜 ─────────────────────────────────────────────────

    def invoke(self, capability_id: str, arguments: dict, ctx: ProviderContext):
        """**能力 id 可猜，看不见不等于拿不到。**"""
        name = str(capability_id or "").rsplit(":", 1)[-1]
        if not self._visible(name, self._owned(ctx)):
            raise self._deny(name, ctx, f"invoke {capability_id}")
        return self._inner.invoke(capability_id, arguments, ctx)

    # ── 其余原样委托 ──────────────────────────────────────────────────────────

    async def describe(self, ctx: ProviderContext) -> CapabilityProviderInfo:
        return await self._inner.describe(ctx)

    async def cancel(self, invocation_id: str, ctx: ProviderContext):
        return await self._inner.cancel(invocation_id, ctx)

    def __getattr__(self, item: str) -> Any:
        """内核将来新增的方法照样能用。

        ⚠ 它兜不住"新方法需要过滤"这件事 —— 那要靠测试比对方法集
        （见 tests/test_cowork_guard_local_skill.py）。这里只保证不会因为少一个方法而崩。
        """
        return getattr(self._inner, item)

    def __repr__(self) -> str:  # pragma: no cover - 排查用
        return f"CoworkScopedLocalSkillProvider({self.name!r})"
