# 生成 12 个「星星小人」形象，合成一张精灵图（avatars.png）
#
# 为什么要合成一张：
#   预览编译器有 MAX_SOURCE_FILES = 500 硬上限，工程内文件数一旦超过 500
#   预览首页直接打不开且**零报错**。12 张独立 PNG 会把文件数顶到 480+，
#   后续随便加个功能就爆。合成 1 张后只占 1 个文件。
#
# 为什么用调色板 PNG（P64）：
#   主包余量只剩 ~48KB。实测单格 RGBA PNG ≈ 22KB，量化成 64 色后 ≈ 3KB，
#   整张 12 格 ≈ 20KB，且量化前后不透明像素占比 0.327 → 0.328（透明通道无损）。
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
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
MP_ROOT = ROOT.parent / "starwords-miniprogram"
DEST = MP_ROOT / "assets" / "avatars.png"

CELL = 192
COLS = 6
ROWS = 2
S = 4                # 超采样倍数
PALETTE_COLORS = 64  # 调色板色数

INK = (58, 44, 96, 255)
HEAD = (255, 214, 102, 255)
HEAD_HL = (255, 236, 173, 255)
SHOE = (90, 70, 140, 255)
BLUSH = (255, 185, 128, 255)   # = 45% 粉 + 55% 头色，预混成不透明
WHITE = (255, 255, 255, 255)


def shade(c, k=0.74):
    """按比例压暗，得到不透明的"同色系深色"（用于裤腿、领口）"""
    return (int(c[0] * k), int(c[1] * k), int(c[2] * k), 255)


# ---------------------------------------------------------------- 12 个形象
SPECS = [
    # 男孩
    dict(id="boy-1", gender="boy", name="棒球帽", body=(110, 89, 235, 255), prop="cap", pc=(239, 108, 108, 255)),
    dict(id="boy-2", gender="boy", name="足球星", body=(56, 189, 248, 255), prop="ball", pc=(255, 255, 255, 255)),
    dict(id="boy-3", gender="boy", name="小超人", body=(251, 146, 60, 255), prop="cape", pc=(220, 60, 60, 255)),
    dict(id="boy-4", gender="boy", name="音乐星", body=(52, 211, 153, 255), prop="headphones", pc=(139, 92, 246, 255)),
    dict(id="boy-5", gender="boy", name="书包星", body=(248, 113, 113, 255), prop="backpack", pc=(250, 204, 21, 255)),
    dict(id="boy-6", gender="boy", name="天线星", body=(99, 102, 241, 255), prop="antenna", pc=(56, 189, 248, 255)),
    # 女孩
    dict(id="girl-1", gender="girl", name="蝴蝶结", body=(244, 114, 182, 255), prop="bow", pc=(236, 72, 153, 255)),
    dict(id="girl-2", gender="girl", name="魔法星", body=(167, 139, 250, 255), prop="wand", pc=(250, 204, 21, 255)),
    dict(id="girl-3", gender="girl", name="花仙子", body=(56, 189, 248, 255), prop="flower", pc=(244, 114, 182, 255)),
    dict(id="girl-4", gender="girl", name="小挎包", body=(236, 72, 153, 255), prop="bag", pc=(250, 204, 21, 255)),
    dict(id="girl-5", gender="girl", name="草帽星", body=(52, 211, 153, 255), prop="strawhat", pc=(250, 204, 21, 255)),
    dict(id="girl-6", gender="girl", name="围巾星", body=(251, 146, 60, 255), prop="scarf", pc=(239, 108, 108, 255)),
]

# 造型基准（设计画布 160 单位）
HEAD_CX, HEAD_CY, HEAD_OUT, HEAD_IN = 80.0, 66.0, 48.0, 22.0
BODY_CX, BODY_CY, BODY_W, BODY_H = 80.0, 120.0, 46.0, 40.0


def star_points(cx, cy, outer, inner, n=5, rot=-90.0):
    pts = []
    for i in range(n * 2):
        r = outer if i % 2 == 0 else inner
        a = math.radians(rot + i * 180.0 / n)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def round_pts(d, pts, r, fill):
    """给多边形顶点加圆角：填充多边形 + 每个顶点填一个圆"""
    d.polygon(pts, fill=fill)
    for p in pts:
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=fill)


def draw_char(cell, spec):
    c = cell * S
    img = Image.new("RGBA", (c, c), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = c / 160.0

    def U(v):
        return v * u

    def R(x0, y0, x1, y1, rad, fill):
        d.rounded_rectangle([U(x0), U(y0), U(x1), U(y1)], radius=U(rad), fill=fill)

    body = spec["body"]
    pc = spec["pc"]
    prop = spec["prop"]
    dark = shade(body)
    step = int(max(1, U(3)))

    # ---------- 身后的道具 ----------
    if prop == "cape":
        d.polygon([(U(60), U(100)), (U(38), U(152)), (U(122), U(152)), (U(100), U(100))], fill=pc)
    if prop == "backpack":
        # 画在躯干后面，必须比躯干宽 —— 否则会被 46 宽的躯干整个盖住，看不出背着包
        R(50, 104, 110, 150, 13, pc)
        R(50, 104, 110, 116, 8, shade(pc))
        R(70, 100, 90, 124, 4, shade(pc, 0.7))

    # ---------- 腿 / 鞋 ----------
    R(66, 136, 74, 150, 4, dark)
    R(86, 136, 94, 150, 4, dark)
    d.ellipse([U(62), U(146), U(78), U(157)], fill=SHOE)
    d.ellipse([U(82), U(146), U(98), U(157)], fill=SHOE)

    # ---------- 手 ----------
    R(50, 102, 58, 128, 4, dark)
    R(102, 102, 110, 128, 4, dark)

    # ---------- 小身子 ----------
    R(BODY_CX - BODY_W / 2, BODY_CY - BODY_H / 2, BODY_CX + BODY_W / 2, BODY_CY + BODY_H / 2, 14, body)
    # 领口（不透明深色，别用半透明）
    R(66, 104, 94, 111, 3, dark)

    # ---------- 大头（圆角五角星）----------
    sil = star_points(U(HEAD_CX), U(HEAD_CY), U(HEAD_OUT + 4.5), U(HEAD_IN + 4.5))
    round_pts(d, sil, U(7), INK)
    pts = star_points(U(HEAD_CX), U(HEAD_CY), U(HEAD_OUT), U(HEAD_IN))
    round_pts(d, pts, U(7), HEAD)
    # 高光：偏移的小星做出「贴纸反光」的层次
    round_pts(d, star_points(U(HEAD_CX - 4), U(HEAD_CY - 5), U(HEAD_OUT - 13), U(HEAD_IN - 8)), U(5), HEAD_HL)
    round_pts(d, star_points(U(HEAD_CX + 5), U(HEAD_CY + 5), U(HEAD_OUT - 12), U(HEAD_IN - 7)), U(5), HEAD)

    # ---------- 脸 ----------
    d.ellipse([U(60), U(56), U(71), U(69)], fill=INK)
    d.ellipse([U(89), U(56), U(100), U(69)], fill=INK)
    d.ellipse([U(62), U(57), U(67), U(62)], fill=WHITE)
    d.ellipse([U(91), U(57), U(96), U(62)], fill=WHITE)
    d.arc([U(69), U(64), U(91), U(81)], start=20, end=160, fill=INK, width=step)
    d.ellipse([U(50), U(70), U(60), U(78)], fill=BLUSH)
    d.ellipse([U(100), U(70), U(110), U(78)], fill=BLUSH)

    # ---------- 头上的道具 ----------
    if prop == "cap":
        d.pieslice([U(44), U(16), U(116), U(66)], start=180, end=360, fill=pc)
        R(74, 30, 124, 38, 4, shade(pc))
    elif prop == "headphones":
        d.arc([U(32), U(10), U(128), U(82)], start=200, end=340, fill=pc, width=int(max(1, U(7))))
        R(22, 40, 42, 66, 8, pc)
        R(118, 40, 138, 66, 8, pc)
    elif prop == "antenna":
        d.line([(U(80), U(18)), (U(80), U(9))], fill=INK, width=step)
        d.ellipse([U(74), U(3), U(86), U(15)], fill=pc)
    elif prop == "bow":
        d.ellipse([U(92), U(22), U(110), U(40)], fill=pc)
        d.ellipse([U(108), U(22), U(126), U(40)], fill=pc)
        d.ellipse([U(103), U(27), U(115), U(38)], fill=shade(pc))
    elif prop == "flower":
        for ang in (-140, -105, -70, -35, 0):
            a = math.radians(ang)
            fx = HEAD_CX + 43 * math.cos(a)
            fy = HEAD_CY + 43 * math.sin(a)
            for k in range(5):
                b = math.radians(k * 72)
                d.ellipse(
                    [U(fx + 5.5 * math.cos(b) - 4), U(fy + 5.5 * math.sin(b) - 4),
                     U(fx + 5.5 * math.cos(b) + 4), U(fy + 5.5 * math.sin(b) + 4)],
                    fill=pc,
                )
            d.ellipse([U(fx - 3.5), U(fy - 3.5), U(fx + 3.5), U(fy + 3.5)], fill=(250, 204, 21, 255))
    elif prop == "strawhat":
        d.ellipse([U(22), U(24), U(138), U(56)], fill=pc)
        d.ellipse([U(50), U(6), U(110), U(52)], fill=shade(pc, 0.92))
        d.rectangle([U(34), U(40), U(126), U(48)], fill=(236, 72, 153, 255))
    elif prop == "scarf":
        R(60, 96, 100, 108, 5, pc)
        R(88, 106, 102, 140, 6, pc)

    # ---------- 身前的道具 ----------
    if prop == "ball":
        bx, by, br = 122.0, 132.0, 17.0
        d.ellipse([U(bx - br), U(by - br), U(bx + br), U(by + br)], fill=WHITE, outline=INK, width=step)
        d.polygon([(U(bx - 6), U(by - 5)), (U(bx + 6), U(by - 5)), (U(bx + 7), U(by + 4)),
                   (U(bx), U(by + 9)), (U(bx - 7), U(by + 4))], fill=INK)
    elif prop == "wand":
        d.line([(U(110), U(148)), (U(122), U(104))], fill=shade(pc, 0.8), width=int(max(1, U(6))))
        round_pts(d, star_points(U(124), U(96), U(16), U(7)), U(3), pc)
    elif prop == "bag":
        d.line([(U(62), U(104)), (U(118), U(128))], fill=shade(pc, 0.75), width=int(max(1, U(4))))
        R(104, 120, 136, 146, 6, pc)
        R(104, 120, 136, 128, 4, shade(pc, 0.75))

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
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:16px;max-width:1050px}
.item{text-align:center;font-size:12px}
.clip{position:relative;overflow:hidden;width:100%%;padding-top:100%%;background:#fff;border-radius:16px}
.clip img{position:absolute;left:0;top:0;display:block;width:600%%;height:200%%}
b{color:#6d59eb}
</style>
<h3>12 个星星形象（精灵图 6×2，真机同款取图）</h3>
<div class="grid">
%s
</div>
""" % ("\n".join(cells))
(ROOT / "avatar-preview.html").write_text(html, encoding="utf8")

print("avatars.png: %dx%d  %.1f KB  (%d 个形象)"
      % (sheet.size[0], sheet.size[1], DEST.stat().st_size / 1024, len(rows)))
