import argparse
import collections
import struct
from pathlib import Path


parser = argparse.ArgumentParser(description="Decode a meowprinter log.")
parser.add_argument("input", help="Path to the log file to decode")
args = parser.parse_args()

input_path = Path(args.input).resolve()
data = input_path.read_bytes()
print(data[:16])

off = 16
packets = []

while off + 24 <= len(data):
    _, length, flags, drops, timestamp = struct.unpack(
        ">IIIIq", data[off : off + 24]
    )
    off += 24

    if off + length > len(data):
        print("Warning: incomplete packet at end of file; stopping.")
        break

    packets.append((flags, data[off : off + length]))
    off += length

print(len(packets))

# Find ATT writes (opcode 0x52 write command, 0x12 write request) in ACL packets.
acl_packets = []
for index, (flags, packet) in enumerate(packets):
    if packet and packet[0] == 0x02 and len(packet) >= 13:
        cid = struct.unpack("<H", packet[7:9])[0]
        att = packet[9:]
        acl_packets.append((index, flags & 1, cid, att))

counts = collections.Counter(
    (direction, att[0] if att else None)
    for _, direction, _, att in acl_packets
)
print(counts)

writes = [
    (index, att[1:])
    for index, _, cid, att in acl_packets
    if cid == 4 and att and att[0] in (0x52, 0x12)
]
print(len(writes))

handles = collections.Counter(
    payload[0] + payload[1] * 256
    for _, payload in writes
    if len(payload) >= 2
)
print(handles)

notifications = [
    (index, att)
    for index, _, cid, att in acl_packets
    if cid == 4 and att and att[0] == 0x1B
]

writes_path = input_path.with_name(f"{input_path.stem}_writes.txt")
notifications_path = input_path.with_name(
    f"{input_path.stem}_notifications.txt"
)

writes_path.write_text(
    "\n".join(
        f"{index} {payload[0] + payload[1] * 256:#x} {payload[2:].hex()}"
        for index, payload in writes
        if len(payload) >= 2
    )
)

notifications_path.write_text(
    "\n".join(
        f"{index} {att[1] + att[2] * 256:#x} {att[3:].hex()}"
        for index, att in notifications
        if len(att) >= 3
    )
)

print(f"Writes: {writes_path}")
print(f"Notifications: {notifications_path}")