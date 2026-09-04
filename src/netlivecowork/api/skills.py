"""Skill management routes (local CRUD + remote marketplace pull)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from . import deps
from .schemas.skills import (
    LocalSkillResponse,
    PullSkillResponse,
    RemoteCatalogItem,
    SkillMarketTab,
)
from netlivecowork.providers.capability.skills.adapters import MarketContext
from netlivecowork.providers.capability.skills.adapters import registry as market_registry
from netlivecowork.providers.capability.skills import current_user
from netlivecowork.providers.capability.skills.errors import ERROR_STATUS, SkillError
from netlivecowork.providers.capability.skills.references.presets import ReconcileResult

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/skills", tags=["skills"])


class CurrentUserRequest(BaseModel):
    username: str = ""


def _http(e: SkillError) -> HTTPException:
    return HTTPException(
        status_code=ERROR_STATUS.get(e.code, 400),
        detail={"code": e.code, "message": e.message},
    )


def _refresh_local_skill_runtime() -> None:
    """让本地/引用式 skill 的运行时索引失效：发现索引（模型看得见哪些）+
    按名执行索引（read_file/exec_script 直取路）两层一起，统一走协调器。

    此前这里（和热更新）各复制一段 isinstance(LocalSkillCapabilityProvider) 循环，
    但注册表里的实际对象是 Cowork 包装器——类型判断穿不透包装层，内部目录索引
    从未失效。协调器按失效协议（invalidate_cache()）穿透包装，先 Provider 后 executor。

    best-effort：runtime 未就绪则静默跳过；某个参与者失败不阻断其余（协调器逐项
    隔离并记录），失败留给下一次通知或重启从磁盘恢复。
    """
    rt = deps.get_runtime_optional()
    if rt is None:
        return
    try:
        from netlivecowork.providers.capability.skills.runtime.invalidation import (
            invalidate_local_skill_runtime,
        )
        invalidate_local_skill_runtime(rt.providers)
    except Exception:
        logger.warning("刷新 skill 运行时索引失败", exc_info=True)


# 既有名字保留为别名：5 处调用点的语义都是"持久化/可见性变化后作废索引"。
_mark_skill_index_dirty = _refresh_local_skill_runtime


# ── Local skills ──────────────────────────────────────────────────────────────

@router.post("/import", response_model=LocalSkillResponse)
async def import_local_skill(
    file: UploadFile = File(...),
    coworks: str = Form("*"),
    service=Depends(deps.get_local_skill_service),
) -> LocalSkillResponse:
    """导入一个本地 skill。

    `coworks` 是逗号分隔的归属，缺省 ``*``（通用）。

    **默认通用是有意的**（需求 H6）：用户导入的多数是通用工具，
    默认收窄会让人在别的 cowork 里找不到刚导入的 skill，
    而这个现象与 bug 无法区分。
    """
    data = await file.read()
    try:
        item = service.import_skill(data)
    except SkillError as e:
        raise _http(e)
    labels = _parse_labels(coworks)
    _local_owners().set_labels(item["skill_id"], labels)
    _refresh_local_skill_runtime()   # 文件与归属都已落盘 → 新任务无需重启即可见
    return LocalSkillResponse(**item, coworks=list(labels))


@router.get("", response_model=list[LocalSkillResponse])
def list_local_skills(
    service=Depends(deps.get_local_skill_service),
    ref_store=Depends(deps.get_skill_reference_store),
) -> list[LocalSkillResponse]:
    # 本地自建 skill（origin=local，扫描 skills_dir）+ 云端引用 skill（origin=cloud，
    # 来自引用库，按当前登录用户过滤）。前端据 origin/source 打徽章、区分行为。
    #
    # **本接口不依赖市场服务**：它一度挂着 market=Depends(get_skill_market_service)，
    # 只为问一句"哪些市场按人可见"。而那个依赖在任一市场地址没配时抛错，FastAPI 又是
    # 先解析完依赖才进函数体 —— 于是 mythos 少配一行，整个已装 skill 列表 500，连跟
    # 市场毫无关系的本地 skill 一起看不见。可见性名单改从 registry 静态表取（不碰配置、
    # 不会抛），这个接口就与市场彻底解耦了。
    owners = _local_owners()
    out = [
        LocalSkillResponse(**item, origin="local",
                           coworks=list(owners.labels_of(item["skill_id"])))
        for item in service.list_skills()
    ]
    for r in ref_store.list_visible(
        current_user.get_current_username(), market_registry.per_user_sources()
    ):
        out.append(LocalSkillResponse(
            skill_id=r.key,                       # 不透明 reference_id：删除/改归属都按它路由
            name=r.name,
            description=r.description or "",
            version=r.skill_version or "",
            triggers=r.triggers,
            origin="cloud",
            source=r.source,
            coworks=list(r.labels),               # 有效归属 = manual ∪ preset
        ))
    return out


def _resolve_reference_id(ref_store, skill_id: str) -> str | None:
    """skill_id → 不透明 reference_id（没有则 None，表示这不是一条云端引用）。

    新格式直接命中；旧格式 ``<source>:<remote_id>`` 走库解析——**保留一个发布窗口**，
    升级瞬间前端还揣着旧 ID 的在途状态（已加载列表、报错卡片），不至于突然全操作不了。
    旧 ID 在多个作用域歧义时按"找不到"处理：猜错一家比明确失败更糟。
    """
    if ref_store.get_by_id(skill_id) is not None:
        return skill_id
    if ":" in skill_id:
        source, _, remote_id = skill_id.partition(":")
        try:
            ref = ref_store.get_reference(source, remote_id)
        except ValueError:
            return None
        if ref is not None:
            return ref.key
    return None


@router.post("/{skill_id}/publish", response_model=PullSkillResponse)
def publish_local_skill(
    skill_id: str,
    authorization: str | None = Header(default=None),
    local=Depends(deps.get_local_skill_service),
    cowork=Depends(deps.get_cowork_skill_service),
    ref_store=Depends(deps.get_skill_reference_store),
) -> PullSkillResponse:
    """把一个本地 skill 直接发布到 cowork 市场（本地 skill 卡片上的"上传"按钮）。
    云端引用的 skill 本地无内容，不能发布。auth token 透传给 cowork 写 creator。"""
    # 按**库里有这条引用**判断，不看 ID 里有没有冒号——形状猜测迟早骗人
    # （v3 的 ID 是 hash，也含冒号，但本地 skill 不在引用库里）。
    if _resolve_reference_id(ref_store, skill_id) is not None:
        raise HTTPException(
            status_code=400,
            detail={"code": "CLOUD_SKILL_NOT_PUBLISHABLE", "message": "云端引用的 skill 不能上传"},
        )
    try:
        data, filename = local.read_skill_zip(skill_id)
        return PullSkillResponse(**cowork.import_to_remote(data, filename, MarketContext(auth_header=authorization or "")))
    except SkillError as e:
        # 前端只显示"上传失败"/"已有同名"，真实原因（cowork 报文、网络等）记这里，便于排查。
        logger.warning("发布本地 skill '%s' 失败：[%s] %s", skill_id, e.code, e.message)
        raise _http(e)


@router.delete("/{skill_id}", status_code=204)
def delete_local_skill(
    skill_id: str,
    service=Depends(deps.get_local_skill_service),
    ref_store=Depends(deps.get_skill_reference_store),
    reconciler=Depends(deps.get_profile_skill_preset_reconciler),
) -> None:
    # 引用库里有这条 ID（含旧格式兼容解析）→ 删引用（顺带为预置绑定写 opt-out，不复活）；
    # 否则是本地自建的 → 删本地文件夹。
    reference_id = _resolve_reference_id(ref_store, skill_id)
    if reference_id is not None:
        reconciler.user_delete(reference_id)
        _mark_skill_index_dirty()   # 引用集变化 → 作废索引
        return
    try:
        service.delete_skill(skill_id)
    except SkillError as e:
        raise _http(e)
    _local_owners().forget(skill_id)     # 别留孤儿归属记录
    _refresh_local_skill_runtime()       # 目录与归属清理完成 → 两层索引一起失效


class SetCoworksRequest(BaseModel):
    coworks: list[str] = ["*"]


@router.post("/{skill_id}/coworks", status_code=204)
def set_skill_coworks(
    skill_id: str,
    body: SetCoworksRequest,
    ref_store=Depends(deps.get_skill_reference_store),
    reconciler=Depends(deps.get_profile_skill_preset_reconciler),
) -> None:
    """改一条 skill 的归属（卡片里那个勾选清单）。

    引用库里的 ID（含旧格式兼容解析）→ 改引用的 manual_labels（被移除的预置绑定
    同步 opt-out，下次协调不悄悄加回）；否则是本地导入的 → 改本地那份归属表。
    """
    labels = list(_parse_labels(",".join(body.coworks)))
    reference_id = _resolve_reference_id(ref_store, skill_id)
    if reference_id is not None:
        reconciler.user_set_labels(reference_id, labels)
    else:
        _local_owners().set_labels(skill_id, labels)
    _mark_skill_index_dirty()            # 归属变了 → 可见性变了 → 作废索引


def _local_owners():
    from netlivecowork import paths
    from netlivecowork.providers.capability.skills.references.local_owners import (
        LocalSkillOwners,
    )
    return LocalSkillOwners(paths.data_dir())


def _parse_labels(raw: str) -> tuple[str, ...]:
    """逗号分隔 → 一组标签。**空的一律读成通用**。

    一个都不勾 = 通用，与后端缺省一致（需求 H6）。
    """
    from netlivecowork.providers.capability.skills.references.store import _labels_of
    return _labels_of([s for s in (raw or "").split(",")])


# ── 当前登录用户名（桌面端单用户；供运行时 mythos 过滤/下载用）───────────────────
# electron 登录/切换账号后调用一次，把当前用户名注入后端进程级持有者。运行时（agent
# 执行 mythos skill，无前端请求）从持有者读它 → 列表按用户过滤 + 下载带正确 x-gde-username。

@router.post("/current-user", status_code=204)
def set_current_user(body: CurrentUserRequest) -> None:
    current_user.set_current_username(body.username)
    result = _reconcile_profile_skill_presets(body.username)
    if result.changed:
        _mark_skill_index_dirty()   # 登录/切账号改变可见性或带来预置引用 → 让索引重建


def _reconcile_profile_skill_presets(username: str) -> ReconcileResult:
    """登录/切账号后协调该用户的 profile 预置引用（按用户来源的预置要等 W3 用户名）。

    best-effort：失败不影响登录本身（预置在下次启动/recheck 还会再协调）。
    """
    from netlivecowork.bootstrap.host_runtime import reconcile_profile_skill_presets
    try:
        return reconcile_profile_skill_presets(username)
    except Exception:
        logger.warning("skills：登录后协调 profile 预置引用失败", exc_info=True)
        return ReconcileResult()


# ── Remote marketplace (these MUST be registered before /{skill_id}) ──────────
# 同一组 URL 现在背后是聚合市场（cowork + mythos）。catalog 返回合并列表、每条带
# `source`；pull 的 body 带 `source` + `username`，后端据此派发到对应数据源。
# 上传回市场是 cowork 独有能力（mythos 无上传），仍只走 cowork。

@router.post("/pull-server/import", response_model=PullSkillResponse)
async def import_remote_skill(
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    service=Depends(deps.get_cowork_skill_service),
) -> PullSkillResponse:
    # 把渲染层带来的用户 token（Authorization: Bearer ...）原样转发给 cowork，
    # cowork 的 JwtAuthFilter 据此识别用户并写入 skill 的 creator。无 token 则匿名。
    data = await file.read()
    try:
        return PullSkillResponse(
            **service.import_to_remote(data, file.filename or "skill.zip", MarketContext(auth_header=authorization or ""))
        )
    except SkillError as e:
        raise _http(e)


@router.get("/pull-server/markets", response_model=list[SkillMarketTab])
def list_skill_markets() -> list[SkillMarketTab]:
    """技能市场要开几个页签：通用 + 每个「有独立市场的已开通 cowork」一个。

    通用页签**恒在且恒排第一**，即使通用市场地址没配（那时它是空的）。恒在是因为它是
    "这个 skill 到处都能用"的唯一入口；按配置有无来决定它在不在，会让同一个界面在不同
    部署下少一个页签，而用户无从知道少的是哪个。

    没配市场的 cowork 不开页签——开了也只有一句"它没有专属市场"，白占一格。
    """
    return [
        SkillMarketTab(cowork=None, display_name="通用"),
        *[
            SkillMarketTab(cowork=m.cowork_id, display_name=m.display_name or m.cowork_id)
            for m in market_registry.cowork_markets()
        ],
    ]


@router.get("/pull-server/catalog", response_model=list[RemoteCatalogItem])
def list_remote_catalog(
    username: str = "",
    cowork: str | None = None,
    service=Depends(deps.get_skill_market_service),
) -> list[RemoteCatalogItem]:
    # username 给 mythos 用（其请求头要带当前用户名）；cowork 不需要。mythos 失败
    # 时聚合层只打日志并降级返回 cowork，这里不会因 mythos 抛错而整体失败。
    # 顺带把当前用户名刷进进程级持有者（运行时执行 skill 时用），避免只依赖单独的
    # /current-user 调用。
    if username:
        current_user.set_current_username(username)
        _mark_skill_index_dirty()   # 用户名刷新 → 云端可见性可能变，作废旧索引
    try:
        # cowork 为空 = 通用页签（部署级那几家）；给了就只看那个 cowork 自带的市场。
        return [
            RemoteCatalogItem(**item)
            for item in service.catalog(username, (cowork or "").strip() or None)
        ]
    except SkillError as e:
        raise _http(e)


@router.post("/pull-server/catalog/{remote_id}/pull", response_model=PullSkillResponse)
def pull_skill(
    remote_id: str,
    body: dict,
    service=Depends(deps.get_skill_market_service),
) -> PullSkillResponse:
    skill_name = (body.get("name") or "").strip()
    if not skill_name:
        raise HTTPException(status_code=400, detail={"code": "MISSING_NAME", "message": "name 不能为空"})
    source = (body.get("source") or "").strip()
    if not source:
        raise HTTPException(status_code=400, detail={"code": "MISSING_SOURCE", "message": "source 不能为空"})
    username = (body.get("username") or "").strip()
    # 从哪个页签引的：决定去哪家下载（同一个 source 在不同页签下指向不同服务器），
    # 也决定这条引用的**归属**——通用页签 → `*`，某个 cowork 的页签 → 只给那个 cowork。
    cowork = (body.get("cowork") or "").strip()
    try:
        resp = PullSkillResponse(
            **service.pull(source, remote_id, skill_name, username, cowork or None)
        )
    except SkillError as e:
        raise _http(e)
    _mark_skill_index_dirty()   # 新增引用 → 让新 skill 进索引，可被 read_file/exec_script 找到
    return resp
