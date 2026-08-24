from __future__ import annotations

import hashlib
import sys
import zipfile

import pytest

from scripts import download_mihomo


def test_verified_archive_cache_skips_release_request(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        download_mihomo,
        "platform_asset",
        lambda: ("mihomo-windows-amd64-v", ".zip", "mihomo.exe"),
    )
    source = tmp_path / "source.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("mihomo.exe", b"cached-mihomo")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    source.replace(cache_dir / f"{digest}.zip")
    output_dir = tmp_path / "output"

    def unexpected_request(_url: str) -> dict:
        raise AssertionError("cache hit must not call the GitHub release API")

    monkeypatch.setattr(download_mihomo, "github_json", unexpected_request)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "download_mihomo.py",
            "--tag",
            "v-test",
            "--archive-sha256",
            digest,
            "--archive-cache-dir",
            str(cache_dir),
            "--output-dir",
            str(output_dir),
        ],
    )

    download_mihomo.main()

    assert (output_dir / "mihomo.exe").read_bytes() == b"cached-mihomo"
    assert f"sha256:{digest}" in (output_dir / "version.txt").read_text(encoding="utf-8")


def test_archive_cache_is_reverified_before_extract(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        download_mihomo,
        "platform_asset",
        lambda: ("mihomo-windows-amd64-v", ".zip", "mihomo.exe"),
    )
    expected = "0" * 64
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    (cache_dir / f"{expected}.zip").write_bytes(b"tampered")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "download_mihomo.py",
            "--archive-sha256",
            expected,
            "--archive-cache-dir",
            str(cache_dir),
            "--output-dir",
            str(tmp_path / "output"),
        ],
    )

    with pytest.raises(RuntimeError, match="SHA-256"):
        download_mihomo.main()
