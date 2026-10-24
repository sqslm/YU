"""Copy the supplied YU brand assets without redrawing or adding runtime dependencies."""
from pathlib import Path
from shutil import copyfile

root = Path(__file__).resolve().parent.parent
source = root / 'logo' / 'YU_语_品牌图标资源包'
output = root / 'resources'
brand = output / 'brand'
tray = output / 'tray'
brand.mkdir(parents=True, exist_ok=True)
tray.mkdir(parents=True, exist_ok=True)
assets = {
    '02_应用图标与任务栏/YU_任务栏_256.png': output / 'icon.png',
    '02_应用图标与任务栏/YU_Windows主图标.ico': output / 'app.ico',
    '02_应用图标与任务栏/YU_应用图标_白底_512.png': output / 'shortcut.png',
    '04_展示预览/YU_素材用途展示.png': brand / 'brand-board.png',
    '03_托盘图标/YU_托盘_暗色托盘_白色线条.ico': tray / 'dark.ico',
    '03_托盘图标/YU_托盘_亮色托盘_深色线条.ico': tray / 'light.ico',
}
for mode, label in [('light', '浅色界面'), ('dark', '深色界面')]:
    assets[f'01_应用内Logo/YU_侧边栏紧凑版_{label}.png'] = brand / f'logo-{mode}.png'
    assets[f'01_应用内Logo/YU_横版_{label}.png'] = brand / f'about-{mode}.png'
    assets[f'01_应用内Logo/YU_纯符号透明_{label}.png'] = brand / f'symbol-{mode}.png'
for original, target in assets.items():
    copyfile(source / original, target)
copyfile(output / 'app.ico', output / 'installer.ico')
print('Updated YU application, taskbar, shortcut, installer, tray and themed brand assets.')
