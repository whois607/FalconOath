"""Shortcuts for FalconOath (Windows). "Setup FalconOath.bat" runs
tools/build_exe.py, which builds FalconOath.exe and then runs this.

  1. Draws the app's shield icon as assets/falconoath.ico (needs Pillow).
  2. Puts a "FalconOath" shortcut on the Desktop, in the Start menu and in
     this folder: dist/FalconOath/FalconOath.exe if it's been built, else
     pythonw.exe -m falconoath app.

Double-clicking it starts the listener out of sight if it isn't running yet,
then opens FalconOath's own window (Settings there pairs phones, opens the
folders and stops it). Run this again if you move this folder.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICO = ROOT / "assets" / "falconoath.ico"
NAME = "FalconOath"
sys.path.insert(0, str(Path(__file__).resolve().parent))


def draw_icon() -> None:
    from make_icons import draw              # the same shield as the phone icon
    ICO.parent.mkdir(exist_ok=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [draw(n, False) for n in sizes]
    frames[-1].save(ICO, sizes=[(n, n) for n in sizes], append_images=frames[:-1])
    print(f"icon written: {ICO}")


def _special_folder(name: str) -> Path:
    """The real Desktop / Start menu folder (OneDrive moves the Desktop)."""
    out = subprocess.run(["powershell", "-NoProfile", "-Command", f"[Environment]::GetFolderPath('{name}')"],
                         capture_output=True, text=True, check=True).stdout.strip()
    return Path(out)


EXE = ROOT / "dist" / NAME / f"{NAME}.exe"


def make_shortcut(where: Path) -> Path:
    if EXE.is_file():
        target, args = EXE, ""
    else:
        target, args = Path(sys.executable).with_name("pythonw.exe"), "-X utf8 -m falconoath app"
        if not target.exists():
            target = Path(sys.executable)
            print("note: pythonw.exe not found next to python.exe - the shortcut will flash a console window.")
    lnk = where / f"{NAME}.lnk"
    ps = f"""
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('{lnk}')
$s.TargetPath = '{target}'
$s.Arguments = '{args}'
$s.WorkingDirectory = '{ROOT}'
$s.IconLocation = '{ICO},0'
$s.Description = 'FalconOath - Falcon fault codes and scans'
$s.Save()
"""
    with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False, encoding="utf-8-sig") as f:
        f.write(ps)
        script = f.name
    try:
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], check=True)
    finally:
        Path(script).unlink(missing_ok=True)
    print(f"shortcut written: {lnk}")
    return lnk


def main() -> int:
    draw_icon()
    for where in (ROOT, _special_folder("Desktop"), _special_folder("Programs")):
        make_shortcut(where)
    print()
    print(f"Done. Double-click '{NAME}' on the Desktop, or type {NAME} in the Start menu.")
    print("Pin it: right-click -> Pin to taskbar / Pin to Start.")
    print("It keeps running when its window closes (phones still sync); stop it in Settings -> This laptop.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
