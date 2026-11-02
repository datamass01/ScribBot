"""Moved: the watchdog is now the ScribBot Console (console/, docs/console-design.md).

This file stays so old shortcuts keep working: it starts the Console with the same options.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "console"))

from scribconsole.server import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
