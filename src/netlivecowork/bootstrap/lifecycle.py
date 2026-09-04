"""需要事件循环的那部分启动/收摊。

放在这里而不是 host_runtime 的判据只有一条：**必须跑在运行中的事件循环里**。
  - DB：init_db 是 async，产出的 engine/sessionmaker 绑当前 loop，不能提前在别的 loop 建；
  - 模板同步：async；
  - 目录监视：watcher.start(loop) 要 running loop；
  - MCP 预连接：是个后台 task；
  - 崩溃恢复：async，且要在 DB 之后。
其余（建 provider、注册、挂 authorizer）一律在 host_runtime 里同步做完。

本模块会 import api 层的会话缓存（models.session）。装配根依赖被它接线的层是正常的，
反过来才不行：api 不该知道 DB 什么时候连、skill 目录在哪。
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from netlivecowork.bootstrap.host_runtime import HostRuntime
from netlivecowork.config import get_settings

logger = logging.getLogger(__name__)


@dataclass
class Handles:
    """start_* 的产物，stop() 照着它收摊。"""
    mcp_manager: Any = None
    watcher: Any = None
    mcp_prewarm_task: Any | None = None
    db_persist_handle: Any | None = None
    proj_handle: Any | None = None
    snapshot_handle: Any | None = None
    tele_handle: Any | None = None
    token_usage_handle: Any | None = None
    skill_reporter_handle: Any | None = None
    skill_reporter: Any | None = None


# ── 入口 ──────────────────────────────────────────────────────────────────────


async def start_server(hr: HostRuntime) -> Handles:
    """起服务用：DB + 模板 + MCP 预连接 + 目录监视 + 崩溃恢复。"""
    h = Handles(mcp_manager=hr.mcp_manager)
    # 预连接 MCP server 丢后台跑，不进启动关键路径（见 _start_mcp_prewarm）。
    h.mcp_prewarm_task = _start_mcp_prewarm(hr.mcp_manager)

    state_store = await _start_db(hr, h)
    await _sync_templates(hr)
    h.watcher = _start_watcher(hr)

    if state_store is not None:
        # 顺序要紧：先 recover（core 据事件决策 + emit SessionStatusChanged，投影随之更新），
        # 再 load_sessions_from_db 把投影灌回内存缓存——确保崩溃恢复的 INTERRUPTED/PAUSED_HITL
        # 在内存 entry 里也是最新的。
        await _recover(hr.core, state_store)
        from netlivecowork.api.models.session import load_sessions_from_db
        await load_sessions_from_db(state_store)
        logger.info("Persistence: sessions restored")
    return h


async def start_oneshot(hr: HostRuntime) -> Handles:
    """`ipmc run` 单次任务用：只要 DB 和模板，不装目录监视，也不做会话恢复。"""
    h = Handles(mcp_manager=hr.mcp_manager)
    await _start_db(hr, h)
    await _sync_templates(hr)
    return h


async def stop(handles: Handles) -> None:
    # 放在最前面：Office broker 在冻结态跑的是 app 自己的 exe，留一个就锁着安装目录，
    # 下次装新版会报「无法停止 IPMaster-Cowork」。它还抱着 Office 进程要一起收。
    try:
        from netlivecowork.office_broker import manager as office_manager
        office_manager.stop_all()
    except Exception:
        logger.debug("停 Office broker 失败", exc_info=True)

    if handles.watcher is not None:
        handles.watcher.stop()
    # 先结算后台预连接再拆 provider：否则 start() 还在建连接/起子进程，close_all() 已在
    # 拆同一批 provider。已跑完时 cancel 是 no-op。
    task = handles.mcp_prewarm_task
    if task is not None:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    if handles.mcp_manager is not None:
        await handles.mcp_manager.close_all()
    for handle in (handles.db_persist_handle, handles.proj_handle, handles.snapshot_handle,
                   handles.tele_handle, handles.token_usage_handle,
                   handles.skill_reporter_handle):
        if handle is not None:
            await handle.unsubscribe()
    # 退出时停掉 Datalink 出口的补发任务。**它挂在出口上，不在领域对象上** ——
    # "发不出去的怎么补发"是出口的队列在自我维护，跟"什么算一次 skill 调用"无关。
    from netlivecowork.reporting.sinks.datalink import sink as _datalink_sink
    await _datalink_sink().close()


def make_lifespan(hr: HostRuntime):
    """给 create_app 的 lifespan：api 层只管挂上，不管里面做什么。"""

    @asynccontextmanager
    async def lifespan(_app):
        handles = await start_server(hr)
        yield
        await stop(handles)

    return lifespan


# ── 各步骤 ────────────────────────────────────────────────────────────────────


def _start_mcp_prewarm(mcp_manager: Any) -> asyncio.Task:
    """后台预连接 MCP server，不挡 lifespan。返回的 task 交给 stop 结算。

    不能 await：每个 provider 的 start() 最坏挡 connect_timeout_sec + 5（默认 15s），
    而 Electron 的 waitForBackend 总共只给 30s（electron/main.js:893），且 /health 在
    lifespan 跑完前不响应——内网离线机器上光这一项就够把启动拖挂。预连接对正确性不必要：
    连不上时 agent 路径本来就会惰性重试（见 MCPProviderManager.prewarm_all）。
    """

    async def _run() -> None:
        try:
            await mcp_manager.prewarm_all()
            # 预连接之后紧接着做一次连通性自检：套件下发的 MCP 已经连上（或连不上），
            # 这里把每个的工具清单 / 失败原因打进启动日志。放在同一后台 task 里，同样不挡
            # lifespan；list() 复用 prewarm 刚建好的连接，几乎不额外增加耗时。
            await mcp_manager.probe_transient_and_log()
        except asyncio.CancelledError:
            raise
        except Exception:
            # 失败不致命（与 prewarm_all 内部同策）：这里再兜一层，避免逃逸成
            # "Task exception was never retrieved" 的未捕获异常噪音。
            logger.exception("MCP: 后台预连接/连通性自检失败，转由 agent 路径惰性重连")

    return asyncio.create_task(_run(), name="mcp-prewarm")


async def _start_db(hr: HostRuntime, h: Handles):
    """连 DB、换掉内存 store、订上各路 EventBus 订阅者。返回 state_store（无 DB 时 None）。"""
    if not hr.db_url:
        logger.info("Persistence: in-memory (no DATABASE_URL configured)")
        return None

    from netlivecowork.api.models import session as _sm
    from netlivecowork.api.models.session import set_event_store, set_state_store
    from netlivecowork.observability.telemetry_subscriber import TelemetrySubscriber
    from netlivecowork.persistence.event_persister import EventPersister
    from netlivecowork.persistence.postgres import init_db
    from netlivecowork.persistence.postgres.event_store import PostgresEventStore
    from netlivecowork.persistence.postgres.projection_updater import ProjectionUpdater
    from netlivecowork.persistence.postgres.state_store import PostgresStateStore
    from netlivecowork.providers.capability.skills.runtime.usage import (
        SkillReporter, set_sessions_store,
    )
    from netlivecowork.persistence.snapshot_writer import SnapshotWriter
    from netlivecowork.providers.memory.postgres import PostgresMemoryProvider

    cfg = get_settings()
    snapshot_every_n, snapshot_keep = cfg.snapshot_every_n, cfg.snapshot_keep
    runtime = hr.core

    # 存量导入 —— **必须在 init_db 之前**：它要整个换掉会话库文件，
    # 库一旦连上就换不了了（Windows 上文件还被占着）。
    _import_legacy_if_possible()

    factory = await init_db(hr.db_url)

    # 一次性数据迁移（gated by applied_migrations；已应用则廉价 no-op）。须在 recover /
    # load_sessions_from_db 之前，使恢复出来的会话读到的已是迁移后的干净 memory。
    from netlivecowork.persistence.postgres.migrations import run_pending
    applied = await run_pending(factory)
    if applied:
        logger.info("DB migrations applied: %s", applied)

    state_store = PostgresStateStore(factory)
    event_store = PostgresEventStore(factory, keep_snapshots=snapshot_keep)

    # runtime 构造时默认建了个订阅总线的 InMemoryEventStore；切到 Postgres 前先注销它，
    # 否则它会作为孤儿订阅者继续在内存里堆积所有事件。
    old_store = getattr(runtime, "event_store", None)
    if old_store is not None and hasattr(old_store, "detach"):
        await old_store.detach()

    runtime.event_store = event_store
    runtime.providers.register_memory(PostgresMemoryProvider(factory))

    h.db_persist_handle = runtime.event_bus.subscribe(None, EventPersister(event_store).on_event)
    h.proj_handle = runtime.event_bus.subscribe(None, ProjectionUpdater(factory).on_event)
    h.skill_reporter = SkillReporter()
    h.skill_reporter_handle = runtime.event_bus.subscribe(None, h.skill_reporter.on_event)
    h.snapshot_handle = runtime.event_bus.subscribe(
        None, SnapshotWriter(event_store, every_n_events=snapshot_every_n).on_event
    )
    h.tele_handle = runtime.event_bus.subscribe(None, TelemetrySubscriber().on_event)
    # token 用量上报不再走独立的 EventBus 订阅（异步分发相对 turn_seq 的时序不可控，
    # 见 observability/token_usage_subscriber.py 顶部踩坑记录），改成 SessionEntry.
    # translate_event() 处理 LLM_RESPONSE_FINISHED 时同步调用，这里不用订阅了。
    h.token_usage_handle = None
    logger.info(
        "Snapshots: every %d events (RunFinished boundary), keep %d per session",
        snapshot_every_n, snapshot_keep,
    )

    set_state_store(state_store)
    set_event_store(event_store)
    set_sessions_store(_sm._sessions)  # 注入 session 存储引用
    # 注意：不在此 load_sessions_from_db——须等 recover() 把崩溃恢复的状态写进投影后再灌回内存
    # 缓存（见 start_server）。否则内存 entry 会停在崩溃前的 RUNNING、读不到 INTERRUPTED。

    if hr.template_syncer is not None:
        hr.template_syncer._store.set_session_factory(factory)

    logger.info("Persistence: DB connected (%s)", hr.db_url)
    return state_store


async def _sync_templates(hr: HostRuntime) -> None:
    """启动时把套件的派生状态建起来。

    **走的是 `/coworks/recheck` 同一个函数**（host_runtime.apply_cowork_state）——
    模板索引、套件 LLM 账号、套件自带 MCP、阵容快照，这几样必须两条路一致。
    以前启动一份、recheck 一份，各写各的，于是每加一样 recheck 就漏一样，
    而漏掉的表现全是"装上了但用不了"。清单只留一份，这里不再自己列。
    """
    if hr.template_syncer is None:
        return
    from netlivecowork.bootstrap.host_runtime import apply_cowork_state

    await apply_cowork_state()


def _start_watcher(hr: HostRuntime) -> Any:
    from netlivecowork.providers.watcher import DirectoryWatcher

    watcher = DirectoryWatcher(poll_interval=get_settings().watch_interval)
    agents_dir: Path = hr.agents_dir
    skills_dir: Path = hr.skills_dir

    # ⚠ 目录先建出来再判。全新安装时套件还没落地，这个目录不存在——
    # 而 watch 只在启动这一刻注册一次，错过了就再也不会热更新，
    # 表现是"装上了要重启才看得到"。
    try:
        agents_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    if hr.template_syncer is not None and agents_dir.exists():
        async def _on_agents_change() -> None:
            count = await hr.template_syncer.sync(agents_dir)
            logger.info("Hot reload: re-synced %d template(s) from '%s'", count, agents_dir)
        watcher.watch(agents_dir, _on_agents_change)

    # 与 Provider 注册同一立场：目录不存在就先建（全新环境首次导入依赖 watcher 在位），
    # 建不出来才放弃监控——而不是把"目录还不存在"当成不需要热更新的信号。
    try:
        skills_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        logger.warning("Watcher: 本地 skill 根目录创建失败，跳过 skill 监控：%s",
                       skills_dir, exc_info=True)
    if skills_dir.exists():
        from netlivecowork.providers.capability.skills.runtime.invalidation import (
            invalidate_local_skill_runtime,
        )

        async def _on_skills_change() -> None:
            # 统一协调器：按失效协议穿透 Cowork 包装器（isinstance 穿不透），
            # 两层索引一起失效——与 API 路由同一条路，不再复制类型判断循环。
            invalidate_local_skill_runtime(hr.core.providers)
            logger.info("Hot reload: skill index invalidated for '%s'", skills_dir)
        from netlivecowork.providers.watcher import skill_tree_stamp
        watcher.watch(skills_dir, _on_skills_change, stamp=skill_tree_stamp)

    if watcher._entries:
        watcher.start(asyncio.get_event_loop())
    return watcher


async def _recover(runtime: Any, state_store: Any) -> None:
    # 恢复全在 core 据事件决策、无回调：PAUSED_HITL→就地重建（core 内闭环）；其余→core emit
    # SessionStatusChanged(INTERRUPTED)。该事件由 host 既有订阅者(ProjectionUpdater 写持久投影)
    # 处理;内存缓存随后由 start_server 的 load_sessions_from_db 从投影灌回（故 load 须在 recover 之后）。
    processed = await runtime.recover()
    if processed:
        logger.info("Recovery: processed %d active session(s)", processed)

    # 据事件真相对账失真的投影：投影仍 RUNNING 但事件日志非 active 的会话＝幽灵卡死行（投影写
    # 被吞/丢所致），校正为其终态。须在 recover() 之后——那步已把「真在跑」的转成 INTERRUPTED/
    # PAUSED，此刻残留的 RUNNING 才可安全判定为撒谎。幂等，一致时 no-op。
    from netlivecowork.persistence.postgres.reconcile import reconcile_stranded_running_sessions
    reconciled = await reconcile_stranded_running_sessions(state_store, runtime.event_store)
    if reconciled:
        logger.info("Recovery: reconciled %d stranded RUNNING session(s) to event truth", reconciled)



def _import_legacy_if_possible() -> None:
    """把上一代 IPMaster-Cowork 的数据搬过来 —— 一次性，且**只在新版还是空的时候**。

    三道闸（见 migration/gate.py）：没导过、旧目录在、新版一条会话都没有。
    最后一条把"合并语义"整个挡在外面：走到这里新版必然是空的，COPY 就是 COPY。

    失败不能挡启动：导不进来最坏是用户看不到历史会话，而挡住启动是连新会话都建不了。
    """
    try:
        from netlivecowork import paths
        from netlivecowork.migration import gate
        from netlivecowork.migration.apply import (
            import_legacy,
            legacy_dir_from_env,
            own_session_count,
        )

        legacy = legacy_dir_from_env()
        if legacy is None:
            return                      # 没下发旧目录 = 这个部署没有上一代
        app_data = paths.data_dir().parent
        n = own_session_count(app_data)
        if not gate.can_import(app_data, own_session_count=n):
            if n > 0 and not gate.already_imported(app_data):
                logger.info(
                    "存量导入：新版已有 %d 条会话，按设计不导入（避免合并语义）。旧数据仍在 %s",
                    n, legacy,
                )
            return
        logger.info("存量导入：从 %s 搬到 %s", legacy, app_data)
        res = import_legacy(legacy, app_data)
        gate.mark_imported(app_data)
        logger.info(
            "存量导入完成：搬了 %d 项，跳过 %d 项%s",
            len(res.copied), len(res.skipped),
            ("，失败 %s" % res.failed) if res.failed else "",
        )
    except Exception:
        logger.warning("存量导入失败，跳过（不影响使用）", exc_info=True)
