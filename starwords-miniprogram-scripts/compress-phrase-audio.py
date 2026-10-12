# 把例句 TTS mp3 压成小体积（16kHz mono 低码率），输出到 assets/phrases 供主包打包
# 用法：python compress-phrase-audio.py [bitrate]   默认 16 kbps
import sys
from pathlib import Path

import lameenc
import miniaudio
import numpy as np

HERE = Path(__file__).parent
SRC = HERE / "_tmp_phrase"
OUT = HERE.parent / "starwords-miniprogram" / "assets" / "phrases"

TARGET_SR = 16000
BITRATE = int(sys.argv[1]) if len(sys.argv) > 1 else 16


def process(path: Path, dest: Path) -> float:
    data = miniaudio.decode_file(str(path))
    samples = np.array(data.samples, dtype=np.int16)
    if data.nchannels > 1:
        samples = samples.reshape(-1, data.nchannels).mean(axis=1).astype(np.int16)
    duration = len(samples) / data.sample_rate
    if data.sample_rate != TARGET_SR:
        target_len = int(duration * TARGET_SR)
        indices = np.linspace(0, len(samples) - 1, target_len)
        samples = np.interp(indices, np.arange(len(samples)), samples.astype(np.float64))
        samples = samples.astype(np.int16)
    # 裁剪首尾静音
    amp = np.abs(samples.astype(np.int32))
    threshold = max(300, int(amp.max() * 0.02))
    voiced = np.where(amp > threshold)[0]
    if len(voiced) > 0:
        pad = int(TARGET_SR * 0.06)
        start = max(0, voiced[0] - pad)
        end = min(len(samples), voiced[-1] + pad)
        samples = samples[start:end]
    # 归一化响度
    peak = np.abs(samples).max()
    if peak > 0:
        samples = (samples.astype(np.float64) * (28000 / peak)).clip(-32767, 32767).astype(np.int16)
    enc = lameenc.Encoder()
    enc.set_bit_rate(BITRATE)
    enc.set_in_sample_rate(TARGET_SR)
    enc.set_channels(1)
    enc.set_quality(2)
    mp3 = enc.encode(samples.tobytes())
    mp3 += enc.flush()
    dest.write_bytes(bytes(mp3))
    return len(samples) / TARGET_SR


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    dur_total = 0.0
    count = 0
    longest = ("", 0.0)
    for f in sorted(SRC.glob("*.mp3")):
        d = process(f, OUT / f.name)
        dur_total += d
        count += 1
        if d > longest[1]:
            longest = (f.name, d)
    total = sum(f.stat().st_size for f in OUT.glob("*.mp3"))
    print(
        f"bitrate={BITRATE}kbps files={count} total={total / 1024:.0f} KB "
        f"avg={total / max(count, 1) / 1024:.2f} KB "
        f"avg_dur={dur_total / max(count, 1):.2f}s longest={longest[0]}={longest[1]:.2f}s"
    )


if __name__ == "__main__":
    main()
