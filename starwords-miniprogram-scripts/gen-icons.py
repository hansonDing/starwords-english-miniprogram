# 生成 tabBar 图标：home / review / progress / mine，两态（灰/紫）
import math
from pathlib import Path

from PIL import Image, ImageDraw

DEST = Path(__file__).parent.parent / "starwords-miniprogram" / "assets" / "tabbar"
DEST.mkdir(parents=True, exist_ok=True)

SIZE = 96
GRAY = (156, 163, 175, 255)
PURPLE = (109, 89, 235, 255)


def canvas():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def home(color):
    img, d = canvas()
    d.polygon([(48, 14), (84, 44), (12, 44)], fill=color)
    d.rectangle([20, 44, 76, 80], fill=color)
    d.rectangle([40, 56, 56, 80], fill=(255, 255, 255, 255))
    return img


def review(color):
    img, d = canvas()
    d.arc([14, 14, 82, 82], start=-60, end=170, fill=color, width=12)
    # 箭头
    d.polygon([(78, 6), (94, 34), (62, 34)], fill=color)
    d.polygon([(18, 62), (34, 90), (2, 90)], fill=color)
    return img


def progress(color):
    img, d = canvas()
    d.rectangle([16, 52, 34, 82], fill=color)
    d.rectangle([39, 32, 57, 82], fill=color)
    d.rectangle([62, 14, 80, 82], fill=color)
    return img


def mine(color):
    img, d = canvas()
    d.ellipse([32, 12, 64, 44], fill=color)
    d.pieslice([16, 48, 80, 112], start=180, end=360, fill=color)
    return img


icons = {"home": home, "review": review, "progress": progress, "mine": mine}
for name, fn in icons.items():
    fn(GRAY).save(DEST / f"{name}.png")
    fn(PURPLE).save(DEST / f"{name}-active.png")
print("icons done:", sorted(p.name for p in DEST.iterdir()))
