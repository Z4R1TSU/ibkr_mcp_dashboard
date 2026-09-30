"""Draw symbolic direction artwork, not an account-price chart."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parents[1] / 'assets' / 'discord'
OUT.mkdir(parents=True, exist_ok=True)
SIZE = 1024
COLORS = {'up': (42, 211, 155), 'down': (246, 99, 121), 'flat': (157, 167, 185)}

def cover(direction):
    color = COLORS[direction]
    canvas = Image.new('RGBA', (SIZE, SIZE))
    draw = ImageDraw.Draw(canvas)
    for y in range(SIZE):
        t = 0.09 + 0.08 * (1 - y / SIZE)
        shade = tuple(int(15 * (1-t) + c * t) for c in color)
        draw.line((0, y, SIZE, y), fill=shade + (255,))
    for y in [270, 512, 754]:
        grid = tuple(int(20 * 0.8 + c * 0.2) for c in color)
        draw.line((112, y, 912, y), fill=grid + (255,), width=8)
    glow = Image.new('RGBA', canvas.size)
    g = ImageDraw.Draw(glow)
    g.rounded_rectangle((32, 32, 992, 992), radius=186, outline=color + (175,), width=30)
    canvas = Image.alpha_composite(canvas, glow.filter(ImageFilter.GaussianBlur(35)))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((30, 30, 994, 994), radius=186, outline=color + (170,), width=16)
    candles = [(675, 790), (570, 725), (465, 635), (320, 505), (185, 370)]
    for i, (top, bottom) in enumerate(candles):
        x = 192 + i * 160
        if direction == 'down': top, bottom = SIZE - bottom, SIZE - top
        if direction == 'flat': top, bottom = 405 + (i % 2) * 30, 615 + (i % 2) * 30
        draw.line((x, top - 55, x, bottom + 55), fill=color, width=24)
        draw.rounded_rectangle((x - 52, top, x + 52, bottom), radius=14, fill=color)
    mask = Image.new('L', canvas.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 1023, 1023), radius=200, fill=255)
    canvas.putalpha(mask)
    return canvas

def badge(direction):
    image = Image.new('RGBA', (SIZE, SIZE))
    draw = ImageDraw.Draw(image)
    draw.ellipse((12, 12, 1012, 1012), fill=COLORS[direction], outline=(20, 23, 30), width=60)
    points = [(512, 212), (780, 480), (630, 480), (630, 780), (394, 780), (394, 480), (244, 480)]
    if direction == 'down': points = [(x, SIZE-y) for x, y in points]
    if direction == 'flat': draw.rounded_rectangle((252, 432, 772, 592), radius=24, fill='white')
    else: draw.polygon(points, fill='white')
    return image

if __name__ == '__main__':
    preview = Image.new('RGB', (960, 400), (28, 29, 35))
    for i, direction in enumerate(COLORS):
        large, small = cover(direction), badge(direction)
        large.save(OUT / ('portfolio_' + direction + '.png'))
        small.save(OUT / ('trend_' + direction + '.png'))
        tile = large.resize((280, 280), Image.Resampling.LANCZOS)
        preview.paste(tile, (20+i*320, 20), tile)
        mark = small.resize((80, 80), Image.Resampling.LANCZOS)
        preview.paste(mark, (120+i*320, 305), mark)
    preview.save(OUT / 'preview.png')
    print(OUT)
