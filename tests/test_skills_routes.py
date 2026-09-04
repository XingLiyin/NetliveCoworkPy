"""Route layer: error-code -> HTTP status mapping + list happy path."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from netlivecowork.api import skills as skills_api
from netlivecowork.providers.capability.skills.errors import SkillError


class _FakeLocal:
    def __init__(self, listing=None, raises=None):
        self._listing = listing or []
        self._raises = raises

    def list_skills(self):
        return self._listing

    def delete_skill(self, skill_id):
        if self._raises:
            raise self._raises


class _FakeRefStore:
    def __init__(self, refs=None):
        self._refs = list(refs or [])

    def list_visible(self, username, per_user_sources=frozenset()):
        return self._refs

    def get_by_id(self, reference_id):
        return next((r for r in self._refs if r.key == reference_id), None)

    def get_reference(self, source, remote_id):
        got = [r for r in self._refs if r.source == source and r.remote_id == remote_id]
        if len(got) > 1:
            raise ValueError(f"引用 '{source}:{remote_id}' 在多个作用域存在")
        return got[0] if got else None


class _FakeReconciler:
    def __init__(self):
        self.deleted: list = []
        self.labels_set: list = []

    def user_delete(self, reference_id):
        self.deleted.append(reference_id)
        return True

    def user_set_labels(self, reference_id, labels):
        self.labels_set.append((reference_id, tuple(labels)))
        return True

    def user_reference(self, ref, profile_id):
        return ref.key


def _cloud_ref(name="Cloud"):
    from netlivecowork.providers.capability.skills.adapters.scopes import GENERAL_SCOPE
    from netlivecowork.providers.capability.skills.references.store import ReferenceIdentity, SkillReference
    return SkillReference(
        identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "m1"), name=name,
        description="c", triggers=["x"],
    )


def test_list_maps_to_response():
    svc = _FakeLocal(listing=[{
        "skill_id": "a", "name": "A", "description": "d", "version": "1.0", "triggers": ["t"],
    }])
    out = skills_api.list_local_skills(service=svc, ref_store=_FakeRefStore())
    assert out[0].skill_id == "a"
    assert out[0].triggers == ["t"]
    assert out[0].origin == "local"


def test_list_includes_cloud_references():
    ref = _cloud_ref()
    out = skills_api.list_local_skills(service=_FakeLocal(listing=[]), ref_store=_FakeRefStore([ref]))
    assert out[0].origin == "cloud"
    assert out[0].source == "mythos"
    assert out[0].skill_id == ref.key   # v3 起是不透明 reference_id


def test_delete_cloud_reference_uses_opaque_id_and_records_opt_out():
    """删除走 user_delete（顺带写 opt-out），按不透明 ID 路由，不拆冒号。"""
    ref = _cloud_ref()
    rec = _FakeReconciler()
    skills_api.delete_local_skill(
        ref.key, service=_FakeLocal(), ref_store=_FakeRefStore([ref]), reconciler=rec,
    )
    assert rec.deleted == [ref.key]


def test_delete_accepts_legacy_source_colon_remote_id_within_migration_window():
    """旧格式 "source:remote_id" 仍可解析到唯一引用——升级瞬间前端的在途状态不失效。"""
    ref = _cloud_ref()
    rec = _FakeReconciler()
    skills_api.delete_local_skill(
        "mythos:m1", service=_FakeLocal(), ref_store=_FakeRefStore([ref]), reconciler=rec,
    )
    assert rec.deleted == [ref.key]


def test_delete_ambiguous_legacy_id_is_not_a_reference():
    """旧 ID 命中多个作用域 → 按非引用处理（落到本地删除路径），不许猜一家。"""
    from netlivecowork.providers.capability.skills.adapters.scopes import GENERAL_SCOPE
    from netlivecowork.providers.capability.skills.references.store import ReferenceIdentity, SkillReference
    duo = [
        SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "m1"), name="g"),
        SkillReference(identity=ReferenceIdentity("ipmaster", "mythos", "m1"), name="s"),
    ]
    svc = _FakeLocal()
    skills_api.delete_local_skill(
        "mythos:m1", service=svc, ref_store=_FakeRefStore(duo), reconciler=_FakeReconciler(),
    )
    assert svc._listing == []            # 走了本地分支（没炸歧义 ValueError）


def test_delete_not_found_maps_to_404():
    svc = _FakeLocal(raises=SkillError("LOCAL_SKILL_NOT_FOUND", "nope"))
    with pytest.raises(HTTPException) as e:
        skills_api.delete_local_skill(
            "x", service=svc, ref_store=_FakeRefStore(), reconciler=_FakeReconciler(),
        )
    assert e.value.status_code == 404
    assert e.value.detail["code"] == "LOCAL_SKILL_NOT_FOUND"


def test_delete_invalid_id_maps_to_400():
    svc = _FakeLocal(raises=SkillError("LOCAL_SKILL_INVALID_ID", "bad"))
    with pytest.raises(HTTPException) as e:
        skills_api.delete_local_skill(
            "../x", service=svc, ref_store=_FakeRefStore(), reconciler=_FakeReconciler(),
        )
    assert e.value.status_code == 400


def test_set_coworks_uses_opaque_reference_id():
    ref = _cloud_ref()
    rec = _FakeReconciler()
    skills_api.set_skill_coworks(
        ref.key, skills_api.SetCoworksRequest(coworks=["ipmaster"]),
        ref_store=_FakeRefStore([ref]), reconciler=rec,
    )
    assert rec.labels_set == [(ref.key, ("ipmaster",))]


def test_publish_rejects_cloud_by_store_lookup_not_colon_heuristic():
    """发布拒绝云端引用看的是**库里有这条引用**，不是 ID 形状——
    v3 的 hash ID 同样含冒号，形状猜测迟早骗人。"""
    ref = _cloud_ref()
    with pytest.raises(HTTPException) as e:
        skills_api.publish_local_skill(
            ref.key, local=_FakeLocal(), cowork=_FakeCowork(),
            ref_store=_FakeRefStore([ref]),
        )
    assert e.value.status_code == 400
    assert e.value.detail["code"] == "CLOUD_SKILL_NOT_PUBLISHABLE"


class _FakeCowork:
    def import_to_remote(self, data, filename, ctx):
        return {"skill_id": "uploaded", "name": "n"}


class _FakeMarket:
    def __init__(self, result=None, raises=None):
        self._result = result or {}
        self._raises = raises
        self.calls = []

    def per_user_sources(self):
        return {"mythos"}

    def pull(self, source, remote_id, name, username, cowork=None):
        self.calls.append((source, remote_id, name, username, cowork))
        if self._raises:
            raise self._raises
        return self._result


def test_pull_skill_happy_path():
    svc = _FakeMarket(result={"skill_id": "remote-skill", "name": "Remote Skill"})
    out = skills_api.pull_skill(
        "r9", {"name": "Remote Skill", "source": "mythos", "username": "a001"}, service=svc)
    assert out.skill_id == "remote-skill"
    # source/username/cowork 都要原样转下去：cowork 决定去哪家下载，也决定这条引用的归属。
    assert svc.calls == [("mythos", "r9", "Remote Skill", "a001", None)]


def test_pull_skill_blank_name_maps_to_400():
    svc = _FakeMarket()
    with pytest.raises(HTTPException) as e:
        skills_api.pull_skill("r9", {"name": "  ", "source": "cowork"}, service=svc)
    assert e.value.status_code == 400
    assert e.value.detail["code"] == "MISSING_NAME"


def test_pull_skill_missing_source_maps_to_400():
    svc = _FakeMarket()
    with pytest.raises(HTTPException) as e:
        skills_api.pull_skill("r9", {"name": "X"}, service=svc)
    assert e.value.status_code == 400
    assert e.value.detail["code"] == "MISSING_SOURCE"


def test_pull_skill_maps_remote_not_found_to_404():
    svc = _FakeMarket(raises=SkillError("REMOTE_SKILL_NOT_FOUND", "gone"))
    with pytest.raises(HTTPException) as e:
        skills_api.pull_skill("r9", {"name": "X", "source": "cowork"}, service=svc)
    assert e.value.status_code == 404


# ── 任务 2.1：本地导入/删除的成功边界触发统一运行时刷新 ────────────────────────

def test_import_local_skill_refreshes_runtime_after_persist(monkeypatch):
    """成功导入：文件解压 + 归属写入之后刷新一次；导入失败（service 抛）不刷新。"""
    calls: list[str] = []
    monkeypatch.setattr(skills_api, "_refresh_local_skill_runtime", lambda: calls.append("refresh"))

    class _Svc:
        def import_skill(self, data):
            return {"skill_id": "demo", "name": "Demo", "description": "d",
                    "version": "1.0", "triggers": []}

    class _Boom:
        def import_skill(self, data):
            raise SkillError("LOCAL_SKILL_INVALID_ZIP", "bad")

    class _File:
        async def read(self):
            return b"zip-bytes"

    import asyncio

    class _Form:
        pass

    # 成功路径：直接调路由函数（FastAPI Form 依赖在外层，绕开 TestClient）
    out = asyncio.run(skills_api.import_local_skill(
        file=_File(), coworks="ipmaster", service=_Svc(),
    ))
    assert out.skill_id == "demo"
    assert calls == ["refresh"]

    # 失败路径：不刷新（持久化没发生，通知没有意义）
    calls.clear()
    with pytest.raises(HTTPException):
        asyncio.run(skills_api.import_local_skill(
            file=_File(), coworks="*", service=_Boom(),
        ))
    assert calls == []


def test_delete_local_skill_refreshes_runtime_after_persist(monkeypatch):
    """本地删除：目录删除 + 归属清理之后刷新一次；删除失败不刷新。"""
    calls: list[str] = []
    monkeypatch.setattr(skills_api, "_refresh_local_skill_runtime", lambda: calls.append("refresh"))
    monkeypatch.setattr(skills_api, "_local_owners", lambda: type("O", (), {"forget": staticmethod(lambda sid: None)})())

    class _Svc:
        def delete_skill(self, skill_id):
            pass

    class _Boom:
        def delete_skill(self, skill_id):
            raise SkillError("LOCAL_SKILL_NOT_FOUND", "nope")

    skills_api.delete_local_skill("demo", service=_Svc(), ref_store=_FakeRefStore(), reconciler=_FakeReconciler())
    assert calls == ["refresh"]

    calls.clear()
    with pytest.raises(HTTPException):
        skills_api.delete_local_skill("gone", service=_Boom(), ref_store=_FakeRefStore(), reconciler=_FakeReconciler())
    assert calls == []
