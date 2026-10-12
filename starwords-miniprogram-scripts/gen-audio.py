# 用 edge-tts 为全部单词生成儿童友好的英文发音 mp3
import asyncio
import json
import os
import sys
from pathlib import Path

import edge_tts

HERE = Path(__file__).parent
OUT = HERE.parent / "starwords-miniprogram" / "assets" / "audio"
OUT.mkdir(parents=True, exist_ok=True)

VOICE = "en-US-AnaNeural"  # 儿童音色
RATE = "-15%"              # 略慢，适合儿童听辨
CONCURRENCY = 8


async def gen(word: str, dest: Path, sem: asyncio.Semaphore) -> bool:
    if dest.exists() and dest.stat().st_size > 1000:
        return True
    text = word.replace("yesterday", "yesterday").replace("today", "today")
    text = word.replace("morning", "morning").replace("tomorrow", "tomorrow")
    # 直接读单词本身
    text = word
    async with sem:
        for attempt in range(3):
            try:
                tts = edge_tts.Communicate(text, VOICE, rate=RATE)
                await tts.save(str(dest))
                return True
            except Exception as e:
                if attempt == 2:
                    print(f"FAIL {word}: {e}", file=sys.stderr)
                    return False
                await asyncio.sleep(2)


async def main() -> None:
    words = json.loads((HERE / "words.json").read_text(encoding="utf8"))
    sem = asyncio.Semaphore(CONCURRENCY)
    tasks = []
    for w in words:
        dest = OUT / f"{w['id']}.mp3"
        tasks.append(gen(w["word"], dest, sem))
    results = await asyncio.gather(*tasks)
    ok = sum(1 for r in results if r)
    print(f"done: {ok}/{len(words)}")


if __name__ == "__main__":
    asyncio.run(main())
