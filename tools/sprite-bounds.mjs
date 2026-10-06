// Writes data/sprite-bounds.json: for every PNG in assets/sprites, the box [x, y, w, h]
// of its non-transparent pixels. The band crops its SVG viewBox to this box so the egg and
// every Pokémon fill the sprite area. Plain Node, no dependencies: `node tools/sprite-bounds.mjs`.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'assets', 'sprites')

/** Alpha channel of a PNG as { width, height, alpha: Uint8Array }; opaque when it has none. */
export function decodeAlpha(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let ihdr = null
  let palAlpha = null
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      }
    } else if (type === 'tRNS') palAlpha = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!ihdr) throw new Error('no IHDR')
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG not supported')
  const { width, height, depth, color } = ihdr
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]
  const bitsPerPixel = channels * depth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const raw = inflateSync(Buffer.concat(idat))
  const rows = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]
      const a = i >= bpp ? rows[dst + i - bpp] : 0
      const b = y > 0 ? rows[dst - stride + i] : 0
      const c = y > 0 && i >= bpp ? rows[dst - stride + i - bpp] : 0
      let v
      if (filter === 0) v = x
      else if (filter === 1) v = x + a
      else if (filter === 2) v = x + b
      else if (filter === 3) v = x + ((a + b) >> 1)
      else {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      rows[dst + i] = v & 255
    }
  }
  const alpha = new Uint8Array(width * height).fill(255)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const row = y * stride
      if (color === 6) alpha[y * width + x] = rows[row + x * 4 * (depth / 8) + 3 * (depth / 8)]
      else if (color === 4) alpha[y * width + x] = rows[row + x * 2 * (depth / 8) + depth / 8]
      else if (color === 3) {
        const bit = x * depth
        const byte = rows[row + (bit >> 3)]
        const idx = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
        alpha[y * width + x] = palAlpha && idx < palAlpha.length ? palAlpha[idx] : 255
      }
    }
  }
  return { width, height, alpha }
}

/** [x, y, w, h] of the pixels that are not fully transparent, or null for an empty image. */
export function contentBox({ width, height, alpha }) {
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] === 0) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = {}
  const names = readdirSync(dir).filter(f => f.endsWith('.png'))
  names.sort((a, b) => (parseInt(a, 10) || 1e9) - (parseInt(b, 10) || 1e9))
  for (const file of names) {
    const box = contentBox(decodeAlpha(readFileSync(join(dir, file))))
    if (box) out[file.replace(/\.png$/, '')] = box
  }
  writeFileSync(join(root, 'data', 'sprite-bounds.json'), JSON.stringify(out) + '\n')
  console.log(`wrote data/sprite-bounds.json (${Object.keys(out).length} sprites)`)
}
