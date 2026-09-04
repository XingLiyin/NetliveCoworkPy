"""DirectoryWatcher 的 stamp 模式（fix-local-skill-runtime-refresh 任务 4.1/4.2）。

默认模式保持根目录 mtime 兼容；skill_tree_stamp 覆盖发现级变化的全部形态，
且不读正文、不跟随符号链接、单项 stat 失败不终止快照。
"""
from __future__ import annotations

from pathlib import Path

from netlivecowork.providers.watcher import DirectoryWatcher, skill_tree_stamp


def _skill(dir_: Path, name: str = "demo", body: str = "# b\n") -> None:
    d = dir_ / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: d\n---\n{body}", encoding="utf-8"
    )


# ── skill_tree_stamp：发现级变化识别 ─────────────────────────────────────────


def test_stamp_detects_new_and_removed_skill_dir(tmp_path: Path) -> None:
    base = skill_tree_stamp(tmp_path)
    _skill(tmp_path, "demo")
    after_add = skill_tree_stamp(tmp_path)
    assert after_add != base
    import shutil
    shutil.rmtree(tmp_path / "demo")
    assert skill_tree_stamp(tmp_path) != after_add
    assert skill_tree_stamp(tmp_path) == base        # 回到空 → 与最初一致


def test_stamp_detects_skill_md_add_edit_and_remove(tmp_path: Path) -> None:
    d = tmp_path / "demo"
    d.mkdir()
    empty = skill_tree_stamp(tmp_path)               # 目录在但没有 SKILL.md
    (d / "SKILL.md").write_text("---\nname: demo\n---\nAAAA", encoding="utf-8")
    with_md = skill_tree_stamp(tmp_path)
    assert with_md != empty
    # 连续写可能落在同一个 mtime tick 且长度巧合相同：显式推 mtime，两条判据各自生效
    (d / "SKILL.md").write_text("---\nname: demo\n---\nB", encoding="utf-8")
    import os
    old_ns = with_md[0][1][1]
    os.utime(d / "SKILL.md", ns=(old_ns, old_ns + 1_000_000))
    assert skill_tree_stamp(tmp_path) != with_md     # mtime/size 变了
    (d / "SKILL.md").unlink()
    assert skill_tree_stamp(tmp_path) == empty        # 删除 → 回到无 SKILL.md 状态


def test_stamp_ignores_scripts_and_resources(tmp_path: Path) -> None:
    """脚本/资源不影响发现身份：改它们不该触发发现级刷新（执行路径本来就读实时文件）。"""
    _skill(tmp_path, "demo")
    base = skill_tree_stamp(tmp_path)
    (tmp_path / "demo" / "scripts").mkdir()
    (tmp_path / "demo" / "scripts" / "run.py").write_text("print('x')", encoding="utf-8")
    (tmp_path / "demo" / "assets.bin").write_bytes(b"\x00" * 128)
    assert skill_tree_stamp(tmp_path) == base


def test_stamp_does_not_follow_symlinks(tmp_path: Path) -> None:
    _skill(tmp_path, "demo")
    base = skill_tree_stamp(tmp_path)
    outside = tmp_path.parent / "outside-skill"
    outside.mkdir(exist_ok=True)
    (outside / "SKILL.md").write_text("---\nname: out\n---\nx", encoding="utf-8")
    link = tmp_path / "linked"
    try:
        link.symlink_to(outside)
    except OSError:                                   # Windows 无符号链接权限时跳过
        return
    assert skill_tree_stamp(tmp_path) == base         # 链接不计入快照


def test_stamp_survives_single_stat_failure(tmp_path: Path) -> None:
    """单项 stat 失败 → 哨兵 + 继续；持续失败不重复触发（哨兵与自身相等、与成功值不等）。"""
    _skill(tmp_path, "demo")
    # 不可访问根 → 哨兵；语义钉住：与任何成功快照不等（修复可触发）、与自身相等
    # （持续失败不重复触发）。打桩 iterdir 而不是造真权限错误（Windows ACL 不可靠）。
    import pytest as _pytest

    def _boom_iterdir(self):
        raise OSError("boom")

    monkeypatch = _pytest.MonkeyPatch()
    monkeypatch.setattr(Path, "iterdir", _boom_iterdir)
    try:
        err1 = skill_tree_stamp(tmp_path)
        err2 = skill_tree_stamp(tmp_path)
    finally:
        monkeypatch.undo()
    assert err1 == ("__stat_error__",)
    assert err1 == err2                                # 持续失败：稳定
    assert err1 != skill_tree_stamp(tmp_path)          # 修复（可访问）→ 与成功快照不等


# ── 默认模式兼容：watch() 不传 stamp 时行为与旧版一致 ────────────────────────


def test_default_watch_uses_root_mtime(tmp_path: Path) -> None:
    w = DirectoryWatcher(poll_interval=0.01)
    assert w._entries == []
    w.watch(tmp_path, callback=None)                  # type: ignore[arg-type]
    assert len(w._entries) == 1
    # 第三元组位是 stamp 函数，缺省应就是 _mtime
    assert w._entries[0][2] == w._mtime


def test_watch_accepts_custom_stamp(tmp_path: Path) -> None:
    w = DirectoryWatcher(poll_interval=0.01)
    w.watch(tmp_path, callback=None, stamp=skill_tree_stamp)  # type: ignore[arg-type]
    assert w._entries[0][2] is skill_tree_stamp
