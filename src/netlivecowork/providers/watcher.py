"""DirectoryWatcher — 后台轮询目录 mtime，变化时触发回调。

设计：
  - daemon 线程，不阻塞 event loop
  - 每个被监控目录关联一个 async 回调（coroutine function）
  - 变化检测到后，通过 asyncio.run_coroutine_threadsafe 投递到主 event loop
  - 支持多目录监控，每个目录独立跟踪 mtime
  - watch() 可注入 stamp 函数：默认仍是根目录 mtime（agents 等既有调用行为不变）；
    skill 树用 ``skill_tree_stamp`` 做受限的递归元数据快照——根目录自身的 mtime
    在"子目录里改 SKILL.md"这类场景下纹丝不动，靠它检测不到任何变化。
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

AsyncCallback = Callable[[], Coroutine[Any, Any, None]]
StampFn = Callable[[Path], Any]

#: 单项 stat 失败的哨兵。与任何成功值不等（跨轮修复能触发）、与自身相等（持续失败
#: 不重复触发）——这正是"正在原子替换的文件不该让监控线程退出"需要的语义。
_STAT_ERROR = ("__stat_error__",)


def skill_tree_stamp(root: Path) -> Any:
    """本地 skill 树的发现级快照：一层 skill 目录 + 各自 SKILL.md 的元数据。

    覆盖：新增/删除 skill 目录、SKILL.md 新增/删除/改内容（mtime+size）、无效文件
    被修复。**不读正文、不跟随符号链接、不递归脚本/资源**——那些由执行路径实时
    读取，不影响 skill 的发现身份；每 tick 遍历大型资源树的代价不可接受。

    返回值只需可比：内容变 ⇒ 快照变。单项 stat 失败记 ``_STAT_ERROR`` 哨兵并继续。
    """
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return _STAT_ERROR

    stamp: list[tuple] = []
    for entry in entries:
        try:
            if entry.is_symlink():
                continue                      # 不跟随符号链接
            if not entry.is_dir():
                continue                      # 根下散落的文件不影响 skill 发现
        except OSError:
            stamp.append((entry.name, _STAT_ERROR))
            continue

        skill_md = entry / "SKILL.md"
        try:
            st = skill_md.stat()
            md = (skill_md.name, st.st_mtime_ns, st.st_size)
        except OSError:
            md = None                          # SKILL.md 不存在/正在替换：None 即哨兵
        stamp.append((entry.name, md))
    return tuple(stamp)


class DirectoryWatcher:
    """轮询一组目录的 mtime，有变化时触发注册的 async 回调。"""

    def __init__(self, poll_interval: float = 5.0) -> None:
        self._interval = poll_interval
        self._entries: list[tuple[Path, AsyncCallback, StampFn]] = []
        self._last_mtimes: dict[str, Any] = {}
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def watch(self, directory: Path, callback: AsyncCallback, *,
              stamp: StampFn | None = None) -> None:
        """注册一个目录及其变化时的 async 回调。可多次调用添加多个监控项。

        ``stamp`` 缺省沿用根目录 mtime（既有调用零变化）；传入自定义函数时按其
        返回值判变化（skill 树用 ``skill_tree_stamp``）。
        """
        self._entries.append((directory, callback, stamp or self._mtime))

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """启动后台监控线程。loop 为主 event loop，用于投递回调。"""
        if self._thread and self._thread.is_alive():
            return
        self._loop = loop
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="directory-watcher",
            daemon=True,
        )
        self._thread.start()
        logger.info(
            "DirectoryWatcher: started (interval=%.1fs, watching %d dir(s))",
            self._interval, len(self._entries),
        )

    def stop(self) -> None:
        """停止监控线程（lifespan 退出时调用）。"""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=self._interval + 1)
        logger.info("DirectoryWatcher: stopped")

    # ── 内部 ──────────────────────────────────────────────────────────────────

    def _mtime(self, path: Path) -> int:
        try:
            return path.stat().st_mtime_ns
        except OSError:
            return 0

    def _run(self) -> None:
        while not self._stop_event.is_set():
            for directory, callback, stamp_fn in self._entries:
                key = str(directory)
                current = stamp_fn(directory)
                if current != self._last_mtimes.get(key):
                    prev = self._last_mtimes.get(key)
                    self._last_mtimes[key] = current
                    if prev is not None and current != 0:   # 跳过首次记录
                        logger.debug("DirectoryWatcher: change detected in '%s'", directory)
                        self._fire(callback)
                    elif prev is None:
                        self._last_mtimes[key] = current   # 初始化基线，不触发
            self._stop_event.wait(self._interval)

    def _fire(self, callback: AsyncCallback) -> None:
        if self._loop is None or not self._loop.is_running():
            return
        future = asyncio.run_coroutine_threadsafe(callback(), self._loop)
        future.add_done_callback(
            lambda f: logger.exception("DirectoryWatcher: callback error")
            if f.exception() else None
        )
