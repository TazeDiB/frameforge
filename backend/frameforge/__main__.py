import logging

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

from frameforge.server import main

if __name__ == "__main__":
    main()
