#!/usr/bin/env python3
"""把 cc_capture_addon.py 抓到的 raw JSONL 脱敏成可入库样本。

用法（uv 原生支持 PEP 723，依赖为零）：

    uv run capture/sanitize.py [--raw ~/.cc-capture/requests.jsonl] [--out capture/samples]

脱敏三原则：

- 形状保留：64 位 hex 哈希、UUID（保留版本/变体位）、``sess_*``、traceparent（保留
  version/flags）、``x-project-slug`` 用同形状伪值替换——规格校准依赖的长度、字符集、
  结构位原样保留，但内容不可回溯；
- 身份清除：Authorization/key/cookie/JWT/email、prompt 与工具 schema 等长文本、
  文件路径一律替换为占位符；
- 结构保留：字段名、类型、嵌套层级、数组长度、数值与布尔原样保留。

同一运行内相同输入映射到相同伪值（保持会话内关联），跨运行伪值不同。
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import secrets
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

TARGET_HOST_SUFFIX = "commandcode.ai"

# 每次运行重新生成 HMAC key：同值映射一致，且伪值不可逆推原文
RUN_KEY = secrets.token_bytes(32)

RE_SHA256 = re.compile(r"^[0-9a-f]{64}$")
RE_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)
RE_SESS = re.compile(r"^sess_[0-9a-fA-F]{8,64}$")
RE_TRACEPARENT = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")
RE_JWT = re.compile(r"^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$")
RE_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
RE_KEYLIKE = re.compile(r"^(user_|sk-)[A-Za-z0-9_-]{8,}$")
# Stripe 式资源 ID（sub_/price_/cus_/prod_ 等）关联账号，只保留前缀形状
RE_STRIPE = re.compile(
    r"^(sub|price|plan|cus|prod|in|ch|acct|cs|pm|pi|seti|src|tok|fee|whsec|rk)_[A-Za-z0-9]{8,}$"
)
RE_PATHISH = re.compile(r"^([A-Za-z]:\\|/|~)")
RE_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{7,}$")

CREDENTIAL_HEADERS = {"authorization", "proxy-authorization", "x-api-key"}
DROPPED_HEADERS = {"cookie", "set-cookie"}

GROUP_ORDER = ["generate", "fingerprint-record", "lifecycle-events", "models", "other"]


def _pseudo_hex(n_chars: int, salt: str) -> str:
    digest = b""
    counter = 0
    while len(digest) < n_chars:
        digest += hmac.new(RUN_KEY, f"{salt}:{counter}".encode(), hashlib.sha256).hexdigest().encode()
        counter += 1
    return digest.decode()[:n_chars]


def pseudo_sha256(value: str) -> str:
    return _pseudo_hex(64, "sha256:" + value.lower())


def pseudo_uuid(value: str) -> str:
    h = _pseudo_hex(32, "uuid:" + value)
    u = f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
    # 保留 RFC 4122 版本位与变体位：「是不是 v4」是规格要校准的事实
    version = value[14] if len(value) > 14 else "4"
    variant = value[19] if len(value) > 19 else "8"
    return u[:14] + version + u[15:19] + variant + u[20:]


def pseudo_sess(value: str) -> str:
    return "sess_" + _pseudo_hex(len(value) - 5, "sess:" + value)


def pseudo_traceparent(value: str) -> str:
    m = RE_TRACEPARENT.match(value)
    if not m:
        return f"<redacted len={len(value)}>"
    version, _trace, _span, flags = m.groups()
    return (
        f"{version}-{_pseudo_hex(32, 'trace:' + value)}"
        f"-{_pseudo_hex(16, 'span:' + value)}-{flags}"
    )


def pseudo_slug(value: str) -> str:
    pool = "abcdefghijklmnopqrstuvwxyz0123456789"
    h = _pseudo_hex(len(value) * 2, "slug:" + value)
    return "".join(
        ch if ch == "-" else pool[int(h[i * 2 : i * 2 + 2], 16) % len(pool)]
        for i, ch in enumerate(value)
    )


def sanitize_header(name: str, value: str, stats: Counter) -> str:
    lname = name.lower()
    if lname in DROPPED_HEADERS:
        stats["header_dropped"] += 1
        return f"<dropped {lname}>"
    if lname in CREDENTIAL_HEADERS:
        stats["credential_redacted"] += 1
        scheme, _, token = value.partition(" ")
        token = token or scheme
        scheme = scheme if token != scheme else "?"
        return f"{scheme} <redacted-key prefix={token[:5]} len={len(token)}>"
    if RE_JWT.match(value):
        stats["jwt_redacted"] += 1
        return f"<redacted-jwt len={len(value)}>"
    if RE_EMAIL.match(value):
        stats["email_redacted"] += 1
        return "<redacted-email>"
    if RE_STRIPE.match(value):
        stats["stripe_id_redacted"] += 1
        prefix = value.split("_", 1)[0]
        return f"<redacted-{prefix}-id len={len(value)}>"
    if RE_SHA256.match(value.lower()):
        stats["hash_pseudonymized"] += 1
        return pseudo_sha256(value)
    if RE_UUID.match(value):
        stats["uuid_pseudonymized"] += 1
        return pseudo_uuid(value)
    if RE_SESS.match(value):
        stats["session_pseudonymized"] += 1
        return pseudo_sess(value)
    if RE_TRACEPARENT.match(value):
        stats["traceparent_pseudonymized"] += 1
        return pseudo_traceparent(value)
    if lname == "x-project-slug" and RE_SLUG.match(value):
        stats["slug_pseudonymized"] += 1
        return pseudo_slug(value)
    if RE_KEYLIKE.match(value):
        stats["credential_redacted"] += 1
        return f"<redacted-key len={len(value)}>"
    return value


def sanitize_string(value: str, stats: Counter) -> str:
    if RE_SHA256.match(value.lower()):
        stats["hash_pseudonymized"] += 1
        return pseudo_sha256(value)
    if RE_UUID.match(value):
        stats["uuid_pseudonymized"] += 1
        return pseudo_uuid(value)
    if RE_SESS.match(value):
        stats["session_pseudonymized"] += 1
        return pseudo_sess(value)
    if RE_TRACEPARENT.match(value):
        stats["traceparent_pseudonymized"] += 1
        return pseudo_traceparent(value)
    if RE_JWT.match(value) or RE_EMAIL.match(value) or RE_KEYLIKE.match(value):
        stats["string_redacted"] += 1
        return f"<redacted len={len(value)}>"
    if RE_STRIPE.match(value):
        stats["stripe_id_redacted"] += 1
        prefix = value.split("_", 1)[0]
        return f"<redacted-{prefix}-id len={len(value)}>"
    if RE_PATHISH.match(value):
        stats["path_redacted"] += 1
        return f"<redacted-path len={len(value)}>"
    if len(value) > 120:
        stats["long_text_redacted"] += 1
        return f"<redacted-text len={len(value)}>"
    return value


def sanitize_json(node, stats: Counter):
    if isinstance(node, dict):
        return {k: sanitize_json(v, stats) for k, v in node.items()}
    if isinstance(node, list):
        return [sanitize_json(v, stats) for v in node]
    if isinstance(node, str):
        return sanitize_string(node, stats)
    return node


def sanitize_payload_text(text: str, stats: Counter):
    text = text.strip()
    if not text:
        return None
    try:
        return {"_format": "json", "value": sanitize_json(json.loads(text), stats)}
    except json.JSONDecodeError:
        pass
    lines = [line for line in text.splitlines() if line.strip()]
    parsed = []
    try:
        parsed = [json.loads(line) for line in lines]
    except json.JSONDecodeError:
        return {"_format": "text", "value": sanitize_string(text, stats)}
    # 上游流式响应是 NDJSON，逐行脱敏后按原行序保留
    return {"_format": "ndjson", "lines": [sanitize_json(obj, stats) for obj in parsed]}


def sanitize_payload(text: str | None, b64: str | None, stats: Counter):
    if text is not None:
        return sanitize_payload_text(text, stats)
    if b64 is not None:
        stats["binary_redacted"] += 1
        return f"<redacted-binary b64_len={len(b64)}>"
    return None


def sanitize_url(url: str, stats: Counter) -> str:
    parts = urlsplit(url)
    query = ""
    if parts.query:
        kept = []
        for kv in parts.query.split("&"):
            name, sep, value = kv.partition("=")
            kept.append(name + "=" + (sanitize_string(value, stats) if value else ""))
        query = "?" + "&".join(kept)
    return f"{parts.scheme}://{parts.netloc}{parts.path}{query}"


def sanitize_record(rec: dict, stats: Counter) -> dict:
    out = {
        "captured_at": rec.get("captured_at"),
        "method": rec.get("method"),
        "url": sanitize_url(rec.get("url", ""), stats),
        "http_version": rec.get("http_version"),
        "request_headers": [
            [name, sanitize_header(name, value, stats)]
            for name, value in rec.get("request_headers", [])
        ],
        "request_body": sanitize_payload(
            rec.get("request_body_text"), rec.get("request_body_b64"), stats
        ),
        "status_code": rec.get("status_code"),
        "response_headers": [
            [name, sanitize_header(name, value, stats)]
            for name, value in rec.get("response_headers", [])
        ],
        "response_body": sanitize_payload(
            rec.get("response_body_text"), rec.get("response_body_b64"), stats
        ),
        "error": rec.get("error"),
    }
    if "/alpha/whoami" in rec.get("url", ""):
        body = out.get("response_body")
        if isinstance(body, dict) and isinstance(body.get("value"), dict):
            user = body["value"].get("user")
            if isinstance(user, dict):
                for key in ("name", "userName"):
                    if isinstance(user.get(key), str):
                        user[key] = f"<redacted len={len(user[key])}>"
                        stats["identity_redacted"] += 1
    return out


def group_of(url: str) -> str:
    path = urlsplit(url).path
    if path.startswith("/alpha/fingerprint"):
        return "fingerprint-record"
    if path.startswith("/alpha/lifecycle"):
        return "lifecycle-events"
    if path.startswith("/alpha/generate"):
        return "generate"
    if path.startswith("/provider/v1/models"):
        return "models"
    return "other"


def find_header(rec: dict, name: str) -> str | None:
    for key, value in rec.get("request_headers", []):
        if key.lower() == name:
            return value
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raw", default="~/.cc-capture/requests.jsonl")
    parser.add_argument("--out", default="capture/samples")
    parser.add_argument(
        "--generate-keep",
        default="",
        help="generate 组仅保留指定序号的记录（逗号分隔，如 0,2,19）；默认全部保留",
    )
    args = parser.parse_args()

    raw_path = Path(args.raw).expanduser()
    out_dir = Path(args.out)
    if not raw_path.exists():
        sys.exit(f"raw 抓包文件不存在：{raw_path}")

    groups: dict[str, list[dict]] = {}
    stats_by_group: dict[str, Counter] = {}
    with raw_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            host = urlsplit(rec.get("url", "")).hostname or ""
            if not host.endswith(TARGET_HOST_SUFFIX):
                continue
            group = group_of(rec.get("url", ""))
            stats = stats_by_group.setdefault(group, Counter())
            groups.setdefault(group, []).append(sanitize_record(rec, stats))

    if not groups:
        sys.exit("raw 文件里没有 commandcode.ai 的流量——确认抓包时代理环境变量已生效")

    selection = ""
    keep = args.generate_keep.strip()
    if keep and "generate" in groups:
        indices = [int(x) for x in keep.split(",") if x.strip() != ""]
        groups["generate"] = [
            groups["generate"][i] for i in indices if i < len(groups["generate"])
        ]
        selection = keep

    out_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    for group in GROUP_ORDER:
        records = groups.get(group)
        if not records:
            continue
        stats = stats_by_group[group]
        cli_version = next(
            (v for r in records if (v := find_header(r, "x-command-code-version"))),
            None,
        )
        doc = {
            "_meta": {
                "source": "官方 command-code CLI 真实流量（mitmproxy 采集）",
                "endpoint_group": group,
                "record_count": len(records),
                "captured_at_first": records[0]["captured_at"],
                "captured_at_last": records[-1]["captured_at"],
                "cli_version": cli_version,
                "raw_source": str(raw_path) + "（不随仓库分发）",
                "records_selected": selection or "全部",
                "sanitized_at": now,
                "sanitizer": "capture/sanitize.py",
                "redaction_summary": dict(stats),
            },
            "requests": records,
        }
        out_file = out_dir / f"{group}.json"
        out_file.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"写出 {out_file}（{len(records)} 条）")

    total = Counter()
    for stats in stats_by_group.values():
        total.update(stats)
    print("脱敏动作合计：" + json.dumps(dict(total), ensure_ascii=False))
    print("提醒：入库前人工过目 captures/ 的 diff；raw 文件保留在本机，不要提交。")


if __name__ == "__main__":
    main()
