"""mitmdump addon：把 Command Code CLI 的 API 流量落成 raw JSONL。

用法（在仓库根目录）：

    mitmdump --listen-host 127.0.0.1 -p 8080 \
        -s capture/cc_capture_addon.py \
        -w ~/.cc-capture/flows.bin

- host 以 commandcode.ai 结尾的请求才会追加写入 ~/.cc-capture/requests.jsonl；
  `-w flows.bin` 仍保留全部流量（含 registry.npmjs.org 等），仅供排查。
- 原始数据（~/.cc-capture/）永不入库；入库前必须先过 scripts/capture/sanitize.py。
- 输出目录可用环境变量 CC_CAPTURE_DIR 覆盖，默认 ~/.cc-capture。
"""

from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

TARGET_HOST_SUFFIX = "commandcode.ai"


def _capture_dir() -> Path:
    path = Path(os.environ.get("CC_CAPTURE_DIR", "~/.cc-capture")).expanduser()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _content_bytes(message) -> bytes | None:
    """取已按 Content-Encoding 解码的 body，失败时退回原始字节。"""
    try:
        content = message.content
    except Exception:
        content = message.raw_content
    return content


def _decode_body(content: bytes | None) -> tuple[str | None, str | None]:
    """返回 (utf-8 文本, base64)，二者互斥，空 body 返回 (None, None)。"""
    if not content:
        return None, None
    try:
        return content.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, base64.b64encode(content).decode("ascii")


def _header_pairs(headers) -> list[list[str]]:
    # fields 保留重复头与原始出现顺序——头序是伪装规格要校准的事实之一
    return [
        [k.decode("utf-8", "replace"), v.decode("utf-8", "replace")]
        for k, v in headers.fields
    ]


class CcCapture:
    """每条完成响应的 commandcode.ai 流量写一行 JSON。"""

    def __init__(self) -> None:
        self._out_path = _capture_dir() / "requests.jsonl"

    def response(self, flow) -> None:
        request = flow.request
        if not request.pretty_host.endswith(TARGET_HOST_SUFFIX):
            return
        response = flow.response
        req_text, req_b64 = _decode_body(_content_bytes(request))
        resp_text, resp_b64 = _decode_body(_content_bytes(response)) if response else (None, None)
        record = {
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "request_timestamp": request.timestamp_start,
            "response_timestamp": getattr(response, "timestamp_end", None),
            "method": request.method,
            "url": request.pretty_url,
            "http_version": request.http_version,
            "request_headers": _header_pairs(request.headers),
            "request_body_text": req_text,
            "request_body_b64": req_b64,
            "status_code": response.status_code if response else None,
            "response_headers": _header_pairs(response.headers) if response else [],
            "response_body_text": resp_text,
            "response_body_b64": resp_b64,
            "error": repr(flow.error) if flow.error else None,
        }
        with self._out_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        logging.info(
            "captured %s %s -> %s", request.method, request.path, record["status_code"]
        )

    def error(self, flow) -> None:
        # 客户端不信任 CA、连接被 CLI 主动掐断等情况会走到这里，必须留痕方便排障
        request = flow.request
        if request.pretty_host.endswith(TARGET_HOST_SUFFIX) and flow.error:
            logging.warning("%s %s failed: %s", request.method, request.path, flow.error)


addons = [CcCapture()]
