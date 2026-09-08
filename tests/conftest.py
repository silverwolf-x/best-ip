import pytest

from backend.app.sources import ipure_config


@pytest.fixture(autouse=True)
def isolate_local_ipure_config(request, monkeypatch, tmp_path):
    if request.node.get_closest_marker("integration") is None:
        monkeypatch.setattr(ipure_config, "IPURE_CONFIG_PATH", tmp_path / "ipure.yml")
