"""FalconOath.exe's starting point (tools/build_exe.py builds it).

No command: what the desktop icon does (start the listener out of sight if
needed, open FalconOath's window). With a command, the same as
`python -m falconoath <command>` - the listener runs its own helpers this
way (FalconOath.exe build, FalconOath.exe watch-logs, ...).
"""
import sys

from falconoath import cli

if __name__ == "__main__":
    sys.exit(cli.main(sys.argv[1:] or ["app"]))
