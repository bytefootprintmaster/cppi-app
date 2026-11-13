/**
 * Generates the PWA icon set into public/icons/.
 *
 *   node scripts/generate-icons.mjs
 *
 * The artwork uses the red, blue and green CPPI building mark on charcoal.
 * Everything is rasterised here with plain math so the icons are deterministic.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const OUT_DIR = path.resolve(process.cwd(), 'public', 'icons')

/* ---------------------------------- png ---------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data])
  out.writeUInt32BE(crc32(crcInput), 8 + data.length)
  return out
}

function encodePng(size, rgba) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* --------------------------------- artwork -------------------------------- */

const BACKGROUND = [0x25, 0x25, 0x25]
const MARK_SHAPES = [
  { color: [0xdf, 0x00, 0x00], points: [[22, 69], [68, 23], [68, 185], [22, 185]] },
  { color: [0x07, 0x85, 0xed], points: [[80, 69], [126, 69], [126, 185], [80, 185]] },
  { color: [0x25, 0x8d, 0x43], points: [[140, 23], [185, 69], [185, 185], [140, 185]] }
]
const SUPERSAMPLE = 4 // 4x4 samples per pixel for smooth edges

function insidePolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

function insideRoundedSquare(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false
  if (radius <= 0) return true
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
}

function render(size, { rounded }) {
  const rgba = Buffer.alloc(size * size * 4)
  const radius = rounded ? size * 0.235 : 0
  const total = SUPERSAMPLE * SUPERSAMPLE

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0
      const shapeCoverage = [0, 0, 0]

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE
          const py = y + (sy + 0.5) / SUPERSAMPLE
          if (!insideRoundedSquare(px, py, size, radius)) continue
          covered++

          const markX = (px / size) * 208
          const markY = (py / size) * 208
          const shape = MARK_SHAPES.findIndex((item) => insidePolygon(markX, markY, item.points))
          if (shape !== -1) shapeCoverage[shape]++
        }
      }

      const offset = (y * size + x) * 4
      if (covered === 0) continue

      const alpha = covered / total
      for (let channel = 0; channel < 3; channel++) {
        let value = BACKGROUND[channel] * (covered - shapeCoverage.reduce((sum, count) => sum + count, 0))
        for (let shape = 0; shape < MARK_SHAPES.length; shape++) {
          value += MARK_SHAPES[shape].color[channel] * shapeCoverage[shape]
        }
        rgba[offset + channel] = Math.round(value / covered)
      }
      rgba[offset + 3] = Math.round(alpha * 255)
    }
  }

  return encodePng(size, rgba)
}

/* ---------------------------------- output -------------------------------- */

const TARGETS = [
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-512.png', size: 512, rounded: true },
  // Maskable icons get cropped to a circle by the OS, so keep it full-bleed
  // with the building mark inside the 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, rounded: false },
  // iOS applies its own mask and does not render transparency well.
  { file: 'apple-touch-icon.png', size: 180, rounded: false }
]

fs.mkdirSync(OUT_DIR, { recursive: true })

for (const target of TARGETS) {
  const png = render(target.size, target)
  fs.writeFileSync(path.join(OUT_DIR, target.file), png)
  console.log(`✔ ${target.file} (${target.size}×${target.size}, ${(png.length / 1024).toFixed(1)} kB)`)
}

console.log(`\nWrote ${TARGETS.length} icons to ${path.relative(process.cwd(), OUT_DIR)}`)
