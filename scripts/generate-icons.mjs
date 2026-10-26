/**
 * Generates the PWA icon set into public/icons/.
 *
 *   node scripts/generate-icons.mjs
 *
 * The artwork mirrors the in-app brand mark: a rounded tile with a light green
 * diagonal gradient and a dark green "C". Everything is rasterised here with
 * plain math (no fonts, no image deps) so the output is deterministic and the
 * icons stay pixel-consistent with the brand across sizes.
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

const GRADIENT_FROM = [0x4b, 0xd3, 0x9a] // green-300
const GRADIENT_TO = [0x10, 0x93, 0x5f] // green-500
const GLYPH = [0x07, 0x1f, 0x16] // green-950

const SUPERSAMPLE = 4 // 4x4 samples per pixel for smooth edges

function insideRoundedSquare(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false
  if (radius <= 0) return true
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
}

function render(size, { rounded, glyphScale }) {
  const rgba = Buffer.alloc(size * size * 4)
  const radius = rounded ? size * 0.235 : 0
  const outer = size * 0.3 * glyphScale
  const inner = outer - size * 0.098 * glyphScale
  const gapHalfAngle = (26 * Math.PI) / 180 // the "C" opening, facing right
  const centre = size / 2
  const total = SUPERSAMPLE * SUPERSAMPLE

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0
      let glyph = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE
          const py = y + (sy + 0.5) / SUPERSAMPLE
          if (!insideRoundedSquare(px, py, size, radius)) continue
          covered++

          const dx = px - centre
          const dy = py - centre
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d <= outer && d >= inner && Math.abs(Math.atan2(dy, dx)) > gapHalfAngle) {
            glyph++
          }
        }
      }

      const offset = (y * size + x) * 4
      if (covered === 0) continue

      const alpha = covered / total
      // Diagonal (140deg-ish) gradient, light at the top-left.
      const t = (x + y) / (2 * size)
      const opacity = glyph / covered

      for (let channel = 0; channel < 3; channel++) {
        const background = GRADIENT_FROM[channel] + (GRADIENT_TO[channel] - GRADIENT_FROM[channel]) * t
        rgba[offset + channel] = Math.round(
          background + (GLYPH[channel] - background) * opacity
        )
      }
      rgba[offset + 3] = Math.round(alpha * 255)
    }
  }

  return encodePng(size, rgba)
}

/* ---------------------------------- output -------------------------------- */

const TARGETS = [
  { file: 'icon-192.png', size: 192, rounded: true, glyphScale: 1 },
  { file: 'icon-512.png', size: 512, rounded: true, glyphScale: 1 },
  // Maskable icons get cropped to a circle by the OS, so keep it full-bleed
  // with the glyph inside the 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, rounded: false, glyphScale: 0.76 },
  // iOS applies its own mask and does not render transparency well.
  { file: 'apple-touch-icon.png', size: 180, rounded: false, glyphScale: 1 }
]

fs.mkdirSync(OUT_DIR, { recursive: true })

for (const target of TARGETS) {
  const png = render(target.size, target)
  fs.writeFileSync(path.join(OUT_DIR, target.file), png)
  console.log(`✔ ${target.file} (${target.size}×${target.size}, ${(png.length / 1024).toFixed(1)} kB)`)
}

console.log(`\nWrote ${TARGETS.length} icons to ${path.relative(process.cwd(), OUT_DIR)}`)
