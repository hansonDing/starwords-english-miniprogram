# 为全部单词的例句生成发音 mp3（先输出到临时目录，便于测量体积后再决定放置位置）
import asyncio
import json
import sys
from pathlib import Path

import edge_tts

HERE = Path(__file__).parent
OUT = HERE / "_tmp_phrase"

VOICE = "en-US-AnaNeural"  # 儿童音色，与单词发音一致
RATE = "-15%"
CONCURRENCY = 8


async def gen(text: str, dest: Path, sem: asyncio.Semaphore) -> bool:
    if dest.exists() and dest.stat().st_size > 1000:
        return True
    async with sem:
        for attempt in range(3):
            try:
                tts = edge_tts.Communicate(text, VOICE, rate=RATE)
                await tts.save(str(dest))
                return True
            except Exception as e:
                if attempt == 2:
                    print(f"FAIL {text}: {e}", file=sys.stderr)
                    return False
                await asyncio.sleep(2)


async def main() -> None:
    OUT.mkdir(exist_ok=True)
    words = json.loads((HERE / "words.json").read_text(encoding="utf8"))
    sem = asyncio.Semaphore(CONCURRENCY)
    tasks = []
    for w in words:
        phrase = (w.get("phrase") or "").strip()
        if not phrase:
            continue
        tasks.append(gen(phrase, OUT / f"{w['id']}.mp3", sem))
    results = await asyncio.gather(*tasks)
    ok = sum(1 for r in results if r)
    total = sum(f.stat().st_size for f in OUT.glob("*.mp3"))
    print(f"done: {ok}/{len(tasks)} phrases, raw total: {total / 1024:.0f} KB")


if __name__ == "__main__":
    asyncio.run(main())
