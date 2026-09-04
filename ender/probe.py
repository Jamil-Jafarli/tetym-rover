import serial, time, sys

PORT = "/dev/ttyUSB0"
BAUD = 115200

ser = serial.Serial(PORT, BAUD, timeout=2)
time.sleep(2.5)              # board resets on DTR when the port opens
ser.reset_input_buffer()

def send(cmd, wait=1.5):
    print(f">>> {cmd}")
    ser.write((cmd + "\n").encode())
    ser.flush()
    t0 = time.time()
    while time.time() - t0 < wait:
        line = ser.readline().decode(errors="replace").strip()
        if line:
            print(f"    {line}")
            if line.startswith("ok"):
                break

# drain the boot banner
t0 = time.time()
while time.time() - t0 < 2:
    line = ser.readline().decode(errors="replace").strip()
    if line:
        print(f"    {line}")

send("M115", 3)   # firmware info
send("M114", 2)   # current position
ser.close()
