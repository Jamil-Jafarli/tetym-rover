# Ender-3 bring-up scripts

Two standalone Python tools that came in with `ender-x`, kept because they talk
to the mainboard with nothing else running — which is exactly what you want
when the question is "is this cable/board/motor alive at all".

    python3 ender/probe.py     open the port, print the boot banner, M115 + M114
    python3 ender/spin.py      80 mm out and back on X, blocking on M400

Both assume `/dev/ttyUSB0` at 115200 and need `pyserial`. Stop the Node server
first — two processes cannot hold the same serial port.

The rest of `ender-x` — its HTTP server and its browser UI — is not here as
Python any more. It was ported into this project:

| was                  | is now                                                              |
|----------------------|---------------------------------------------------------------------|
| `ender-x/server.py`  | `marlin.js` (serial link, jogger) + `marlin_http.js` (the JSON API) |
| `ender-x/index.html` | `public/gcode.html`, served at `/`                                  |

    node server.js                       # ..and this is how you run it
