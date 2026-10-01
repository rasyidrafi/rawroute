#!/usr/bin/env python3
"""Query Bun Docs AI and collect its streamed SSE response."""

import json
import sys
import urllib.error
import urllib.request


ENDPOINT = "https://bun.sh/docs/ask"


def ask(question: str) -> tuple[str, list[dict]]:
    payload = {
        "messages": [{"role": "user", "content": question}],
        "page": {"path": "/docs", "title": "Welcome to Bun"},
    }
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", "accept": "text/event-stream"},
        method="POST",
    )

    answer: list[str] = []
    sources: list[dict] = []
    with urllib.request.urlopen(request, timeout=90) as response:
        if response.status != 200:
            raise RuntimeError(f"Bun Docs AI returned HTTP {response.status}")
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line.startswith("data: "):
                continue
            try:
                event = json.loads(line[6:])
            except json.JSONDecodeError:
                continue
            if event.get("type") == "text":
                answer.append(event.get("delta", ""))
            elif event.get("type") == "done":
                sources = event.get("sources") or []
                break
    return "".join(answer).strip(), sources


def main() -> int:
    if len(sys.argv) < 2 or not " ".join(sys.argv[1:]).strip():
        print(f"Usage: {sys.argv[0]} QUESTION", file=sys.stderr)
        return 2
    question = " ".join(sys.argv[1:]).strip()
    try:
        answer, sources = ask(question)
    except (urllib.error.URLError, TimeoutError, RuntimeError) as error:
        print(f"ask-bun: request failed: {error}", file=sys.stderr)
        return 1
    if not answer:
        print("ask-bun: received no answer", file=sys.stderr)
        return 1
    print(answer)
    if sources:
        print("\nSources:")
        for source in sources:
            title = source.get("title", "Source")
            url = source.get("url", "")
            print(f"- {title}: {url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
