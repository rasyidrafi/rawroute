#!/usr/bin/env python3
"""Create safe, portable review bundles for Node.js repositories."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import platform
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Sequence


VERSION = "1.0.0"
DEFAULT_NODE = "22.16.0"
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_SOURCE_BYTES = 500 * 1024 * 1024
TEXT_SCAN_BYTES = 8 * 1024 * 1024

EXIT_USAGE = 2
EXIT_REPOSITORY = 3
EXIT_SENSITIVE = 4
EXIT_DEPENDENCY = 5
EXIT_ARCHIVE = 6
EXIT_VERIFY = 7


class BundleError(Exception):
    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass(frozen=True)
class Finding:
    path: str
    reason: str
    fatal: bool = True


@dataclass
class PackageMetadata:
    manager: str = "ambiguous"
    manager_version: str | None = None
    package_manager_field: str | None = None
    node_engine: str | None = None
    package_jsons: list[str] = field(default_factory=list)
    lockfiles: list[str] = field(default_factory=list)
    workspaces: list[str] = field(default_factory=list)
    scripts: dict[str, str] = field(default_factory=dict)
    native_warnings: list[str] = field(default_factory=list)
    detected_files: list[str] = field(default_factory=list)
    ambiguities: list[str] = field(default_factory=list)
    bun_native: bool = False


@dataclass
class Selection:
    files: list[Path] = field(default_factory=list)
    excluded: dict[str, str] = field(default_factory=dict)
    findings: list[Finding] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    total_bytes: int = 0


@dataclass
class CommandResult:
    argv: list[str]
    returncode: int
    stdout: str
    stderr: str


def log(message: str, *, verbose: bool = True) -> None:
    if verbose:
        print(message)


def stable_json(data: Any) -> str:
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_environment() -> dict[str, str]:
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR"}
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env.update({"CI": "1", "NO_COLOR": "1"})
    return env


def run_command(
    argv: Sequence[str],
    *,
    cwd: Path | None = None,
    timeout: int = 60,
    check: bool = False,
) -> CommandResult:
    try:
        completed = subprocess.run(
            list(argv),
            cwd=cwd,
            env=safe_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            timeout=timeout,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BundleError(f"Command failed safely: {argv[0]}: {type(exc).__name__}") from exc
    result = CommandResult(list(argv), completed.returncode, completed.stdout, completed.stderr)
    if check and completed.returncode != 0:
        raise BundleError(
            f"Command failed with exit code {completed.returncode}: {Path(argv[0]).name}",
            EXIT_DEPENDENCY,
        )
    return result


def validate_project_name(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", value):
        raise BundleError(
            "Project name must be 1-100 safe filename characters.", EXIT_USAGE
        )
    if value in {".", ".."}:
        raise BundleError("Project name cannot be '.' or '..'.", EXIT_USAGE)
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create a secret-scanned Node.js repository bundle for isolated AI review.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python prepare_ai_review_bundle.py . --output-dir ./ai-review-output
  python prepare_ai_review_bundle.py . --output-dir ./ai-review-output --dry-run
  python prepare_ai_review_bundle.py . --include-dependencies --dependency-source docker
  python prepare_ai_review_bundle.py . --include-git-history

Source-only mode is normally enough for static review. Dependency installation and
verification execute untrusted package or project code only when explicitly requested.
""",
    )
    parser.add_argument("repository", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--project-name")
    parser.add_argument("--source-only", action="store_true")
    parser.add_argument("--include-dependencies", action="store_true")
    parser.add_argument(
        "--dependency-source", choices=("auto", "existing", "docker"), default="auto"
    )
    parser.add_argument("--target-node-version", default=DEFAULT_NODE)
    parser.add_argument("--target-platform", default="linux")
    parser.add_argument("--target-arch", default="x64")
    parser.add_argument("--include-git-history", action="store_true")
    parser.add_argument("--include-git-diff", action="store_true")
    parser.add_argument("--review-file", type=Path)
    parser.add_argument("--run-verification", action="store_true")
    parser.add_argument("--install-scripts", action="store_true")
    parser.add_argument("--allow-file", action="append", default=[])
    parser.add_argument("--exclude-file", action="append", default=[])
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def validate_args(args: argparse.Namespace) -> tuple[Path, Path, str]:
    repo = args.repository.expanduser().resolve()
    if not repo.is_dir():
        raise BundleError("Repository path does not exist or is not a directory.", EXIT_REPOSITORY)
    if not (repo / "package.json").is_file():
        raise BundleError("Repository root must contain package.json.", EXIT_REPOSITORY)
    if args.source_only and (args.include_dependencies or args.run_verification):
        raise BundleError(
            "--source-only conflicts with dependency and verification options.", EXIT_USAGE
        )
    output = (args.output_dir or (repo.parent / f"{repo.name}-ai-review-output"))
    output = output.expanduser().resolve()
    if "node_modules" in output.parts:
        raise BundleError("Output directory cannot be inside node_modules.", EXIT_USAGE)
    if output == repo:
        raise BundleError("Output directory cannot be the repository root.", EXIT_USAGE)
    name = validate_project_name(args.project_name or repo.name)
    if args.review_file:
        args.review_file = args.review_file.expanduser().resolve()
        if not args.review_file.is_file():
            raise BundleError("--review-file does not exist.", EXIT_USAGE)
    return repo, output, name


def relative_posix(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BundleError(f"Invalid JSON file: {path.name}", EXIT_REPOSITORY) from exc
    if not isinstance(value, dict):
        raise BundleError(f"Expected a JSON object: {path.name}", EXIT_REPOSITORY)
    return value


def discover_package_jsons(repo: Path) -> list[Path]:
    results: list[Path] = []
    skipped = {"node_modules", ".git", ".next", "dist", "coverage", "test-results"}
    for current, dirs, files in os.walk(repo, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in skipped)
        if "package.json" in files:
            results.append(Path(current) / "package.json")
    return sorted(results, key=lambda path: relative_posix(path, repo))


def detect_metadata(repo: Path) -> PackageMetadata:
    root_package = read_json(repo / "package.json")
    metadata = PackageMetadata()
    packages = discover_package_jsons(repo)
    metadata.package_jsons = [relative_posix(path, repo) for path in packages]
    metadata.node_engine = str(root_package.get("engines", {}).get("node") or "") or None
    scripts = root_package.get("scripts", {})
    if isinstance(scripts, dict):
        metadata.scripts = {
            str(key): str(value) for key, value in sorted(scripts.items())
        }

    manager_field = root_package.get("packageManager")
    if isinstance(manager_field, str):
        metadata.package_manager_field = manager_field
        match = re.fullmatch(r"(npm|pnpm|yarn|bun)@([A-Za-z0-9._-]+)(?:\+[A-Za-z0-9._-]+)?", manager_field)
        if match:
            metadata.manager, metadata.manager_version = match.groups()
        else:
            metadata.ambiguities.append("Unrecognized packageManager field")

    lock_map = {
        "package-lock.json": "npm",
        "npm-shrinkwrap.json": "npm",
        "pnpm-lock.yaml": "pnpm",
        "yarn.lock": "yarn",
        "bun.lock": "bun",
        "bun.lockb": "bun",
    }
    lock_managers: set[str] = set()
    for filename, manager in lock_map.items():
        if (repo / filename).exists():
            metadata.lockfiles.append(filename)
            lock_managers.add(manager)

    if metadata.manager == "ambiguous":
        if len(lock_managers) == 1:
            metadata.manager = next(iter(lock_managers))
        elif len(lock_managers) > 1:
            metadata.ambiguities.append(
                "Multiple package-manager lockfile families are present"
            )
    elif lock_managers and metadata.manager not in lock_managers:
        metadata.ambiguities.append(
            "packageManager does not match the committed lockfile family"
        )

    workspaces = root_package.get("workspaces")
    if isinstance(workspaces, list):
        metadata.workspaces = [str(value) for value in workspaces]
    elif isinstance(workspaces, dict) and isinstance(workspaces.get("packages"), list):
        metadata.workspaces = [str(value) for value in workspaces["packages"]]
    if (repo / "pnpm-workspace.yaml").exists():
        metadata.workspaces.append("pnpm-workspace.yaml")

    native_names = {
        "sharp", "better-sqlite3", "sqlite3", "bcrypt", "canvas", "esbuild",
        "@swc/core", "prisma", "@prisma/client", "rollup",
    }
    found_native: set[str] = set()
    for package_path in packages:
        package = read_json(package_path)
        for section in ("dependencies", "devDependencies", "optionalDependencies"):
            values = package.get(section, {})
            if isinstance(values, dict):
                found_native.update(name for name in values if name in native_names)
                found_native.update(
                    name for name in values if name.startswith(("@esbuild/", "@rollup/rollup-"))
                )
        for section in ("trustedDependencies", "ignoreScripts"):
            values = package.get(section, [])
            if isinstance(values, list):
                found_native.update(name for name in values if name in native_names)
    lock_path = repo / "package-lock.json"
    if lock_path.is_file():
        lock_data = read_json(lock_path)
        lock_packages = lock_data.get("packages", {})
        if isinstance(lock_packages, dict):
            for package_path in lock_packages:
                name = package_path.rsplit("node_modules/", 1)[-1]
                if name in native_names or name.startswith(("@esbuild/", "@rollup/rollup-", "@next/swc-")):
                    found_native.add(name)
    metadata.native_warnings = sorted(found_native)
    metadata.detected_files = sorted(
        path.name
        for path in repo.iterdir()
        if path.is_file()
        and (
            path.name == "Dockerfile"
            or path.name.lower().startswith(("docker-compose", "compose"))
            or (path.name.startswith("tsconfig") and path.suffix == ".json")
        )
    )
    metadata.bun_native = metadata.manager == "bun"
    return metadata


def git_result(repo: Path, argv: Sequence[str], timeout: int = 60) -> CommandResult | None:
    if not (repo / ".git").exists() or shutil.which("git") is None:
        return None
    return run_command(["git", *argv], cwd=repo, timeout=timeout)


def git_tracked_files(repo: Path) -> set[str]:
    result = git_result(repo, ["ls-files", "-z"])
    if result is None or result.returncode != 0:
        return set()
    return {value for value in result.stdout.split("\0") if value}


def detect_git_state(repo: Path) -> dict[str, Any]:
    state: dict[str, Any] = {
        "available": False,
        "branch": None,
        "head": None,
        "dirty": None,
        "staged": False,
        "unstaged": False,
        "untracked": [],
    }
    status = git_result(repo, ["status", "--porcelain=v1", "-z"])
    if status is None or status.returncode != 0:
        return state
    state["available"] = True
    entries = [entry for entry in status.stdout.split("\0") if entry]
    state["dirty"] = bool(entries)
    state["staged"] = any(entry[0] not in {" ", "?"} for entry in entries)
    state["unstaged"] = any(len(entry) > 1 and entry[1] not in {" ", "?"} for entry in entries)
    state["untracked"] = sorted(entry[3:] for entry in entries if entry.startswith("?? "))
    branch = git_result(repo, ["branch", "--show-current"])
    head = git_result(repo, ["rev-parse", "HEAD"])
    if branch and branch.returncode == 0:
        state["branch"] = branch.stdout.strip() or None
    if head and head.returncode == 0:
        state["head"] = head.stdout.strip() or None
    return state


HARD_EXCLUDED_PARTS = {".git", "node_modules"}
GENERATED_DIRS = {
    ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache",
    ".commandcode", "__pycache__", "coverage", "playwright-report", "test-results",
    "out", "dist",
}
IGNORED_NAMES = {
    ".DS_Store", "Thumbs.db", "npm-debug.log", "yarn-error.log",
    "tsconfig.tsbuildinfo",
}
SENSITIVE_NAME_PATTERNS = (
    ".env", ".env.local", ".env.production", ".env.development",
    "service-account*.json", "credentials.json", "id_rsa", "id_dsa",
    "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.pem",
    "*.sqlite", "*.sqlite3", "*.db", "*.dump", "*.sql.gz",
)
SAFE_ENV_SUFFIXES = (".example", ".sample", ".template")
TEXT_SUFFIXES = {
    ".cjs", ".conf", ".css", ".csv", ".env", ".gitignore", ".graphql",
    ".html", ".ini", ".java", ".js", ".json", ".jsx", ".lock", ".md",
    ".mjs", ".properties", ".py", ".rb", ".rs", ".sh", ".sql", ".svg",
    ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}


def pattern_matches(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def is_sensitive_name(relative: str) -> bool:
    path = PurePosixPath(relative)
    name = path.name.lower()
    if name.startswith(".env") and name.endswith(SAFE_ENV_SUFFIXES):
        return False
    return any(fnmatch.fnmatch(name, pattern) for pattern in SENSITIVE_NAME_PATTERNS)


def is_probably_text(path: Path, sample: bytes) -> bool:
    if path.suffix.lower() in TEXT_SUFFIXES or path.name in {"Dockerfile", "Makefile"}:
        return True
    if b"\0" in sample:
        return False
    if not sample:
        return True
    printable = sum(byte in b"\t\n\r\f\b" or 32 <= byte < 127 for byte in sample)
    return printable / len(sample) > 0.85


def placeholder_value(value: str) -> bool:
    normalized = value.strip().strip("'\"").lower()
    if not normalized:
        return True
    markers = (
        "replace-with", "your-", "example", "placeholder", "changeme", "dummy",
        "fake", "redacted", "<", "${", "...", "xxx", "test-only",
    )
    return any(marker in normalized for marker in markers)


def scan_text(relative: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    hard_patterns = (
        (r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{80,}?-----END", "private-key material"),
        (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key identifier"),
        (r"\bgh[pousr]_[A-Za-z0-9]{30,}\b", "GitHub token"),
        (r"\bglpat-[A-Za-z0-9_-]{20,}\b", "GitLab token"),
        (r"\bnpm_[A-Za-z0-9]{30,}\b", "npm token"),
        (r"(?i)authorization\s*[:=]\s*['\"]?bearer\s+[A-Za-z0-9._~+/=-]{20,}", "authorization bearer token"),
        (r"(?i)https?://[^\s:/]+:[^\s/@]{3,}@[^\s]+", "password-bearing URL"),
    )
    for pattern, reason in hard_patterns:
        if re.search(pattern, text):
            findings.append(Finding(relative, reason))

    relative_name = PurePosixPath(relative).name
    config_like = relative_name.startswith(".env") or PurePosixPath(relative).suffix.lower() in {
        ".env", ".ini", ".json", ".toml", ".yaml", ".yml", ".properties",
    } or PurePosixPath(relative).name in {".npmrc", ".yarnrc", ".yarnrc.yml"}
    if config_like:
        secret_name = re.compile(
            r"(?i)^\s*[A-Za-z0-9_.-]*(?:secret|password|passwd|token|api[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*\s*[:=]\s*(.+?)\s*$"
        )
        for line in text.splitlines():
            if line.lstrip().startswith(("#", "//")):
                continue
            match = secret_name.match(line)
            if match and not placeholder_value(match.group(1)):
                findings.append(Finding(relative, "non-placeholder secret-like setting"))
                break
    unique: dict[tuple[str, str], Finding] = {}
    for finding in findings:
        unique[(finding.path, finding.reason)] = finding
    return list(unique.values())


def scan_file(path: Path, relative: str) -> list[Finding]:
    try:
        with path.open("rb") as handle:
            sample = handle.read(TEXT_SCAN_BYTES + 1)
    except OSError as exc:
        raise BundleError(f"Cannot read source file: {relative}", EXIT_REPOSITORY) from exc
    if len(sample) > TEXT_SCAN_BYTES:
        return []
    if not is_probably_text(path, sample[:4096]):
        return []
    try:
        text = sample.decode("utf-8")
    except UnicodeDecodeError:
        text = sample.decode("utf-8", errors="replace")
    return scan_text(relative, text)


def path_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_symlink(path: Path, repo: Path, relative: str) -> None:
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise BundleError(f"Broken symlink: {relative}", EXIT_ARCHIVE) from exc
    if not path_within(resolved, repo):
        raise BundleError(f"Symlink escapes repository: {relative}", EXIT_ARCHIVE)


def select_sources(
    repo: Path,
    output: Path,
    project_name: str,
    allow_patterns: Sequence[str],
    exclude_patterns: Sequence[str],
) -> Selection:
    selection = Selection()
    tracked = git_tracked_files(repo)
    output_inside = output if path_within(output, repo) else None
    bundle_prefixes = (
        f"{project_name}-source.zip", f"{project_name}-manifest.json",
        f"{project_name}-checksums.sha256", f"{project_name}-review-template.md",
        f"{project_name}-dependencies-", f"{project_name}-history.git.bundle",
        f"{project_name}-verification.txt",
    )
    seen_case: dict[str, str] = {}

    for current, dirs, files in os.walk(repo, topdown=True, followlinks=False):
        current_path = Path(current)
        kept_dirs: list[str] = []
        for dirname in sorted(dirs):
            candidate = current_path / dirname
            relative = relative_posix(candidate, repo)
            if dirname in HARD_EXCLUDED_PARTS:
                selection.excluded[relative + "/"] = "hard exclusion"
                continue
            if output_inside and path_within(candidate.resolve(), output_inside):
                selection.excluded[relative + "/"] = "output recursion"
                continue
            tracked_below = any(value == relative or value.startswith(relative + "/") for value in tracked)
            if dirname in GENERATED_DIRS and not tracked_below:
                selection.excluded[relative + "/"] = "generated output or cache"
                continue
            kept_dirs.append(dirname)
        dirs[:] = kept_dirs

        for filename in sorted(files):
            path = current_path / filename
            relative = relative_posix(path, repo)
            explicit_allow = pattern_matches(relative, allow_patterns)
            if pattern_matches(relative, exclude_patterns):
                selection.excluded[relative] = "--exclude-file"
                continue
            if any(part in HARD_EXCLUDED_PARTS for part in PurePosixPath(relative).parts):
                selection.excluded[relative] = "hard exclusion"
                continue
            if filename in IGNORED_NAMES or filename.endswith((".swp", ".tmp", ".log", ".core", ".pyc")):
                if not explicit_allow:
                    selection.excluded[relative] = "temporary, log, or generated metadata"
                    continue
            if filename.startswith(bundle_prefixes):
                selection.excluded[relative] = "previous bundle artifact"
                continue
            if is_sensitive_name(relative) and not explicit_allow:
                selection.excluded[relative] = "sensitive filename"
                continue

            if path.is_symlink():
                validate_symlink(path, repo, relative)
            size = path.lstat().st_size
            if size > MAX_FILE_BYTES:
                raise BundleError(f"Source file exceeds 100 MiB limit: {relative}", EXIT_ARCHIVE)
            if size > 25 * 1024 * 1024:
                selection.warnings.append(f"Large source file: {relative}")
            findings = scan_file(path, relative) if not path.is_symlink() else []
            if findings:
                selection.findings.extend(findings)
                continue
            folded = relative.casefold()
            if folded in seen_case and seen_case[folded] != relative:
                raise BundleError(
                    f"Case-colliding paths: {seen_case[folded]} and {relative}", EXIT_ARCHIVE
                )
            seen_case[folded] = relative
            selection.files.append(path)
            selection.total_bytes += size

    if selection.total_bytes > MAX_SOURCE_BYTES:
        raise BundleError("Selected source exceeds 500 MiB limit.", EXIT_ARCHIVE)
    selection.files.sort(key=lambda path: relative_posix(path, repo))
    return selection


def review_template(metadata: PackageMetadata, target_node: str) -> str:
    commands = "\n".join(
        f"- `{metadata.manager} run {name}`: {command}"
        for name, command in metadata.scripts.items()
        if name in {"build", "test", "lint", "typecheck", "start", "benchmark"}
    ) or "- Add sanitized install, build, test, lint, typecheck, start, and benchmark commands."
    return f"""# Review Goal

Describe the review or improvement goal.

# Required Deliverable

State whether you need findings, modified source, commits, a patch, or a ZIP.

# Priority Areas

Rank security, correctness, reliability, performance, cost, and architecture.

# Runtime and Deployment

- Target: Linux x64, Node.js {target_node}
- Package manager: {metadata.manager}{' ' + metadata.manager_version if metadata.manager_version else ''}
- Add database, hosting, CPU, RAM, traffic, concurrency, and latency targets.

# Commands

{commands}

# Known Problems

Add symptoms and exact reproduction steps.

# Data Scale

Add record counts, query cardinality, payload sizes, and request rates.

# Constraints

Add compatibility, network, time, and resource limits.

# Do Not Change

List APIs, files, behavior, schemas, and integrations that must remain compatible.

# Test Data

Describe sanitized fixtures and expected outputs. Do not include production data.

# Secrets

Confirm credentials, tokens, cookies, and production personal data were removed.
"""


def bundle_info(metadata: PackageMetadata, args: argparse.Namespace) -> str:
    dependency_note = (
        f"Dependencies are supplied separately in a Linux {args.target_arch} tar.gz archive."
        if args.include_dependencies
        else "No dependency archive was requested. Install dependencies in an isolated environment if needed."
    )
    commands = [name for name in ("lint", "typecheck", "test", "build") if name in metadata.scripts]
    return f"""# Bundle Information

- Target: {args.target_platform} {args.target_arch}, Node.js {args.target_node_version}
- Detected package manager: {metadata.manager}{' ' + metadata.manager_version if metadata.manager_version else ''}
- Source ZIP intentionally excludes `.git` and `node_modules`.
- {dependency_note}
- Expected finite scripts: {', '.join(commands) if commands else 'none detected'}

Extract the source ZIP first. If a dependency archive is present, extract it at the
source root so its `node_modules` or package-manager artifacts retain Unix modes and links.

Secret scanning is heuristic and cannot prove that all sensitive data was removed.
Review `AI_REVIEW_CONTEXT.md` before upload. Bun-native projects can be reviewed as
source, but a Node-only receiver cannot perform Bun-native runtime testing.
"""


def zip_datetime() -> tuple[int, int, int, int, int, int]:
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "315532800"))
    return time.gmtime(max(epoch, 315532800))[:6]


def safe_member_name(name: str) -> None:
    value = PurePosixPath(name)
    if value.is_absolute() or ".." in value.parts or not value.parts:
        raise BundleError(f"Unsafe archive member path: {name}", EXIT_ARCHIVE)
    if re.match(r"^[A-Za-z]:", name) or "\\" in name:
        raise BundleError(f"Unsafe platform-specific archive path: {name}", EXIT_ARCHIVE)


def add_bytes_to_zip(archive: zipfile.ZipFile, name: str, data: bytes, mode: int = 0o100644) -> None:
    safe_member_name(name)
    info = zipfile.ZipInfo(name, zip_datetime())
    info.create_system = 3
    info.external_attr = (mode & 0xFFFF) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, data)


def create_source_zip(
    destination: Path,
    repo: Path,
    selection: Selection,
    review_content: str,
    info_content: str,
    git_patch: bytes | None,
) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in selection.files:
            relative = relative_posix(path, repo)
            safe_member_name(relative)
            source_stat = path.lstat()
            if path.is_symlink():
                target = os.readlink(path).replace(os.sep, "/").encode("utf-8")
                add_bytes_to_zip(archive, relative, target, stat.S_IFLNK | 0o777)
            else:
                add_bytes_to_zip(
                    archive,
                    relative,
                    path.read_bytes(),
                    stat.S_IFREG | stat.S_IMODE(source_stat.st_mode),
                )
        add_bytes_to_zip(archive, "AI_REVIEW_CONTEXT.md", review_content.encode("utf-8"))
        add_bytes_to_zip(archive, "BUNDLE_INFO.md", info_content.encode("utf-8"))
        if git_patch is not None:
            add_bytes_to_zip(archive, "GIT_WORKTREE_CHANGES.patch", git_patch)


def blocked_member(name: str, allow_patterns: Sequence[str]) -> bool:
    parts = PurePosixPath(name).parts
    return (
        ".git" in parts
        or "node_modules" in parts
        or (is_sensitive_name(name) and not pattern_matches(name, allow_patterns))
    )


def verify_source_zip(path: Path, allow_patterns: Sequence[str]) -> dict[str, Any]:
    with zipfile.ZipFile(path, "r") as archive:
        if archive.testzip() is not None:
            raise BundleError("Source ZIP integrity test failed.", EXIT_VERIFY)
        names = archive.namelist()
        for name in names:
            safe_member_name(name)
            if blocked_member(name, allow_patterns):
                raise BundleError(f"Blocked path found in source ZIP: {name}", EXIT_VERIFY)
        if "package.json" not in names:
            raise BundleError("Source ZIP lacks root package.json.", EXIT_VERIFY)
        if "AI_REVIEW_CONTEXT.md" not in names or "BUNDLE_INFO.md" not in names:
            raise BundleError("Source ZIP lacks generated review context.", EXIT_VERIFY)
        return {"members": len(names), "integrity": "passed"}


def create_git_patch(repo: Path) -> bytes | None:
    unstaged = git_result(repo, ["diff", "--binary", "--no-ext-diff"])
    staged = git_result(repo, ["diff", "--binary", "--cached", "--no-ext-diff"])
    status = git_result(repo, ["status", "--short"])
    if not unstaged or not staged or not status:
        raise BundleError("Git diff requested but Git metadata is unavailable.", EXIT_REPOSITORY)
    content = (
        "# Git status\n" + status.stdout + "\n# Unstaged changes\n" + unstaged.stdout
        + "\n# Staged changes\n" + staged.stdout
    )
    findings = scan_text("GIT_WORKTREE_CHANGES.patch", content)
    if findings:
        raise BundleError(
            "Git patch contains probable sensitive data; omit it or sanitize the changes.",
            EXIT_SENSITIVE,
        )
    return content.encode("utf-8")


def create_git_bundle(repo: Path, destination: Path) -> None:
    config = git_result(repo, ["config", "--local", "--list"])
    if config and re.search(r"(?i)(token|password|oauth|http\..*extraheader)", config.stdout):
        raise BundleError("Local Git configuration appears to contain credentials.", EXIT_SENSITIVE)
    result = git_result(repo, ["bundle", "create", str(destination), "--all"], timeout=300)
    if result is None or result.returncode != 0:
        raise BundleError("Git history bundle creation failed.", EXIT_ARCHIVE)


def artifact_record(path: Path) -> dict[str, Any]:
    return {"filename": path.name, "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def dependency_paths(root: Path, metadata: PackageMetadata) -> list[Path]:
    paths: list[Path] = []
    node_modules = root / "node_modules"
    if node_modules.exists():
        paths.append(node_modules)
    if metadata.manager == "yarn":
        for relative in (
            ".yarn/cache", ".yarn/releases", ".yarn/plugins", ".pnp.cjs",
            ".pnp.loader.mjs", ".yarnrc.yml",
        ):
            path = root / relative
            if path.exists():
                paths.append(path)
    return paths


def validate_existing_dependencies(repo: Path, metadata: PackageMetadata, args: argparse.Namespace) -> None:
    host_os = platform.system().lower()
    host_arch = platform.machine().lower()
    if host_os != "linux" or host_arch not in {"x86_64", "amd64"}:
        raise BundleError("Existing dependencies are not proven Linux x64 compatible.", EXIT_DEPENDENCY)
    if args.target_platform != "linux" or args.target_arch != "x64":
        raise BundleError("Existing dependency packaging currently requires linux/x64.", EXIT_DEPENDENCY)
    node = run_command(["node", "--version"])
    if node.returncode != 0 or not node.stdout.strip().startswith("v22."):
        raise BundleError("Existing dependencies require a locally installed Node 22 runtime.", EXIT_DEPENDENCY)
    paths = dependency_paths(repo, metadata)
    if not paths:
        raise BundleError("No existing dependency installation was found.", EXIT_DEPENDENCY)
    if metadata.manager == "pnpm" and not (repo / "node_modules/.pnpm").is_dir():
        raise BundleError("pnpm installation lacks node_modules/.pnpm.", EXIT_DEPENDENCY)
    if (repo / "node_modules").is_dir() and not (repo / "node_modules/.bin").is_dir():
        raise BundleError("node_modules appears incomplete because .bin is absent.", EXIT_DEPENDENCY)


def install_command(metadata: PackageMetadata, install_scripts: bool) -> list[str]:
    if metadata.manager == "npm":
        command = ["npm", "ci"]
        if not install_scripts:
            command.append("--ignore-scripts")
        return command
    if metadata.manager == "pnpm":
        command = ["pnpm", "install", "--frozen-lockfile"]
        if not install_scripts:
            command.append("--ignore-scripts")
        return command
    if metadata.manager == "yarn":
        command = ["yarn", "install", "--immutable"]
        if not install_scripts:
            command.extend(["--mode", "skip-builds"])
        return command
    raise BundleError(
        "Bun-native dependency preparation is unavailable in the Node-only target.",
        EXIT_DEPENDENCY,
    )


def safe_extract_zip(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(source, "r") as archive:
        for member in archive.infolist():
            safe_member_name(member.filename)
            target = (destination / member.filename).resolve()
            if not path_within(target, destination.resolve()):
                raise BundleError("ZIP extraction would escape its root.", EXIT_ARCHIVE)
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                link_target = archive.read(member).decode("utf-8")
                link_path = destination / member.filename
                link_path.parent.mkdir(parents=True, exist_ok=True)
                resolved = (link_path.parent / link_target).resolve()
                if not path_within(resolved, destination.resolve()):
                    raise BundleError("ZIP symlink would escape its root.", EXIT_ARCHIVE)
                link_path.symlink_to(link_target)
            else:
                archive.extract(member, destination)
                if mode:
                    os.chmod(destination / member.filename, stat.S_IMODE(mode))


def docker_prepare_dependencies(
    source_zip: Path,
    metadata: PackageMetadata,
    args: argparse.Namespace,
    staging_root: Path,
) -> tuple[Path, str, list[str]]:
    if shutil.which("docker") is None:
        raise BundleError("Docker is unavailable for dependency preparation.", EXIT_DEPENDENCY)
    if metadata.ambiguities or metadata.manager == "ambiguous":
        raise BundleError("Resolve package-manager ambiguity before installing dependencies.", EXIT_DEPENDENCY)
    source_root = staging_root / "dependency-source"
    source_root.mkdir()
    safe_extract_zip(source_zip, source_root)
    image_name = f"node:{args.target_node_version}-bookworm"
    install = install_command(metadata, args.install_scripts)
    shell_script: list[str] = []
    if metadata.manager in {"pnpm", "yarn"}:
        shell_script.extend(["corepack", "enable", "&&"])
        if metadata.manager_version:
            shell_script.extend([
                "corepack", "prepare", f"{metadata.manager}@{metadata.manager_version}",
                "--activate", "&&",
            ])
    shell_script.extend(install)
    command_text = " ".join(shell_script)
    docker_argv = [
        "docker", "run", "--rm", "--platform=linux/amd64",
        "-e", "CI=1", "-v", f"{source_root}:/workspace", "-w", "/workspace",
        image_name, "sh", "-lc", command_text,
    ]
    result = run_command(docker_argv, timeout=1800)
    if result.returncode != 0:
        raise BundleError(
            "Dependency installation failed in Docker; inspect locally without exposing logs.",
            EXIT_DEPENDENCY,
        )
    return source_root, image_name, docker_argv


def create_dependency_tar(destination: Path, root: Path, metadata: PackageMetadata) -> dict[str, Any]:
    paths = dependency_paths(root, metadata)
    if not paths:
        raise BundleError("Dependency preparation produced no package artifacts.", EXIT_DEPENDENCY)
    with tarfile.open(destination, "w:gz", format=tarfile.PAX_FORMAT, dereference=False) as archive:
        for path in sorted(paths, key=lambda value: relative_posix(value, root)):
            archive.add(path, arcname=relative_posix(path, root), recursive=True)
    return verify_dependency_tar(destination, metadata)


def verify_dependency_tar(path: Path, metadata: PackageMetadata) -> dict[str, Any]:
    names: list[str] = []
    node_binaries: list[str] = []
    with tarfile.open(path, "r:gz") as archive:
        for member in archive.getmembers():
            safe_member_name(member.name)
            if member.isdev() or member.isfifo():
                raise BundleError("Dependency tar contains a device or FIFO.", EXIT_VERIFY)
            base = PurePosixPath(member.name).parent
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                combined = target if member.islnk() else base / target
                normalized = posixpath.normpath(combined.as_posix())
                if target.is_absolute() or normalized == ".." or normalized.startswith("../"):
                    raise BundleError("Dependency tar contains an unsafe link.", EXIT_VERIFY)
            names.append(member.name)
            if member.name.endswith(".node"):
                node_binaries.append(member.name)
    if metadata.manager == "pnpm" and not any(name.startswith("node_modules/.pnpm/") for name in names):
        raise BundleError("Dependency tar lacks pnpm .pnpm layout.", EXIT_VERIFY)
    if any(name.startswith("node_modules/") for name in names) and not any(
        name.startswith("node_modules/.bin/") for name in names
    ):
        raise BundleError("Dependency tar lacks node_modules/.bin.", EXIT_VERIFY)
    return {"members": len(names), "node_binaries": sorted(node_binaries)}


def run_docker_verification(
    source_zip: Path,
    dependency_tar: Path | None,
    metadata: PackageMetadata,
    args: argparse.Namespace,
    staging_root: Path,
) -> tuple[str, list[dict[str, Any]]]:
    if shutil.which("docker") is None:
        raise BundleError("Docker is unavailable for requested verification.", EXIT_VERIFY)
    root = staging_root / "verification-source"
    root.mkdir()
    safe_extract_zip(source_zip, root)
    if dependency_tar:
        with tarfile.open(dependency_tar, "r:gz") as archive:
            verify_dependency_tar(dependency_tar, metadata)
            archive.extractall(root, filter="data")
    image_name = f"node:{args.target_node_version}-bookworm"
    actions: list[dict[str, Any]] = []
    report_lines = ["AI review bundle verification", f"Image: {image_name}", ""]
    for script in ("typecheck", "test", "lint", "build"):
        if script not in metadata.scripts:
            continue
        argv = [
            "docker", "run", "--rm", "--network=none", "--platform=linux/amd64",
            "-e", "CI=1", "-v", f"{root}:/workspace", "-w", "/workspace",
            image_name, metadata.manager, "run", script,
        ]
        result = run_command(argv, timeout=600)
        actions.append({"script": script, "exit_code": result.returncode})
        report_lines.append(f"{metadata.manager} run {script}: exit {result.returncode}")
        if result.returncode != 0:
            raise BundleError(f"Verification script failed: {script}", EXIT_VERIFY)
    return "\n".join(report_lines) + "\n", actions


def installed_versions() -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for command in ("node", "npm", "pnpm", "yarn", "bun"):
        if shutil.which(command) is None:
            versions[command] = None
            continue
        result = run_command([command, "--version"], timeout=10)
        value = result.stdout.strip().splitlines()
        versions[command] = value[0][:80] if result.returncode == 0 and value else None
    return versions


def planned_names(name: str, args: argparse.Namespace) -> list[str]:
    names = [
        f"{name}-source.zip",
        f"{name}-manifest.json",
        f"{name}-checksums.sha256",
        f"{name}-review-template.md",
    ]
    if args.include_dependencies:
        names.append(f"{name}-dependencies-linux-x64-node22.tar.gz")
    if args.include_git_history:
        names.append(f"{name}-history.git.bundle")
    if args.run_verification:
        names.append(f"{name}-verification.txt")
    return names


def ensure_outputs_available(output: Path, names: Sequence[str], force: bool) -> None:
    if not force:
        existing = [name for name in names if (output / name).exists()]
        if existing:
            raise BundleError(
                "Output exists; use --force to replace only the named bundle artifacts: "
                + ", ".join(existing),
                EXIT_USAGE,
            )


def print_dry_run(
    repo: Path,
    output: Path,
    name: str,
    metadata: PackageMetadata,
    selection: Selection,
    args: argparse.Namespace,
) -> None:
    print(f"Project: {name}")
    print(f"Package manager: {metadata.manager}")
    if metadata.ambiguities:
        print("Ambiguities: " + "; ".join(metadata.ambiguities))
    print(f"Dependency strategy: {'none' if not args.include_dependencies else args.dependency_source}")
    if args.include_dependencies and args.dependency_source in {"auto", "docker"}:
        print(f"Planned Docker image: node:{args.target_node_version}-bookworm")
        print("Install scripts: " + ("enabled" if args.install_scripts else "disabled"))
    print("Planned outputs:")
    for filename in planned_names(name, args):
        print(f"  {output / filename}")
    print("Included paths:")
    for path in selection.files:
        print(f"  {relative_posix(path, repo)}")
    print("Excluded paths:")
    for path, reason in sorted(selection.excluded.items()):
        print(f"  {path}: {reason}")
    if selection.findings:
        print("Sensitive findings:")
        for finding in selection.findings:
            print(f"  {finding.path}: {finding.reason} (value redacted)")


def write_checksums(path: Path, artifacts: Sequence[Path]) -> None:
    lines = [f"{sha256_file(artifact)}  {artifact.name}" for artifact in artifacts]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    for line, artifact in zip(lines, artifacts):
        expected = line.split("  ", 1)[0]
        if sha256_file(artifact) != expected:
            raise BundleError(f"Checksum verification failed: {artifact.name}", EXIT_VERIFY)


def manifest_data(
    repo: Path,
    name: str,
    metadata: PackageMetadata,
    git_state: dict[str, Any],
    selection: Selection,
    args: argparse.Namespace,
    artifact_paths: Sequence[Path],
    source_verification: dict[str, Any],
    dependency_verification: dict[str, Any] | None,
    verification_actions: list[dict[str, Any]],
    docker_image: str | None,
    docker_command: list[str] | None,
) -> dict[str, Any]:
    return {
        "script_version": VERSION,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "project_name": name,
        "repository_basename": repo.name,
        "repository_type": "workspace" if metadata.workspaces else "single-package",
        "workspaces": metadata.workspaces,
        "package_manager": {
            "name": metadata.manager,
            "version": metadata.manager_version,
            "declaration": metadata.package_manager_field,
            "ambiguities": metadata.ambiguities,
        },
        "node_engine": metadata.node_engine,
        "target": {
            "node": args.target_node_version,
            "platform": args.target_platform,
            "arch": args.target_arch,
        },
        "host": {"os": platform.system(), "arch": platform.machine(), "tools": installed_versions()},
        "package_jsons": metadata.package_jsons,
        "lockfiles": metadata.lockfiles,
        "scripts": metadata.scripts,
        "native_dependency_warnings": metadata.native_warnings,
        "detected_project_files": metadata.detected_files,
        "source": {
            "file_count": len(selection.files) + 2 + (1 if args.include_git_diff else 0),
            "uncompressed_bytes": selection.total_bytes,
            "excluded": selection.excluded,
            "allow_patterns": args.allow_file,
            "exclude_patterns": args.exclude_file,
            "verification": source_verification,
        },
        "sensitive_scan": {
            "result": "passed",
            "files_scanned": len(selection.files),
            "finding_count": 0,
            "limitations": "Heuristics reduce risk but cannot prove that no secrets remain.",
        },
        "git": git_state,
        "install_scripts": args.install_scripts,
        "dependency": {
            "requested": args.include_dependencies,
            "source": args.dependency_source if args.include_dependencies else None,
            "docker_image": docker_image,
            "docker_command": docker_command,
            "verification": dependency_verification,
        },
        "verification_actions": verification_actions,
        "output_artifact_names": planned_names(name, args),
        "artifacts": [artifact_record(path) for path in artifact_paths],
        "warnings": selection.warnings,
        "limitations": ([
            "Bun-native runtime testing is unavailable in the Node-only receiving environment."
        ] if metadata.bun_native else []),
    }


def move_artifacts(staging: Path, output: Path, names: Sequence[str], force: bool) -> list[Path]:
    output.mkdir(parents=True, exist_ok=True)
    moved: list[Path] = []
    for name in names:
        source = staging / name
        destination = output / name
        if destination.exists():
            if not force:
                raise BundleError(f"Output already exists: {name}", EXIT_USAGE)
            if destination.is_dir():
                raise BundleError(f"Refusing to replace directory: {name}", EXIT_USAGE)
            destination.unlink()
        os.replace(source, destination)
        moved.append(destination)
    return moved


def prepare(args: argparse.Namespace) -> list[Path]:
    repo, output, name = validate_args(args)
    metadata = detect_metadata(repo)
    selection = select_sources(repo, output, name, args.allow_file, args.exclude_file)
    if selection.findings:
        details = "; ".join(
            f"{finding.path}: {finding.reason} (value redacted)"
            for finding in selection.findings
        )
        raise BundleError(
            "Probable sensitive data found. Replace it with a placeholder or exclude the file: "
            + details,
            EXIT_SENSITIVE,
        )
    names = planned_names(name, args)
    ensure_outputs_available(output, names, args.force)
    if args.dry_run:
        print_dry_run(repo, output, name, metadata, selection, args)
        return []

    output.parent.mkdir(parents=True, exist_ok=True)
    git_state = detect_git_state(repo)
    review_content = (
        args.review_file.read_text(encoding="utf-8")
        if args.review_file
        else review_template(metadata, args.target_node_version)
    )
    review_findings = scan_text("AI_REVIEW_CONTEXT.md", review_content)
    if review_findings:
        raise BundleError("Review context contains probable sensitive data.", EXIT_SENSITIVE)
    info_content = bundle_info(metadata, args)
    git_patch = create_git_patch(repo) if args.include_git_diff else None

    with tempfile.TemporaryDirectory(prefix=f".{name}-bundle-", dir=output.parent) as temp:
        staging = Path(temp)
        review_path = staging / f"{name}-review-template.md"
        review_path.write_text(review_content, encoding="utf-8")
        source_path = staging / f"{name}-source.zip"
        create_source_zip(source_path, repo, selection, review_content, info_content, git_patch)
        source_verification = verify_source_zip(source_path, args.allow_file)
        pre_manifest: list[Path] = [source_path, review_path]
        dependency_path: Path | None = None
        dependency_verification: dict[str, Any] | None = None
        docker_image: str | None = None
        docker_command: list[str] | None = None

        if args.include_dependencies:
            source_mode = args.dependency_source
            if source_mode == "auto":
                source_mode = "docker"
                if (repo / "node_modules").is_dir():
                    try:
                        validate_existing_dependencies(repo, metadata, args)
                        source_mode = "existing"
                    except BundleError:
                        source_mode = "docker"
            dependency_path = staging / f"{name}-dependencies-linux-x64-node22.tar.gz"
            if source_mode == "existing":
                validate_existing_dependencies(repo, metadata, args)
                dependency_root = repo
            else:
                dependency_root, docker_image, docker_command = docker_prepare_dependencies(
                    source_path, metadata, args, staging
                )
            dependency_verification = create_dependency_tar(
                dependency_path, dependency_root, metadata
            )
            pre_manifest.append(dependency_path)

        if args.include_git_history:
            history_path = staging / f"{name}-history.git.bundle"
            create_git_bundle(repo, history_path)
            pre_manifest.append(history_path)

        verification_actions: list[dict[str, Any]] = []
        if args.run_verification:
            report, verification_actions = run_docker_verification(
                source_path, dependency_path, metadata, args, staging
            )
            verification_path = staging / f"{name}-verification.txt"
            verification_path.write_text(report, encoding="utf-8")
            pre_manifest.append(verification_path)

        manifest_path = staging / f"{name}-manifest.json"
        manifest = manifest_data(
            repo, name, metadata, git_state, selection, args, pre_manifest,
            source_verification, dependency_verification, verification_actions,
            docker_image, docker_command,
        )
        manifest_path.write_text(stable_json(manifest), encoding="utf-8")
        checksummed = [*pre_manifest, manifest_path]
        checksum_path = staging / f"{name}-checksums.sha256"
        write_checksums(checksum_path, checksummed)
        expected = {path.name for path in checksummed}
        recorded = {
            line.split("  ", 1)[1]
            for line in checksum_path.read_text(encoding="utf-8").splitlines()
        }
        if recorded != expected:
            raise BundleError("Checksum file does not cover every artifact.", EXIT_VERIFY)
        ordered_names = [path.name for path in checksummed] + [checksum_path.name]
        return move_artifacts(staging, output, ordered_names, args.force)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        artifacts = prepare(args)
    except BundleError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    except KeyboardInterrupt:
        print("error: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"error: unexpected {type(exc).__name__}", file=sys.stderr)
        return 1
    if args.dry_run:
        print("Dry run complete; no artifacts, installations, or containers were created.")
    else:
        print("Created and verified:")
        for artifact in artifacts:
            print(f"  {artifact}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
