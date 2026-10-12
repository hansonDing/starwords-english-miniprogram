# 将 TTS mp3 重采样为 16kHz mono 并以低码率重编码，裁剪首尾静音
import json
from pathlib import Path

import lameenc
import miniaudio
import numpy as np

HERE = Path(__file__).parent
AUDIO = HERE.parent / "starwords-miniprogram" / "assets" / "audio"
TMP = HERE / "_tmp_audio"
TMP.mkdir(exist_ok=True)

TARGET_SR = 16000
BITRATE = 24


def process(path: Path, dest: Path) -> None:
    data = miniaudio.decode_file(str(path))
    samples = np.array(data.samples, dtype=np.int16)
    if data.nchannels > 1:
        samples = samples.reshape(-1, data.nchannels).mean(axis=1).astype(np.int16)
    # 重采样（线性插值）
    if data.sample_rate != TARGET_SR:
        duration = len(samples) / data.sample_rate
        target_len = int(duration * TARGET_SR)
        indices = np.linspace(0, len(samples) - 1, target_len)
        samples = np.interp(indices, np.arange(len(samples)), samples.astype(np.float64))
        samples = samples.astype(np.int16)
    # 裁剪首尾静音
    amp = np.abs(samples.astype(np.int32))
    threshold = max(300, int(amp.max() * 0.02))
    voiced = np.where(amp > threshold)[0]
    if len(voiced) > 0:
        pad = int(TARGET_SR * 0.08)
        start = max(0, voiced[0] - pad)
        end = min(len(samples), voiced[-1] + pad)
        then = len(samples)
        samples = samples[start:end]
        # 保存裁剪信息
        (dest.with_suffix(".cut").write_text(f"{then}->{len(samples)}")) if False else None
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


def main() -> None:
    total = 0
    files = sorted(AUDIO.glob("w*.mp3"))
    for f in files:
        dest = TMP / f.name
        process(f, dest)
        total += dest.stat().st_size
    # 覆盖回 assets
    for f in TMP.glob("*.mp3"):
        f.replace(AUDIO / f.name)
    TMP.rmdir()
    print(f"files: {len(files)}, total: {total/1024:.0f} KB")


if __name__ == "__main__":
    main()
