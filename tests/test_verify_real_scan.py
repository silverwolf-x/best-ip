from __future__ import annotations

import pytest

from scripts.verify_real_scan import (
    _cancel_scan,
    _contains_forbidden_value,
    _credential_values,
    _require_no_failed_nodes,
    _subscription_url_values,
    _validate_local_api_base,
)


def test_credential_values_extracts_only_secret_fields() -> None:
    content = b"""
proxies:
  - name: visible-node
    type: vless
    uuid: 11111111-2222-3333-4444-555555555555
    username: u
  - name: second-node
    type: ss
    password: secret-password
    auth_str: auth-value
    obfs-password: obfs-value
    pre-shared-key: wireguard-value
    private-key-passphrase: key-passphrase
    ws-opts:
      headers:
        Authorization: Bearer header-token
        Cookie: session=cookie-token
external-controller: 127.0.0.1:9090
secret: controller-secret
"""

    assert _credential_values(content) == {
        "11111111-2222-3333-4444-555555555555",
        "u",
        "secret-password",
        "auth-value",
        "obfs-value",
        "wireguard-value",
        "key-passphrase",
        "Bearer header-token",
        "session=cookie-token",
        "controller-secret",
    }


def test_credential_values_ignores_invalid_yaml() -> None:
    assert _credential_values(b"proxies: [") == set()


def test_forbidden_value_check_handles_short_and_escaped_credentials() -> None:
    assert _contains_forbidden_value({"username": "u"}, {"u"})
    assert _contains_forbidden_value(
        {"error": 'prefix pa"ssword suffix'},
        {'pa"ssword'},
    )
    assert not _contains_forbidden_value({"location": "US"}, {"u"})


def test_subscription_url_values_extracts_query_and_opaque_path_tokens() -> None:
    assert _subscription_url_values(
        "https://example.com/api/subscription/abcdefghijklmnop?token=secret-value"
    ) == {"abcdefghijklmnop", "secret-value"}
    assert _subscription_url_values(
        "https://example.com/x/a1Bc2DeF?t=auto"
    ) == {"a1Bc2DeF"}


def test_subscription_url_values_ignores_non_secret_mode_values() -> None:
    assert not _subscription_url_values(
        "https://example.com/api/subscription?format=clash&t=auto"
    )

def test_subscription_url_values_keeps_short_explicit_tokens() -> None:
    assert _subscription_url_values(
        "https://example.com/api/subscription?access_token=abc"
    ) == {"abc"}


@pytest.mark.parametrize("token", ["abcdef", "123456", "abc-def"])
def test_subscription_url_values_keeps_short_query_token_shapes(token: str) -> None:
    assert _subscription_url_values(
        f"https://example.com/api/subscription?t={token}"
    ) == {token}


@pytest.mark.parametrize("token", ["abcdef", "123456", "abc-def"])
def test_subscription_url_values_keeps_short_path_token_shapes(token: str) -> None:
    assert _subscription_url_values(
        f"https://example.com/api/subscription/{token}?t=auto"
    ) == {token}


def test_formal_scan_requires_every_node_to_be_usable() -> None:
    _require_no_failed_nodes({"failed_count": 0})

    with pytest.raises(RuntimeError, match="4 个节点未获得有效结果"):
        _require_no_failed_nodes({"failed_count": 4})


def test_formal_scan_never_accepts_all_nodes_failed(monkeypatch) -> None:
    monkeypatch.setenv("BEST_IP_ALLOW_PARTIAL", "1")

    with pytest.raises(RuntimeError, match="全部节点"):
        _require_no_failed_nodes({"failed_count": 4, "total": 4})


def test_api_base_requires_local_http_origin() -> None:
    assert _validate_local_api_base("http://127.0.0.1:8000/") == "http://127.0.0.1:8000"
    assert _validate_local_api_base("http://[::1]:8000") == "http://[::1]:8000"
    for value in (
        "https://127.0.0.1:8000",
        "http://example.com:8000",
        "http://127.0.0.1",
        "http://127.0.0.1:8000/api",
    ):
        with pytest.raises(RuntimeError, match="本机 HTTP"):
            _validate_local_api_base(value)


async def test_cancel_scan_calls_job_endpoint_and_confirms_terminal_status() -> None:
    class Response:
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "id": "job-id",
                "status": "cancelled",
                "cleanup_confirmed": True,
            }

    class Client:
        path = ""
        timeout = 0.0

        async def delete(self, path: str, *, timeout: float) -> Response:
            self.path = path
            self.timeout = timeout
            return Response()

    client = Client()
    result = await _cancel_scan(  # type: ignore[arg-type]
        client,
        "http://127.0.0.1:8000",
        "job-id",
    )

    assert client.path == "http://127.0.0.1:8000/api/scans/job-id"
    assert client.timeout == 30.0
    assert result["status"] == "cancelled"


async def test_cancel_scan_accepts_not_started_job(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("scripts.verify_real_scan.JOBS_DIR", tmp_path / "jobs")

    class Response:
        status_code = 404

    class Client:
        async def delete(self, _path: str, *, timeout: float) -> Response:
            assert timeout == 30.0
            return Response()

    result = await _cancel_scan(  # type: ignore[arg-type]
        Client(),
        "http://127.0.0.1:8000",
        "job-id",
        allow_not_found=True,
    )
    assert result == {"status": "cancelled", "cleanup_confirmed": True}


async def test_cancel_scan_rejects_unconfirmed_not_found(tmp_path, monkeypatch) -> None:
    jobs_dir = tmp_path / "jobs"
    job_id = "job-id"
    (jobs_dir / job_id).mkdir(parents=True)
    monkeypatch.setattr("scripts.verify_real_scan.JOBS_DIR", jobs_dir)

    class Response:
        status_code = 404

    class Client:
        async def delete(self, _path: str, *, timeout: float) -> Response:
            assert timeout == 30.0
            return Response()

    with pytest.raises(RuntimeError, match="无法确认"):
        await _cancel_scan(  # type: ignore[arg-type]
            Client(),
            "http://127.0.0.1:8000",
            job_id,
        )


async def test_cancel_scan_rejects_nonterminal_response() -> None:
    class Response:
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {"status": "running"}

    class Client:
        async def delete(self, _path: str, *, timeout: float) -> Response:
            assert timeout == 30.0
            return Response()

    with pytest.raises(RuntimeError, match="未返回已确认"):
        await _cancel_scan(  # type: ignore[arg-type]
            Client(),
            "http://127.0.0.1:8000",
            "job-id",
        )
