# 把 200 张单词图合并成一张精灵图（sprite sheet）
#
# 为什么必须合并：
#   WorkBuddy 预览用的内置小程序编译器（workbuddy-baas 扩展）
#   源码里写死 MAX_SOURCE_FILES = 500 —— 工程内文件数（含图片/音频）一旦超过 500
#   就直接抛 CompileError("UNSUPPORTED_FEATURE", "源文件超过 500 个")，预览首页打不开。
#   200 张独立图片是大头，合并成 1 张后总文件数 642 → 443，留出安全余量。
#
# 输出：
#   starwords-miniprogram/assets/sprite.jpg   （精灵图本体，唯一文件）
#   starwords-miniprogram-scripts/sprite-map.json （name -> [col,row] 映射，供 gen-words-js.mjs 使用）
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent
SRC = Path(r"C:/Users/PC/WorkBuddy/Worktrees/startwords-english/master-9d8cc640/public/images/words")
MP_ROOT = Path(__file__).parent.parent / "starwords-miniprogram"
DEST = MP_ROOT / "assets" / "sprite.jpg"

COLS = 16
ROWS = 13  # 16 * 13 = 208 >= 200
CELL = 112  # 与旧版单图尺寸一致
# q=45：例句改写后例句音频变长，主包余量吃紧（曾到 1,985,133B / 仅 15KB 余量）。
# 112px/格的扁平卡通插画在 q=45 与 q=72 肉眼无差（已放大对比核对），省 103KB。
QUALITY = 45

words = json.loads((ROOT / "words.json").read_text(encoding="utf8"))
names = [w["imageName"] for w in words if w["imageName"]]
if len(names) > COLS * ROWS:
    raise SystemExit(f"词条 {len(names)} 超过精灵图容量 {COLS * ROWS}")

sheet = Image.new("RGB", (COLS * CELL, ROWS * CELL), (255, 255, 255))
mapping = {}
missing = []

for i, name in enumerate(names):
    src = SRC / f"{name}.png"
    if not src.exists():
        missing.append(name)
        continue
    img = Image.open(src).convert("RGBA")
    # 居中裁成正方形，再缩放到 CELL x CELL —— 格子尺寸统一才能用格子偏移定位
    w, h = img.size
    side = min(w, h)
    img = img.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
    img = img.resize((CELL, CELL), Image.LANCZOS)
    bg = Image.new("RGB", (CELL, CELL), (255, 255, 255))
    bg.paste(img, mask=img.split()[3])
    col, row = i % COLS, i // COLS
    sheet.paste(bg, (col * CELL, row * CELL))
    mapping[name] = [col, row]

DEST.parent.mkdir(parents=True, exist_ok=True)
sheet.save(DEST, "JPEG", quality=QUALITY, optimize=True, progressive=False, subsampling=2)

(ROOT / "sprite-map.json").write_text(
    json.dumps({"cols": COLS, "rows": ROWS, "cell": CELL, "missing": missing, "map": mapping},
               ensure_ascii=False, indent=0),
    encoding="utf8",
)

print(f"sprite: {DEST.name} {sheet.size[0]}x{sheet.size[1]}, {DEST.stat().st_size / 1024:.0f} KB")
print(f"cells: {len(mapping)}/{len(names)}  missing: {missing}")
