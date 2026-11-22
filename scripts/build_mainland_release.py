"""按明确白名单打包国内部署源码，不包含数据、密钥、Git 或 Node 依赖。"""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile


ROOT = Path(__file__).resolve().parent.parent
PUBLIC_FILES = (
    "index.html", "favicon.svg", "styles.css", "app.js", "api.js", "auth.js",
    "admin.js", "authorization-codes.js", "workspace.js", "steps.js", "ui.js", "credits.js", "artworks.js",
)
EXTRA_FILES = (
    "server.py", "scripts/migrate_d1.py", "scripts/mainland_load_test.py", "scripts/build_mainland_release.py",
    "deploy/mainland/aiht-creation-studio.service", "deploy/mainland/nginx.conf.example",
    "deploy/mainland/nginx-local-check.conf.example",
    "deploy/mainland/部署说明.md", "cloudflare/数据迁移说明.md",
)


def release_files(root):
    """白名单中的文件缺失或是符号链接时拒绝构建，避免悄悄漏包或混入外部文件。"""
    names = list(EXTRA_FILES) + ["public/" + name for name in PUBLIC_FILES]
    names += [path.relative_to(root).as_posix() for path in sorted((root / "studio").glob("*.py"))]
    if "studio/__init__.py" not in names:
        raise ValueError("缺少 studio 源码目录")
    for name in sorted(names):
        path = root / name
        if any(part.is_symlink() for part in (path, *path.parents)) or not path.is_file():
            raise ValueError("部署白名单文件不存在或含符号链接：" + name)
        yield name, path.read_bytes()


def build_release(root, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError("输出文件已存在，请选择新的发布文件名")
    files = list(release_files(root))
    manifest = {"format": "aiht-mainland-source-v1", "contains_user_data": False,
                "files": [{"path": name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
                          for name, payload in files]}
    encoded = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with output.open("xb") as raw:
            created = True
            compressed = gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0)
            with compressed:
                with tarfile.open(fileobj=compressed, mode="w") as archive:
                    for name, payload in files + [("RELEASE-MANIFEST.json", encoded)]:
                        info = tarfile.TarInfo(name)
                        info.size, info.mode, info.mtime = len(payload), 0o644, 0
                        info.uid = info.gid = 0
                        info.uname = info.gname = ""
                        archive.addfile(info, io.BytesIO(payload))
    except BaseException:
        # 只清理本次新建、尚未完成的输出；不覆盖既有发布文件。
        if created:
            output.unlink(missing_ok=True)
        raise
    return {"archive": str(output), "bytes": output.stat().st_size,
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "source_files": len(files),
            "contains_user_data": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="新建的 .tar.gz 发布包路径")
    args = parser.parse_args()
    try:
        result = build_release(ROOT, args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
