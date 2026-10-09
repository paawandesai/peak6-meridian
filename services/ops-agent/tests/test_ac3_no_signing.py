"""M1-11 AC3: the ops agent cannot sign (no signing dependency, no keypair env var access).

The dependency check walks the *locked* closure of `meridian_ops_agent` in `uv.lock`, so it
holds regardless of what else is installed in the shared workspace venv (e.g. `solders` for
`meridian_quant` later).
"""

import ast
import tomllib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_DIR = REPO_ROOT / "services" / "ops-agent" / "src" / "meridian_ops_agent"
EVALS_DIR = REPO_ROOT / "services" / "ops-agent" / "evals"
LOCK = REPO_ROOT / "uv.lock"

# Anything that can hold or use a Solana signing key, or do ed25519 signing at all.
SIGNING_PACKAGES = frozenset(
    {
        "solders",
        "solana",
        "solana-py",
        "anchorpy",
        "pynacl",
        "nacl",
        "ed25519",
        "cryptography",
        "pysodium",
        "base58",
        "mnemonic",
        "bip-utils",
        "bip_utils",
    }
)
SIGNING_MODULES = frozenset({"solders", "solana", "anchorpy", "nacl", "ed25519", "cryptography"})

# The only environment variables the package may read (docs/environment.md).
ALLOWED_ENV_VARS = frozenset(
    {
        "OPS_AGENT_MODEL",
        "OPS_AGENT_BUDGET_USD",
        "SERVICE_TOKEN",
        "TIINGO_API_KEY",
        "TWELVEDATA_API_KEY",
        "OPS_AGENT_LLM",
        "OPS_AGENT_STORE",
        "OPS_AGENT_HOST",
        "PORT",
    }
)
ALLOWED_ENV_VARS_IN_EVALS = ALLOWED_ENV_VARS | {"CI"}
KEYPAIR_ENV_VARS = frozenset(
    {"ADMIN_KEYPAIR_PATH", "AUTOMATION_KEYPAIR", "MARKET_MAKER_KEYPAIR", "FAUCET_KEYPAIR"}
)


def locked_closure(root: str) -> set[str]:
    lock = tomllib.loads(LOCK.read_text(encoding="utf-8"))
    deps: dict[str, list[str]] = {
        pkg["name"]: [d["name"] for d in pkg.get("dependencies", [])] for pkg in lock["package"]
    }
    closure: set[str] = set()
    todo = [root]
    while todo:
        name = todo.pop()
        if name in closure:
            continue
        closure.add(name)
        todo.extend(deps[name])
    return closure


def test_locked_dependency_closure_has_no_signing_capable_package() -> None:
    closure = locked_closure("meridian-ops-agent")
    assert "anthropic" in closure and "pydantic" in closure  # sanity: the walk found real deps
    assert not closure & SIGNING_PACKAGES, sorted(closure & SIGNING_PACKAGES)


def test_declared_dependencies_are_only_the_two_expected() -> None:
    pyproject = tomllib.loads(
        (REPO_ROOT / "services" / "ops-agent" / "pyproject.toml").read_text(encoding="utf-8")
    )
    names = sorted(
        dep.split(">")[0].split("=")[0].split("<")[0]
        for dep in pyproject["project"]["dependencies"]
    )
    assert names == ["anthropic", "pydantic"]
    assert "optional-dependencies" not in pyproject["project"]


def python_files(directory: Path) -> list[Path]:
    files = sorted(directory.rglob("*.py"))
    assert files, f"no python files under {directory}"
    return files


@pytest.mark.parametrize("path", python_files(PACKAGE_DIR) + python_files(EVALS_DIR), ids=str)
def test_no_signing_module_is_imported(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [(node.module or "").split(".")[0]]
        else:
            continue
        assert not set(names) & SIGNING_MODULES, f"{path}: imports {names}"


def env_reads(path: Path) -> list[str]:
    """Every environment variable name the module reads, or '<dynamic>' for a non-literal."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    reads: list[str] = []
    for node in ast.walk(tree):
        target: ast.expr | None = None
        if isinstance(node, ast.Call):
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and func.attr in {"getenv", "get"}
                and (_is_os(func.value) or _is_environ(func.value))
            ):
                target = node.args[0] if node.args else None
                if target is None:
                    reads.append("<dynamic>")
        elif isinstance(node, ast.Subscript) and _is_environ(node.value):
            target = node.slice
        if target is not None:
            literal = target.value if isinstance(target, ast.Constant) else None
            reads.append(literal if isinstance(literal, str) else "<dynamic>")
    return reads


def _is_os(node: ast.expr) -> bool:
    return isinstance(node, ast.Name) and node.id == "os"


def _is_environ(node: ast.expr) -> bool:
    return (isinstance(node, ast.Name) and node.id == "environ") or (
        isinstance(node, ast.Attribute) and node.attr == "environ"
    )


@pytest.mark.parametrize("path", python_files(PACKAGE_DIR), ids=str)
def test_package_reads_only_allowlisted_env_vars(path: Path) -> None:
    assert set(env_reads(path)) <= ALLOWED_ENV_VARS, env_reads(path)


@pytest.mark.parametrize("path", python_files(EVALS_DIR), ids=str)
def test_evals_read_only_allowlisted_env_vars(path: Path) -> None:
    assert set(env_reads(path)) <= ALLOWED_ENV_VARS_IN_EVALS, env_reads(path)


def test_env_scanner_sees_through_the_usual_access_patterns(tmp_path: Path) -> None:
    sample = tmp_path / "sample.py"
    sample.write_text(
        "import os\nfrom os import environ\n"
        "a = os.environ.get('AUTOMATION_KEYPAIR')\nb = os.getenv('X', 'd')\n"
        "c = os.environ['ADMIN_KEYPAIR_PATH']\nd = environ.get(name)\ne = environ['Y']\n",
        encoding="utf-8",
    )
    assert sorted(env_reads(sample)) == sorted(
        ["AUTOMATION_KEYPAIR", "X", "<dynamic>", "ADMIN_KEYPAIR_PATH", "Y"]
    )


@pytest.mark.parametrize("path", python_files(PACKAGE_DIR) + python_files(EVALS_DIR), ids=str)
def test_no_keypair_or_api_key_variable_name_appears_in_code(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    code_lines = [line for line in source.splitlines() if not line.lstrip().startswith("#")]
    for name in KEYPAIR_ENV_VARS:
        assert name not in "\n".join(code_lines), f"{path} mentions {name}"
    # The SDK reads ANTHROPIC_API_KEY itself; agent code never names it outside docstrings/comments.
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            assert "ANTHROPIC_API_KEY" not in node.value or node.value.lstrip().startswith(
                ("`make eval-live`", "The real Anthropic client")
            ), f"{path}: string literal names the API key variable"
