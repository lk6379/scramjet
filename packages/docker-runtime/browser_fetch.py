import base64
import json
import sys

from curl_cffi import requests


MAX_RESPONSE_SIZE = 16 * 1024 * 1024
SKIPPED_RESPONSE_HEADERS = {
    "content-encoding",
    "content-length",
    "set-cookie",
    "transfer-encoding",
}


def main() -> None:
    payload = json.load(sys.stdin)
    body = base64.b64decode(payload["body"]) if payload.get("body") else None
    accept_encoding = "gzip, deflate, br, zstd"
    headers = [
        (name, value)
        for name, value in payload.get("headers", {}).items()
        if isinstance(name, str)
        and isinstance(value, str)
        and name.lower() != "accept-encoding"
    ]
    for name, value in payload.get("headers", {}).items():
        if isinstance(name, str) and name.lower() == "accept-encoding":
            accept_encoding = value
            break

    response = requests.request(
        method=str(payload.get("method") or "GET").upper(),
        url=payload["url"],
        headers=headers,
        data=body,
        impersonate="chrome",
        default_headers=False,
        accept_encoding=accept_encoding,
        allow_redirects=False,
        timeout=30,
    )
    if len(response.content) > MAX_RESPONSE_SIZE:
        raise ValueError("Browser fetch response is too large")

    response_headers = []
    for name, value in response.headers.multi_items():
        if name.lower() not in SKIPPED_RESPONSE_HEADERS:
            response_headers.append([name, value])

    result = {
        "status": response.status_code,
        "statusText": "",
        "responseUrl": str(response.url),
        "headers": response_headers,
        "body": base64.b64encode(response.content).decode("ascii"),
        "setCookies": response.headers.get_list("set-cookie"),
    }
    json.dump(result, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        json.dump({"error": str(error)}, sys.stdout, separators=(",", ":"))
        sys.exit(1)
