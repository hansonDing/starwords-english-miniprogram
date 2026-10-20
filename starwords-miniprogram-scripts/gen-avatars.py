# 生成 8 个「拟人卡通小人」形象，合成一张精灵图（avatars.png）
#
# 为什么要合成一张：
#   预览编译器有 MAX_SOURCE_FILES = 500 硬上限，工程内文件数一旦超过 500
#   预览首页直接打不开且**零报错**。合成 1 张后只占 1 个文件。
#
# 为什么用调色板 PNG（P64）：
#   主包余量很紧。实测单格 RGBA PNG ≈ 22KB，量化成 64 色后 ≈ 2KB，
#   整张 8 格 ≈ 12KB，且量化前后不透明像素占比几乎不变（透明通道无损）。
#
# ⚠️ 用带 Pillow 的那个 venv 跑：
#     C:/Users/PC/.workbuddy/binaries/python/envs/default/Scripts/python.exe gen-avatars.py
#
# 输出：
#   starwords-miniprogram/assets/avatars.png      精灵图本体（唯一文件）
#   starwords-miniprogram-scripts/avatar-map.json  id -> col/row/gender/name
#   starwords-miniprogram-scripts/avatar-preview.html  人工验收用（含真机同款取图逻辑）
#
# ⚠️ 色彩纪律：**不许用 alpha < 255 的颜色**。PIL 的 ImageDraw 在 RGBA 上是
#    「替换像素」而不是「混合」，半透明色会在形象上打出半透明窟窿，换到彩色背景
#    就穿帮。腮红 / 领口这类"叠色"一律预先手工混成不透明色。
#
# 造型要求（用户指定）：**拟人化**的可爱小男孩 / 小女孩漫画形象 ——
#   肤色圆脸 + 头发刘海 + 大眼睛 + 腮红 + 微笑；女孩有长发。
#   头大身子小（头宽 86 / 身子宽 46），卡通可爱。
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
MP_ROOT = ROOT.parent / "starwords-miniprogram"
DEST = MP_ROOT / "assets" / "avatars.png"

CELL = 192
COLS = 4
ROWS = 2
S = 4                # 超采样倍数
PALETTE_COLORS = 64  # 调色板色数

# ---------------- 调色板（全部不透明） ----------------
SKIN = (255, 220, 183, 255)
SKIN_D = (236, 197, 159, 255)
INK = (58, 44, 96, 255)          # 眼睛 / 轮廓
BLUSH = (255, 168, 168, 255)
MOUTH = (198, 96, 100, 255)
WHITE = (255, 255, 255, 255)
SHOE = (90, 70, 140, 255)
YELLOW = (250, 204, 21, 255)

# ---------------- 造型基准（设计画布 160 单位） ----------------
HEAD_CX, HEAD_CY, HEAD_R = 80.0, 58.0, 43.0
BODY_CX, BODY_CY, BODY_W, BODY_H = 80.0, 120.0, 46.0, 44.0
HAIRLINE = 58.0   # 刘海平底落在这一行，正好在眼睛（y=62）之上

# ---------------- 8 个形象 ----------------
SPECS = [
    # 男孩（第 0 行）
    dict(id="boy-1", gender="boy", name="棒球帽", outfit="cap",
         body=(56, 189, 248, 255), pc=(239, 108, 108, 255), hair=(74, 52, 42, 255)),
    dict(id="boy-2", gender="boy", name="短袖T恤", outfit="tee",
         body=(52, 211, 153, 255), pc=(255, 255, 255, 255), hair=(92, 64, 51, 255)),
    dict(id="boy-3", gender="boy", name="背带裤", outfit="overall",
         body=(250, 204, 21, 255), pc=(56, 132, 255, 255), hair=(58, 42, 34, 255)),
    dict(id="boy-4", gender="boy", name="小超人", outfit="cape",
         body=(239, 108, 108, 255), pc=(56, 132, 255, 255), hair=(92, 64, 51, 255)),
    # 女孩（第 1 行）
    dict(id="girl-1", gender="girl", name="蝴蝶结", outfit="bow",
         body=(244, 114, 182, 255), pc=(236, 72, 153, 255), hair=(92, 64, 51, 255)),
    dict(id="girl-2", gender="girl", name="双马尾", outfit="twintail",
         body=(167, 139, 250, 255), pc=(250, 204, 21, 255), hair=(128, 84, 58, 255)),
    dict(id="girl-3", gender="girl", name="花裙子", outfit="flower",
         body=(56, 189, 248, 255), pc=(244, 114, 182, 255), hair=(58, 42, 34, 255)),
    dict(id="girl-4", gender="girl", name="草帽", outfit="strawhat",
         body=(52, 211, 153, 255), pc=(250, 204, 21, 255), hair=(92, 64, 51, 255)),
]


def shade(c, k=0.74):
    """按比例压暗，得到不透明的「同色系深色」"""
    return (int(c[0] * k), int(c[1] * k), int(c[2] * k), 255)


def draw_char(cell, spec):
    c = cell * S
    img = Image.new("RGBA", (c, c), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = c / 160.0

    def U(v):
        return v * u

    def R(x0, y0, x1, y1, rad, fill):
        d.rounded_rectangle([U(x0), U(y0), U(x1), U(y1)], radius=U(rad), fill=fill)

    def E(x0, y0, x1, y1, fill):
        d.ellipse([U(x0), U(y0), U(x1), U(y1)], fill=fill)

    girl = spec["gender"] == "girl"
    outfit = spec["outfit"]
    body = spec["body"]
    pc = spec["pc"]
    hair = spec["hair"]
    dark = shade(body)
    step = int(max(1, U(3)))
    legs = pc if outfit == "overall" else SKIN_D

    # ---------- 1. 身后：披风 ----------
    if outfit == "cape":
        d.polygon([(U(58), U(96)), (U(30), U(152)), (U(130), U(152)), (U(102), U(96))], fill=pc)

    # ---------- 2. 身后：长发 / 双马尾 ----------
    if girl:
        # 一个比头更大的圆做发量：头盖在中间，四周露出一圈 = 披肩长发
        E(30, 30, 130, 130, hair)
    if outfit == "twintail":
        # 马尾画在头之后面（先画），发绳才会正好卡在头缘外侧
        E(2, 46, 42, 112, hair)
        E(118, 46, 158, 112, hair)
        R(4, 48, 40, 60, 6, pc)
        R(120, 48, 156, 60, 6, pc)

    # ---------- 3. 腿 / 鞋 ----------
    R(67, 134, 76, 150, 4, legs)
    R(84, 134, 93, 150, 4, legs)
    E(61, 146, 79, 158, SHOE)
    E(81, 146, 99, 158, SHOE)

    # ---------- 4. 身体 ----------
    if girl:
        # 裙摆（梯形）+ 上身
        d.polygon([(U(64), U(108)), (U(96), U(108)), (U(116), U(148)), (U(44), U(148))], fill=body)
        R(62, 96, 98, 116, 12, body)
        R(60, 110, 100, 117, 3, dark)  # 腰带
    else:
        R(BODY_CX - BODY_W / 2, BODY_CY - BODY_H / 2, BODY_CX + BODY_W / 2, BODY_CY + BODY_H / 2, 14, body)
        R(50, 98, 66, 120, 8, body)   # 左短袖
        R(94, 98, 110, 120, 8, body)  # 右短袖
        if outfit == "tee":
            R(64, 110, 78, 124, 4, pc)         # 胸前小口袋
        elif outfit == "overall":
            R(65, 96, 74, 126, 3, pc)          # 左背带
            R(86, 96, 95, 126, 3, pc)          # 右背带
            R(62, 116, 98, 142, 9, pc)         # 前片
            R(70, 123, 90, 131, 2, shade(pc, 0.85))
        elif outfit == "cape":
            R(67, 96, 93, 105, 4, pc)          # 披风领口
            E(69, 106, 91, 128, YELLOW)        # 胸口徽章
            E(75, 112, 85, 122, (239, 108, 108, 255))

    # ---------- 5. 手臂 + 手 ----------
    R(50, 116, 61, 134, 5, SKIN)
    R(99, 116, 110, 134, 5, SKIN)
    E(48, 129, 62, 142, SKIN)
    E(98, 129, 112, 142, SKIN)

    # ---------- 6. 头（大圆脸） ----------
    E(HEAD_CX - HEAD_R, HEAD_CY - HEAD_R, HEAD_CX + HEAD_R, HEAD_CY + HEAD_R, SKIN)

    # ---------- 7. 五官 ----------
    E(60, 62, 74, 80, INK)            # 左眼
    E(86, 62, 100, 80, INK)           # 右眼
    E(62, 64, 68, 70, WHITE)          # 眼里的高光
    E(88, 64, 94, 70, WHITE)
    d.arc([U(72), U(82), U(88), U(95)], start=15, end=165, fill=MOUTH, width=step)  # 微笑
    E(42, 78, 58, 88, BLUSH)          # 腮红
    E(102, 78, 118, 88, BLUSH)

    # ---------- 8. 刘海（平底落在 y=58，不遮眼睛） ----------
    d.pieslice([U(34), U(HAIRLINE - 54), U(126), U(HAIRLINE + 54)], start=180, end=360, fill=hair)

    # ---------- 9. 头部道具 ----------
    if outfit == "cap":
        d.pieslice([U(32), U(4), U(128), U(HAIRLINE + 58)], start=180, end=360, fill=pc)
        R(42, 48, 138, 58, 7, shade(pc, 0.78))   # 帽檐（偏向右侧，避免遮眼）
        E(74, 0, 86, 9, shade(pc, 0.78))         # 帽顶扣
    elif outfit == "bow":
        E(56, 4, 78, 26, pc)
        E(82, 4, 104, 26, pc)
        E(72, 10, 88, 26, shade(pc, 0.85))
    elif outfit == "flower":
        fx, fy = 46.0, 22.0
        for k in range(5):
            b = math.radians(k * 72)
            E(fx + 7.5 * math.cos(b) - 5, fy + 7.5 * math.sin(b) - 5,
              fx + 7.5 * math.cos(b) + 5, fy + 7.5 * math.sin(b) + 5, pc)
        E(fx - 4, fy - 4, fx + 4, fy + 4, YELLOW)
    elif outfit == "strawhat":
        E(26, 34, 134, 62, pc)                   # 帽檐：窄一点、薄一点，别像飞碟
        E(50, 0, 110, 40, shade(pc, 0.9))        # 帽冠（明显高出帽檐）
        R(48, 26, 112, 36, 3, (236, 72, 153, 255))  # 帽带

    return img.resize((cell, cell), Image.LANCZOS)


# ---------------------------------------------------------------- 合成
sheet = Image.new("RGBA", (COLS * CELL, ROWS * CELL), (0, 0, 0, 0))
rows = []
for i, spec in enumerate(SPECS):
    col, row = i % COLS, i // COLS
    sheet.paste(draw_char(CELL, spec), (col * CELL, row * CELL))
    rows.append(dict(id=spec["id"], gender=spec["gender"], name=spec["name"], col=col, row=row))

DEST.parent.mkdir(parents=True, exist_ok=True)
sheet.quantize(colors=PALETTE_COLORS, method=Image.FASTOCTREE).save(DEST, "PNG", optimize=True)

(ROOT / "avatar-map.json").write_text(
    json.dumps({"cols": COLS, "rows": ROWS, "cell": CELL, "list": rows}, ensure_ascii=False, indent=1),
    encoding="utf8",
)

# 验收用 HTML：**故意复用真机同款取图逻辑**（外层裁切 + 内层整图位移），
# 这样坐标算错一眼就能看出来（而不是等真机发白）
cells = []
for r in rows:
    tx = round(-100.0 / COLS * r["col"], 4)
    ty = round(-100.0 / ROWS * r["row"], 4)
    cells.append(
        '  <div class="item"><div class="clip"><img src="../../starwords-miniprogram/assets/avatars.png" '
        'style="transform: translate(%s%%, %s%%)"></div><span>%s<br><b>%s</b></span></div>'
        % (tx, ty, r["id"], r["name"])
    )
html = """<!doctype html><meta charset="utf-8"><title>形象精灵图验收</title>
<style>
body{background:#f5f3ff;font-family:system-ui;padding:24px;color:#1f2937}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;max-width:900px}
.item{text-align:center;font-size:13px}
.clip{position:relative;overflow:hidden;width:100%%;padding-top:100%%;background:#fff;border-radius:20px}
.clip img{position:absolute;left:0;top:0;display:block;width:400%%;height:200%%}
b{color:#6d59eb}
</style>
<h3>8 个卡通小人形象（精灵图 4×2，真机同款取图）</h3>
<div class="grid">
%s
</div>
""" % ("\n".join(cells))
(ROOT / "avatar-preview.html").write_text(html, encoding="utf8")

print("avatars.png: %dx%d  %.1f KB  (%d 个形象)"
      % (sheet.size[0], sheet.size[1], DEST.stat().st_size / 1024, len(rows)))
