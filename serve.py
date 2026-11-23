"""Production entry point: python serve.py

Runs the site with waitress using a larger thread pool than the command-line
default (4 threads), so several people can be served at the same moment.

Settings (all optional, put them in .env or the environment):
  PORT                        default 5002
  WAITRESS_THREADS            default 16   - requests handled at the same time
  WAITRESS_CONNECTION_LIMIT   default 200  - open connections accepted
  WAITRESS_CHANNEL_TIMEOUT    default 60   - seconds before an idle connection is closed
"""
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

THREADS = int(os.environ.get("WAITRESS_THREADS", "16"))
os.environ["WAITRESS_THREADS"] = str(THREADS)      # so the admin page can report it

from waitress import serve  # noqa: E402
from app import app  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5002"))
    print("In-Motion Weighbridge on http://0.0.0.0:%d  (%d worker threads)" % (port, THREADS))
    serve(app, host=os.environ.get("HOST", "0.0.0.0"), port=port, threads=THREADS,
          connection_limit=int(os.environ.get("WAITRESS_CONNECTION_LIMIT", "200")),
          channel_timeout=int(os.environ.get("WAITRESS_CHANNEL_TIMEOUT", "60")), ident="IMWB")
