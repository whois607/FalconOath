"""Build FalconOath.exe, then put its shortcuts on the Desktop and in the Start menu.

    Double-click "Setup FalconOath.bat"   (or: python -X utf8 tools\\build_exe.py)

Needs PyInstaller and pywebview (python -m pip install -r requirements.txt).
Makes dist\\FalconOath\\FalconOath.exe (with its _internal folder beside it:
Python, pandas for VPA's prices, pywebview). Keep it where it is: it finds
this project folder by looking upwards from itself, for data\\, manuals\\ and
the app's screens. Screens (falconoath\\app\\) change without a rebuild;
after a change to the Python, run this again (about a minute).
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "build" / "pyi"
DIST = ROOT / "dist"
EXE = DIST / "FalconOath" / "FalconOath.exe"
ICO = ROOT / "assets" / "falconoath.ico"

SPEC = r"""
# made by tools/build_exe.py - edit that, not this
from PyInstaller.utils.hooks import collect_submodules
a = Analysis([r"{entry}"], pathex=[r"{root}"],
             hiddenimports=collect_submodules("falconoath") + ["pandas", "numpy", "pypdf", "webview"],
             excludes=["tkinter", "matplotlib", "IPython", "pytest"], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [("X utf8", None, "OPTION")], exclude_binaries=True, name="FalconOath",
          console=False, icon=r"{ico}", version=None)
coll = COLLECT(exe, a.binaries, a.datas, name="FalconOath")
"""


def build() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    if not ICO.is_file():
        from make_launcher import draw_icon
        draw_icon()
    WORK.mkdir(parents=True, exist_ok=True)
    spec = WORK / "FalconOath.spec"
    spec.write_text(SPEC.format(entry=ROOT / "tools" / "exe_main.py", root=ROOT, ico=ICO), encoding="utf-8")
    if (DIST / "FalconOath").exists():
        shutil.rmtree(DIST / "FalconOath")           # only ever the build's own output
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--log-level", "WARN",
                    "--distpath", str(DIST), "--workpath", str(WORK), str(spec)], cwd=str(ROOT), check=True)
    print(f"built: {EXE}")


if __name__ == "__main__":
    build()
    from make_launcher import main as shortcuts
    shortcuts()
