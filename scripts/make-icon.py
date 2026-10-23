"""Deterministic conversion of the supplied Qinly artwork (requires Pillow)."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
source = root / 'logo'
output = root / 'resources'
brand = output / 'brand'
brand.mkdir(parents=True, exist_ok=True)

def supplied(suffix):
    return Image.open(next(source.glob('*' + suffix))).convert('RGBA')

def trim(image):
    mask = image.getchannel('A').point(lambda value: 255 if value > 64 else 0)
    return image.crop(mask.getbbox())

def icon(image, png, ico):
    image = trim(image)
    image.thumbnail((464, 464), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (512, 512))
    canvas.alpha_composite(image, ((512-image.width)//2, (512-image.height)//2))
    canvas.save(output / png, optimize=True)
    canvas.save(output / ico, sizes=[(s, s) for s in (16, 20, 24, 32, 48, 64, 128, 256)])

icon(supplied('-1.png'), 'icon.png', 'app.ico')
icon(supplied('-4.png'), 'shortcut.png', 'installer.ico')
light = trim(supplied('-2.png'))
light.thumbnail((720, 300), Image.Resampling.LANCZOS)
light.save(brand / 'logo-light.png', optimize=True)
# Preserve the dark artwork's intentional background and glow; crop only margins.
dark = supplied('-3.png').crop((205, 270, 1250, 805))
dark.thumbnail((720, 300), Image.Resampling.LANCZOS)
dark.save(brand / 'logo-dark.png', optimize=True)
reference = Image.open(source / '轻令 Qinly 智能助手标志.png')
reference.thumbnail((640, 640), Image.Resampling.LANCZOS)
reference.save(brand / 'brand-board.png', optimize=True)
print('Generated Qinly application, installer/shortcut and themed brand assets.')
