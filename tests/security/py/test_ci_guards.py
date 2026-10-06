"""CI guard scripts, exercised against temporary git repositories.

AB-17 / NFR-10 context: `guard-human-files.sh` keeps agents from changing human-owned files
without the human's `human-approved` label, and `heartbeat.sh` alarms when docs/log.md goes
quiet for more than 24 hours.
"""

import os
import subprocess
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
GUARD = REPO_ROOT / "scripts" / "ci" / "guard-human-files.sh"
HEARTBEAT = REPO_ROOT / "scripts" / "ci" / "heartbeat.sh"

HUMAN_OWNED = [
    "docs/brief.md",
    "docs/requirements.md",
    "docs/threat-model.md",
    "docs/plan.md",
    "docs/operating-rules.md",
]
DAY_SECONDS = 86_400


def _base_env() -> dict[str, str]:
    """Environment with a fixed git identity and none of the caller's git or CI settings."""
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("GIT_", "CI_")) and key != "HEARTBEAT"
    }
    env.update(
        GIT_AUTHOR_NAME="test",
        GIT_AUTHOR_EMAIL="test@example.invalid",
        GIT_COMMITTER_NAME="test",
        GIT_COMMITTER_EMAIL="test@example.invalid",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_SYSTEM=os.devnull,
    )
    return env


def _git(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        env=env or _base_env(),
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result.stdout.strip()


def _commit(repo: Path, message: str, *, at: int | None = None) -> str:
    env = _base_env()
    if at is not None:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{at} +0000"
    _git(repo, "add", "-A", env=env)
    _git(repo, "commit", "--quiet", "-m", message, env=env)
    return _git(repo, "rev-parse", "HEAD")


def _write(repo: Path, relative: str, content: str) -> None:
    path = repo / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A git repo holding every human-owned file plus ordinary ones, with one commit."""
    _git(tmp_path, "init", "--quiet", "--initial-branch=main")
    for name in HUMAN_OWNED:
        _write(tmp_path, name, "original\n")
    _write(tmp_path, "docs/log.md", "# Log\n")
    _write(tmp_path, "src/code.txt", "v1\n")
    _commit(tmp_path, "base")
    return tmp_path


def _run_guard(
    repo: Path, base: str, head: str, labels: str | None
) -> subprocess.CompletedProcess[str]:
    env = _base_env()
    env["CI_MERGE_REQUEST_DIFF_BASE_SHA"] = base
    env["CI_COMMIT_SHA"] = head
    if labels is not None:
        env["CI_MERGE_REQUEST_LABELS"] = labels
    return subprocess.run(
        ["bash", str(GUARD)], cwd=repo, env=env, capture_output=True, text=True, timeout=30
    )


def _run_heartbeat(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(HEARTBEAT)],
        cwd=repo,
        env=_base_env(),
        capture_output=True,
        text=True,
        timeout=30,
    )


class TestGuardHumanFiles:
    @pytest.mark.parametrize("protected", HUMAN_OWNED)
    @pytest.mark.parametrize("labels", [None, "", "M1", "M1,bug", "not-human-approved"])
    def test_protected_file_without_label_fails(
        self, repo: Path, protected: str, labels: str | None
    ) -> None:
        base = _git(repo, "rev-parse", "HEAD")
        _write(repo, protected, "changed by an agent\n")
        head = _commit(repo, "touch protected file")

        result = _run_guard(repo, base, head, labels)

        assert result.returncode == 1
        assert protected in result.stderr  # which file
        assert "human-approved" in result.stderr  # and why
        untouched = [name for name in HUMAN_OWNED if name != protected]
        assert not any(name in result.stderr for name in untouched)

    @pytest.mark.parametrize("protected", HUMAN_OWNED)
    @pytest.mark.parametrize("labels", ["human-approved", "M1,human-approved", "human-approved,M1"])
    def test_protected_file_with_label_passes(
        self, repo: Path, protected: str, labels: str
    ) -> None:
        base = _git(repo, "rev-parse", "HEAD")
        _write(repo, protected, "changed by the human\n")
        head = _commit(repo, "touch protected file")

        result = _run_guard(repo, base, head, labels)

        assert result.returncode == 0, result.stderr
        assert protected in result.stdout

    @pytest.mark.parametrize("labels", [None, "M1", "human-approved"])
    def test_unprotected_files_pass(self, repo: Path, labels: str | None) -> None:
        base = _git(repo, "rev-parse", "HEAD")
        _write(repo, "src/code.txt", "v2\n")
        _write(repo, "docs/log.md", "# Log\nentry\n")
        _write(repo, "docs/brief.md.bak", "not the protected file\n")
        _write(repo, "notes/docs/brief.md", "same name, different path\n")
        head = _commit(repo, "ordinary change")

        result = _run_guard(repo, base, head, labels)

        assert result.returncode == 0, result.stderr

    def test_deleting_a_protected_file_fails(self, repo: Path) -> None:
        base = _git(repo, "rev-parse", "HEAD")
        (repo / "docs/plan.md").unlink()
        head = _commit(repo, "delete protected file")

        result = _run_guard(repo, base, head, "M1")

        assert result.returncode == 1
        assert "docs/plan.md" in result.stderr

    def test_renaming_a_protected_file_fails(self, repo: Path) -> None:
        base = _git(repo, "rev-parse", "HEAD")
        _git(repo, "mv", "docs/threat-model.md", "docs/threat-model-old.md")
        head = _commit(repo, "rename protected file")

        result = _run_guard(repo, base, head, "M1")

        assert result.returncode == 1
        assert "docs/threat-model.md" in result.stderr

    def test_every_touched_protected_file_is_reported(self, repo: Path) -> None:
        base = _git(repo, "rev-parse", "HEAD")
        _write(repo, "docs/brief.md", "changed\n")
        _write(repo, "docs/requirements.md", "changed\n")
        _write(repo, "src/code.txt", "v2\n")
        head = _commit(repo, "touch two protected files")

        result = _run_guard(repo, base, head, "M1")

        assert result.returncode == 1
        assert "docs/brief.md" in result.stderr
        assert "docs/requirements.md" in result.stderr
        assert "src/code.txt" not in result.stderr

    def test_missing_diff_base_fails_loudly(self, repo: Path) -> None:
        env = _base_env()
        env["CI_COMMIT_SHA"] = _git(repo, "rev-parse", "HEAD")

        result = subprocess.run(
            ["bash", str(GUARD)], cwd=repo, env=env, capture_output=True, text=True, timeout=30
        )

        assert result.returncode != 0
        assert "CI_MERGE_REQUEST_DIFF_BASE_SHA" in result.stderr


class TestHeartbeat:
    def test_fresh_log_passes(self, repo: Path) -> None:
        _write(repo, "docs/log.md", "# Log\nfresh entry\n")
        _commit(repo, "log entry", at=int(time.time()) - 60)

        result = _run_heartbeat(repo)

        assert result.returncode == 0, result.stderr
        assert "OK" in result.stdout

    def test_log_just_inside_24h_passes(self, repo: Path) -> None:
        _write(repo, "docs/log.md", "# Log\nyesterday's entry\n")
        _commit(repo, "log entry", at=int(time.time()) - (DAY_SECONDS - 600))

        result = _run_heartbeat(repo)

        assert result.returncode == 0, result.stderr

    def test_log_older_than_24h_fails(self, tmp_path: Path) -> None:
        stale = int(time.time()) - (DAY_SECONDS + 600)
        _git(tmp_path, "init", "--quiet", "--initial-branch=main")
        _write(tmp_path, "docs/log.md", "# Log\nold entry\n")
        _commit(tmp_path, "log entry", at=stale)

        result = _run_heartbeat(tmp_path)

        assert result.returncode == 1
        assert "docs/log.md" in result.stderr

    def test_newer_commits_to_other_files_do_not_count(self, tmp_path: Path) -> None:
        stale = int(time.time()) - 3 * DAY_SECONDS
        _git(tmp_path, "init", "--quiet", "--initial-branch=main")
        _write(tmp_path, "docs/log.md", "# Log\nold entry\n")
        _commit(tmp_path, "log entry", at=stale)
        _write(tmp_path, "src/code.txt", "v2\n")
        _commit(tmp_path, "unrelated fresh commit", at=int(time.time()) - 60)

        result = _run_heartbeat(tmp_path)

        assert result.returncode == 1

    def test_missing_log_fails(self, tmp_path: Path) -> None:
        _git(tmp_path, "init", "--quiet", "--initial-branch=main")
        _write(tmp_path, "src/code.txt", "v1\n")
        _commit(tmp_path, "no log file")

        result = _run_heartbeat(tmp_path)

        assert result.returncode == 1
        assert "no commits" in result.stderr
