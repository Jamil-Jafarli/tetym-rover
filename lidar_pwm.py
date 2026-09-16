#!/usr/bin/env python3
"""
The lidar motor's PWM, held by a process that stays alive.

    python3 lidar_pwm.py <pwm pin> <in1 pin> <in2 pin> <hz>

Why a Python helper at all: 1.6 V out of a 5 V supply is a duty cycle, and a
duty cycle has to be *held* — `pinctrl` (what actuator.js uses) can only set a
level and exit. `lgpio` ships with Raspberry Pi OS, keeps a PWM running in its
own thread, and needs no dtoverlay and no reboot. lidar.js starts this once
and talks to it over stdin, one command per line:

    on <duty 0-100>     IN1 high, IN2 low, ENA pulsed at <duty> %
    off                 ENA, IN1, IN2 all low
    quit

Answers on stdout, one line each: `ready`, `ok ...` or `err <message>`.

Every way out of here ends with the three pins low: `off`, stdin closing
(the server died — nothing is left to stop the motor, so this does), SIGTERM,
and an exception. A motor that keeps spinning because the thing that started
it has gone is exactly what the `finally` is for.
"""
import signal
import sys

import lgpio


def main():
    if len(sys.argv) != 5:
        print('err usage: lidar_pwm.py <pwm> <in1> <in2> <hz>', flush=True)
        return 2
    pwm, in1, in2, hz = (int(a) for a in sys.argv[1:5])

    # SIGTERM would otherwise end the process without running `finally`.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    try:
        h = lgpio.gpiochip_open(0)
        for p in (pwm, in1, in2):
            lgpio.gpio_claim_output(h, p, 0)
    except Exception as e:  # noqa: BLE001 — the message is the whole report
        print(f'err GPIO açılmadı: {e}', flush=True)
        return 1

    def off():
        # Stopping a PWM that is not running is an error in lgpio ('bad PWM
        # micros') — and an off must never fail before it has written the pins.
        try:
            lgpio.tx_pwm(h, pwm, 0, 0)
        except lgpio.error:
            pass
        lgpio.gpio_write(h, pwm, 0)
        lgpio.gpio_write(h, in1, 0)
        lgpio.gpio_write(h, in2, 0)

    print('ready', flush=True)
    try:
        for line in sys.stdin:
            word = line.split()
            if not word:
                continue
            try:
                if word[0] == 'on':
                    duty = max(0.0, min(100.0, float(word[1])))
                    # Direction before the pulse, same order as the actuator:
                    # the bridge never starts even briefly the wrong way round.
                    lgpio.gpio_write(h, in2, 0)
                    lgpio.gpio_write(h, in1, 1)
                    lgpio.tx_pwm(h, pwm, hz, duty)
                    print(f'ok on {duty:g}', flush=True)
                elif word[0] == 'off':
                    off()
                    print('ok off', flush=True)
                elif word[0] == 'quit':
                    break
                else:
                    print(f'err naməlum əmr: {word[0]}', flush=True)
            except Exception as e:  # noqa: BLE001
                print(f'err {e}', flush=True)
    finally:
        try:
            off()
        finally:
            lgpio.gpiochip_close(h)
    return 0


if __name__ == '__main__':
    sys.exit(main())
