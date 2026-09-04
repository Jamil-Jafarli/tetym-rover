import serial, time

ser = serial.Serial("/dev/ttyUSB0", 115200, timeout=2)
time.sleep(2.5)
ser.reset_input_buffer()

def send(cmd, wait=20):
    print(f">>> {cmd}")
    ser.write((cmd + "\n").encode()); ser.flush()
    t0 = time.time()
    while time.time() - t0 < wait:
        line = ser.readline().decode(errors="replace").strip()
        if line:
            print(f"    {line}")
            if line.startswith("ok"):
                return

send("M211 S0")        # software endstops off (machine is not homed)
send("M17")            # energize steppers
send("G91")            # relative positioning
send("M114")

print("\n--- 80mm forward = 2 revolutions (80 steps/mm, 3200 steps/rev) ---")
send("G1 X80 F1200")
send("M400")           # block until the move is physically finished
send("M114")

time.sleep(0.5)
print("\n--- 80mm back ---")
send("G1 X-80 F1200")
send("M400")
send("M114")

send("G90")            # back to absolute
ser.close()
