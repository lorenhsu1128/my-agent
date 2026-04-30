#!/usr/bin/env bun
// 產 128×128 純紅 PNG，給 vision-e2e.sh 使用。
// 用法：bun tests/e2e/_make-red-png.ts <output-path>
import { writeFileSync } from 'fs'
import * as zlib from 'zlib'

const out = process.argv[2]
if (!out) {
  console.error('usage: bun _make-red-png.ts <out.png>')
  process.exit(2)
}

const w = 128
const h = 128

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.concat([t, data])
  let crc = 0xffffffff
  for (const b of crcBuf) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  const crcOut = Buffer.alloc(4)
  crcOut.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([len, t, data, crcOut])
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(w, 0)
ihdr.writeUInt32BE(h, 4)
ihdr[8] = 8
ihdr[9] = 2
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const rowLen = 1 + w * 3
const raw = Buffer.alloc(rowLen * h)
for (let y = 0; y < h; y++) {
  raw[y * rowLen] = 0
  for (let x = 0; x < w; x++) {
    raw[y * rowLen + 1 + x * 3] = 255
    raw[y * rowLen + 1 + x * 3 + 1] = 0
    raw[y * rowLen + 1 + x * 3 + 2] = 0
  }
}

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync(out, png)
console.log(`wrote ${png.length} bytes to ${out}`)
