# 把 400 个单词/例句 mp3 按「原始 MP3 帧」直接拼成 40+40 个周包，播放时用段偏移定位。
#
# 为什么可以零重编码：
#   本工程的 mp3 都是 MPEG-2 Layer III / 16kHz / CBR，帧长固定（单词 24kbps → 108 字节，
#   例句 16kbps → 72 字节），每个文件都是整数帧、无 ID3、无 Xing 头帧。
#   所以「拼接」= 把帧序列首尾相接，音质与原始逐帧一致，体积几乎不变（只多一张映射表）。
#
# 为什么不需要垫静音（关键结论）：
#   播放端靠定时器在 段起点+段时长 处 stop()，定时器必然有几十毫秒误差。
#   实测（2026-10-16，各抽 60 条）每个片段自带的**前导静音**：单词中位 150ms / 最小 140ms，
#   例句中位 130ms / 最小 120ms。也就是说定时器晚停 100ms 以内，听到的仍然是下一段的
#   前导静音，不会串音。垫静音只会白白增加 ~390KB，故 GAP 默认 0。
#   （如将来需要，可用 --gap 0.1 加垫，成本 = 400 段 × 0.1s × 对应码率 ≈ 100KB）
#
# 用法：
#   python gen-audio-packs.py              # 生成周包，并把原始单文件移入 _audio_src_backup
#   python gen-audio-packs.py --keep-src   # 生成周包，但保留原始单文件（自检会报残留）
#   python gen-audio-packs.py --gap 0.1    # 段间额外垫 0.1s 静音
import json
import shutil
import sys
from pathlib import Path

import lameenc
import numpy as np

HERE = Path(__file__).parent
PKG = HERE.parent / "starwords-miniprogram"
WORDS_JSON = HERE / "words.json"
MAP_OUT = PKG / "utils" / "audioPackMap.js"
BACKUP = HERE / "_audio_src_backup"

TARGET_SR = 16000
SAMPLES_PER_FRAME = 576
FRAME_DUR = SAMPLES_PER_FRAME / TARGET_SR  # 0.036s
BITRATE_WORD = 24
BITRATE_PHRASE = 16

BITRATE_TABLE = {
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
SAMPLE_RATE_TABLE = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000]}


def frame_size_of(bitrate: int) -> int:
    return (SAMPLES_PER_FRAME // 8) * bitrate * 1000 // TARGET_SR


def walk_frames(buf: bytes):
    """逐帧解析，返回 [(offset, size, bitrate)]。结构不符合预期就抛异常。"""
    frames = []
    i = 0
    while i < len(buf):
        if i + 4 > len(buf):
            raise ValueError(f"尾部残留 {len(buf) - i} 字节")
        if buf[i] != 0xFF or (buf[i + 1] & 0xE0) != 0xE0:
            raise ValueError(f"偏移 {i} 处不是帧同步字")
        ver_bits = (buf[i + 1] >> 3) & 3
        layer_bits = (buf[i + 1] >> 1) & 3
        if ver_bits == 1 or layer_bits != 1:
            raise ValueError(f"偏移 {i} 处不是 MPEG Layer III")
        t = 3 if ver_bits == 3 else 2
        br = BITRATE_TABLE[t][(buf[i + 2] >> 4) & 0xF]
        sr = SAMPLE_RATE_TABLE[t][(buf[i + 2] >> 2) & 3]
        pad = (buf[i + 2] >> 1) & 1
        if not br or not sr:
            raise ValueError(f"偏移 {i} 处码率/采样率非法")
        size = (SAMPLES_PER_FRAME // 8) * br * 1000 // sr + pad
        if i + size > len(buf):
            raise ValueError(f"偏移 {i} 处帧越界")
        frames.append((i, size, br))
        i += size
    return frames


def make_silence(bitrate: int, frames: int) -> bytes:
    """用同参编码器生成静音帧，保证与源文件帧长完全一致。

    编码器可能在尾部补帧，所以多编几帧再按帧长精确切片。
    """
    enc = lameenc.Encoder()
    enc.set_bit_rate(bitrate)
    enc.set_in_sample_rate(TARGET_SR)
    enc.set_channels(1)
    enc.set_quality(2)
    pcm = np.zeros(SAMPLES_PER_FRAME * (frames + 8), dtype=np.int16)
    data = bytes(enc.encode(pcm.tobytes())) + bytes(enc.flush())
    got = walk_frames(data)
    want = frame_size_of(bitrate)
    sizes = {s for _, s, _ in got}
    if sizes != {want}:
        raise ValueError(f"静音帧长异常：期望 {want}，实际 {sorted(sizes)}")
    if len(got) < frames:
        raise ValueError(f"静音帧数不足：需要 {frames}，只有 {len(got)}")
    return data[: frames * want]


def load_sources(kind: str, src_dir: Path):
    """返回 {文件名: bytes}。优先读源目录，没有就读备份目录。"""
    singles = sorted(f for f in src_dir.glob("w*.mp3") if not f.name.startswith(("wp", "pp")))
    if singles:
        return {f.name: f.read_bytes() for f in singles}, "源目录"
    backup = BACKUP / kind
    if backup.exists():
        singles = sorted(backup.glob("w*.mp3"))
        if singles:
            return {f.name: f.read_bytes() for f in singles}, "备份目录"
    raise SystemExit(f"找不到原始单文件音频：{src_dir} 与 {backup} 都是空的")


def build(kind, entries, src_dir: Path, out_dir: Path, prefix: str, bitrate: int, gap_frames: int):
    blobs, origin = load_sources(kind, src_dir)
    silence = make_silence(bitrate, gap_frames) if gap_frames > 0 else b""
    fsize = frame_size_of(bitrate)

    durations = {}
    total_before = sum(len(b) for b in blobs.values())
    total_after = 0
    out_dir.mkdir(parents=True, exist_ok=True)

    weeks = sorted({e["week"] for e in entries})
    for week in weeks:
        pack = f"{prefix}{week:02d}"
        buf = bytearray()
        durs = []
        for e in [x for x in entries if x["week"] == week]:
            name = f"{e['id']}.mp3"
            if name not in blobs:
                raise SystemExit(f"{kind} 缺少源文件 {name}")
            raw = blobs[name]
            durs.append(round(len(walk_frames(raw)) * FRAME_DUR, 6))
            for w in [raw, silence]:
                if w:
                    buf += w
        if len(buf) % fsize != 0:
            raise SystemExit(f"{pack} 拼接后不是整数帧：{len(buf)} 字节")
        walk_frames(bytes(buf))  # 整包再走一遍，确认没有错位
        durations[week] = durs
        (out_dir / f"{pack}.mp3").write_bytes(bytes(buf))
        total_after += len(buf)

    print(
        f"{kind}: {len(blobs)} 个单文件 {total_before / 1024:.0f} KB "
        f"→ {len(weeks)} 个周包 {total_after / 1024:.0f} KB（源：{origin}）"
    )
    return durations


def write_map(gap_sec: float, word_durs, phrase_durs) -> None:
    lines = [
        "// 音频周包映射表 —— 由 starwords-miniprogram-scripts/gen-audio-packs.py 生成，请勿手改。",
        "// 每周 5 段按词序号（w{周}-{1..5}）依次排列。",
        "// 段起点 o_i = GAP*i + d_0 + … + d_{i-1}；两处都需要，缺一不可：",
        "//   o 用于 InnerAudioContext.startTime 定位，d 用于定时器到点 stop()。",
        "// 包文件：assets/audio/wpNN.mp3（单词，24kbps）、assets/phrases/ppNN.mp3（例句，16kbps）。",
        "var GAP = %s;" % gap_sec,
        "",
        "// kind -> 周 -> 5 段时长（秒）",
        "var PACK = {",
        "  w: {",
    ]
    for week in sorted(word_durs):
        lines.append("    %d: [%s]," % (week, ", ".join(str(x) for x in word_durs[week])))
    lines.append("  },")
    lines.append("  p: {")
    for week in sorted(phrase_durs):
        lines.append("    %d: [%s]," % (week, ", ".join(str(x) for x in phrase_durs[week])))
    lines.append("  }")
    lines.append("};")
    lines.append("")
    lines.append("// 由上面的数据展开出查表结构；不改动文件体积，只是启动时算一次。")
    lines.append("// SEG = 单词段，PSEG = 例句段。两者键都是词条 id（w1-1 这种），")
    lines.append("// 必须分成两个表 —— 合在一起例句会把单词覆盖掉。")
    lines.append("var SEG = {};")
    lines.append("var PSEG = {};")
    lines.append("var DUR = {};")
    lines.append("for (var kind in PACK) {")
    lines.append("  for (var week in PACK[kind]) {")
    lines.append("    var list = PACK[kind][week];")
    lines.append("    var pack = (kind === 'w' ? 'wp' : 'pp') + ('0' + week).slice(-2);")
    lines.append("    var target = kind === 'w' ? SEG : PSEG;")
    lines.append("    var acc = 0;")
    lines.append("    for (var i = 0; i < list.length; i++) {")
    lines.append("      target['w' + week + '-' + (i + 1)] = { p: pack, o: acc, d: list[i] };")
    lines.append("      acc += list[i] + GAP;")
    lines.append("    }")
    lines.append("    DUR[pack] = acc - (list.length > 0 ? GAP : 0);")
    lines.append("  }")
    lines.append("}")
    lines.append("")
    lines.append("module.exports = { GAP: GAP, SEG: SEG, PSEG: PSEG, DUR: DUR };")
    lines.append("")
    MAP_OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"映射表：{MAP_OUT}（{MAP_OUT.stat().st_size / 1024:.1f} KB）")


def main() -> None:
    args = sys.argv[1:]
    keep_src = "--keep-src" in args
    gap_sec = 0.0
    if "--gap" in args:
        gap_sec = float(args[args.index("--gap") + 1])
        if gap_sec < 0:
            raise SystemExit("--gap 不能为负")
    gap_frames = int(round(gap_sec / FRAME_DUR))

    words = json.loads(WORDS_JSON.read_text(encoding="utf-8"))
    if len(words) != 200:
        raise SystemExit(f"words.json 应为 200 条，实际 {len(words)}")

    word_durs = build(
        "words", words, PKG / "assets" / "audio", PKG / "assets" / "audio", "wp", BITRATE_WORD, gap_frames
    )
    phrase_durs = build(
        "phrases", words, PKG / "assets" / "phrases", PKG / "assets" / "phrases", "pp", BITRATE_PHRASE, gap_frames
    )
    write_map(gap_frames * FRAME_DUR, word_durs, phrase_durs)

    if keep_src:
        print("保留原始单文件（--keep-src）")
        return
    for kind, src_dir in (("words", PKG / "assets" / "audio"), ("phrases", PKG / "assets" / "phrases")):
        dest = BACKUP / kind
        dest.mkdir(parents=True, exist_ok=True)
        moved = 0
        for f in sorted(src_dir.glob("w*.mp3")):
            if f.name.startswith(("wp", "pp")):
                continue
            shutil.move(str(f), str(dest / f.name))
            moved += 1
        if moved:
            print(f"{kind}: 原始单文件已移入备份 {dest}（{moved} 个）")


if __name__ == "__main__":
    main()
