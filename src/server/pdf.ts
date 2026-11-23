/**
 * The site-report PDF.
 *
 * A site worker presses Execute, and this lays out what they captured — the
 * dictated remarks, the on-site photos and the documents they attached — as one
 * branded letterhead report. It is rendered here in Node with pdf-lib rather
 * than sent to the Python agent, because the tap has to resolve on the spot, in
 * a driveway, without a 4-minute round trip.
 *
 * The palette mirrors the agent's reportlab renderer so a portal report and an
 * agent report look like they came from the same office.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'

export interface SiteReportPhoto {
  name: string
  data: Uint8Array
}

export interface SiteReportDocument {
  name: string
  /** Human-readable type and size, shown right-aligned on the row. */
  detail?: string
}

export interface SiteReportInput {
  siteName: string
  siteCode?: string
  siteAddress?: string
  sitePlace?: string
  sentByName: string
  sentByEmail: string
  sentAt: Date
  /** Where the device was standing, e.g. "about 40 m from this project". */
  locationNote?: string
  coordinates?: { lat: number; lng: number }
  remarks?: string
  photos: SiteReportPhoto[]
  documents: SiteReportDocument[]
}

type Color = ReturnType<typeof rgb>

function hex(value: string): Color {
  const n = Number.parseInt(value.slice(1), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

const BRAND_DARK = hex('#0b2f22')
const BRAND = hex('#0f3d2e')
const ACCENT = hex('#10935f')
const ACCENT_LIGHT = hex('#d8f6e6')
const CANVAS = hex('#f3faf6')
const INK = hex('#0a1f17')
const MUTED = hex('#547266')
const LINE = hex('#e2efe9')
const WHITE = hex('#ffffff')

const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 46
const CONTENT_W = PAGE_W - MARGIN * 2
const BODY_SIZE = 11.5
const BODY_LEAD = 16.5
const FOOTER_Y = 30
const CONTENT_FLOOR = FOOTER_Y + 26
const HERO_H = 120
const COLS = 2
const GAP = 14
const CELL_W = (CONTENT_W - GAP) / COLS
const IMG_H = CELL_W * 0.7
const PHOTO_ROW_H = IMG_H + 28

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

function clock(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Standard-font PDFs are WinAnsi: a curly apostrophe from dictation, an em dash
 * or an emoji would make pdf-lib throw mid-render. Typographic characters are
 * folded to their ASCII twins and anything still unencodable is dropped.
 */
function sanitize(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\t\n\r\x20-\x7E\xA0-\xFF]/g, '')
}

/** Letter-spaced small caps, faked because pdf-lib has no tracking control. */
function spaced(text: string): string {
  return text.split('').join(' ')
}

function formatBytes(bytes?: number): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function renderSiteReportPdf(input: SiteReportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique)

  doc.setTitle(sanitize(`Site report — ${input.siteName}`))
  doc.setAuthor(sanitize(input.sentByName))
  doc.setSubject('Site inspection report')
  doc.setCreator('CPPI Portal')
  doc.setProducer('CPPI Portal')
  doc.setCreationDate(input.sentAt)

  const pages: PDFPage[] = []
  let page!: PDFPage
  let y = 0

  const put = (text: string, x: number, baseline: number, f: PDFFont, size: number, color: Color): void => {
    const clean = sanitize(text)
    if (!clean) return
    page.drawText(clean, { x, y: baseline, size, font: f, color })
  }

  const measure = (text: string, f: PDFFont, size: number): number =>
    f.widthOfTextAtSize(sanitize(text), size)

  const putRight = (
    text: string,
    rightEdge: number,
    baseline: number,
    f: PDFFont,
    size: number,
    color: Color
  ): void => {
    put(text, rightEdge - measure(text, f, size), baseline, f, size, color)
  }

  const rule = (atY: number, color: Color = LINE, thickness = 0.8): void => {
    page.drawLine({ start: { x: MARGIN, y: atY }, end: { x: PAGE_W - MARGIN, y: atY }, thickness, color })
  }

  function startPage(hero: boolean): void {
    page = doc.addPage([PAGE_W, PAGE_H])
    pages.push(page)
    // A hairline of brand green across the very top of every page.
    page.drawRectangle({ x: 0, y: PAGE_H - 5, width: PAGE_W, height: 5, color: ACCENT })

    if (hero) {
      page.drawRectangle({ x: 0, y: PAGE_H - HERO_H, width: PAGE_W, height: HERO_H, color: BRAND_DARK })
      page.drawRectangle({ x: 0, y: PAGE_H - 5, width: PAGE_W, height: 5, color: ACCENT })
      put(spaced('CPPI'), MARGIN, PAGE_H - 44, bold, 10.5, ACCENT_LIGHT)
      put('Site report', MARGIN, PAGE_H - 86, bold, 27, WHITE)
      putRight(clock(input.sentAt), PAGE_W - MARGIN, PAGE_H - 48, bold, 16, WHITE)
      putRight(stamp(input.sentAt), PAGE_W - MARGIN, PAGE_H - 66, font, 10.5, ACCENT_LIGHT)
      y = PAGE_H - HERO_H - 26
    } else {
      put('Site report', MARGIN, PAGE_H - 36, bold, 13, BRAND)
      const name = input.siteName.length > 44 ? `${input.siteName.slice(0, 43)}…` : input.siteName
      putRight(name, PAGE_W - MARGIN, PAGE_H - 36, font, 10, MUTED)
      rule(PAGE_H - 48)
      y = PAGE_H - 48 - 26
    }
  }

  /** Break to a new page when `space` no longer fits above the footer. */
  function ensure(space: number): void {
    if (y - space >= CONTENT_FLOOR) return
    startPage(false)
  }

  function section(title: string): void {
    ensure(52)
    page.drawRectangle({ x: MARGIN, y: y - 10, width: 4, height: 13, color: ACCENT })
    put(sanitize(title).toUpperCase(), MARGIN + 12, y - 9, bold, 11, BRAND)
    y -= 20
    rule(y)
    y -= 18
  }

  function paragraphs(text: string): void {
    for (const line of wrap(text, font, BODY_SIZE, CONTENT_W)) {
      ensure(BODY_LEAD + 2)
      if (line) put(line, MARGIN, y - BODY_SIZE, font, BODY_SIZE, INK)
      y -= BODY_LEAD
    }
    y -= 6
  }

  function mutedLine(text: string): void {
    ensure(BODY_LEAD + 4)
    put(text, MARGIN, y - BODY_SIZE, italic, BODY_SIZE, MUTED)
    y -= BODY_LEAD + 8
  }

  startPage(true)

  /* ------------------------------ project block ------------------------------ */

  const blockH = 88
  page.drawRectangle({ x: MARGIN, y: y - blockH, width: CONTENT_W, height: blockH, color: CANVAS })
  page.drawRectangle({ x: MARGIN, y: y - blockH, width: 3.5, height: blockH, color: ACCENT })

  const left = MARGIN + 16
  put(input.siteName, left, y - 27, bold, 15, INK)
  const nameWidth = measure(input.siteName, bold, 15)
  if (input.siteCode) {
    const chip = sanitize(input.siteCode)
    const chipW = measure(chip, bold, 9) + 14
    const chipX = left + nameWidth + 10
    if (chipX + chipW < MARGIN + CONTENT_W - 190) {
      page.drawRectangle({ x: chipX, y: y - 29, width: chipW, height: 14, color: ACCENT_LIGHT })
      put(chip, chipX + 7, y - 26, bold, 9, BRAND)
    }
  }

  const place = [input.siteAddress, input.sitePlace].filter(Boolean).join(', ')
  if (place) put(place, left, y - 46, font, 10.5, MUTED)

  const detected: string[] = []
  if (input.locationNote) detected.push(`Device location: ${input.locationNote}`)
  if (input.coordinates) {
    detected.push(`${input.coordinates.lat.toFixed(5)}, ${input.coordinates.lng.toFixed(5)}`)
  }
  if (detected.length > 0) put(detected.join('  ·  '), left, y - 64, font, 9.5, MUTED)

  const rightEdge = MARGIN + CONTENT_W - 16
  putRight(spaced('SENT BY'), rightEdge, y - 27, bold, 8.5, MUTED)
  putRight(input.sentByName, rightEdge, y - 43, bold, 11, INK)
  putRight(input.sentByEmail, rightEdge, y - 59, font, 9.5, MUTED)

  y -= blockH + 26

  /* --------------------------------- remarks --------------------------------- */

  section('Remarks')
  const remarks = input.remarks?.trim()
  if (remarks) paragraphs(remarks)
  else mutedLine('No remarks were dictated with this report.')

  y -= 8

  /* ---------------------------------- photos --------------------------------- */

  section(`Photos · ${input.photos.length}`)
  if (input.photos.length === 0) {
    mutedLine('No photos were taken with this report.')
  } else {
    for (let index = 0; index < input.photos.length; index += 1) {
      const col = index % COLS
      if (col === 0) ensure(PHOTO_ROW_H + 8)
      const cellX = MARGIN + col * (CELL_W + GAP)
      const image = await embed(page, doc, input.photos[index].data)
      const boxY = y - IMG_H
      page.drawRectangle({ x: cellX, y: boxY, width: CELL_W, height: IMG_H, color: CANVAS })
      if (image) {
        const scale = Math.min((CELL_W - 6) / image.width, (IMG_H - 6) / image.height)
        const w = image.width * scale
        const h = image.height * scale
        page.drawImage(image, {
          x: cellX + (CELL_W - w) / 2,
          y: boxY + (IMG_H - h) / 2,
          width: w,
          height: h
        })
      } else {
        put('Preview unavailable', cellX + 10, boxY + IMG_H / 2, italic, 9.5, MUTED)
      }
      const caption = wrap(input.photos[index].name, font, 9, CELL_W)[0] ?? 'Photo'
      put(caption, cellX, boxY - 12, font, 9, MUTED)

      if (col === COLS - 1 || index === input.photos.length - 1) y -= PHOTO_ROW_H
    }
  }

  y -= 8

  /* -------------------------------- documents -------------------------------- */

  section(`Documents · ${input.documents.length}`)
  if (input.documents.length === 0) {
    mutedLine('No documents were attached with this report.')
  } else {
    for (const item of input.documents) {
      ensure(30)
      page.drawRectangle({ x: MARGIN + 1, y: y - 12, width: 4, height: 4, color: ACCENT })
      const name = wrap(item.name, font, 10.5, CONTENT_W - 150)[0] ?? item.name
      put(name, MARGIN + 14, y - 12, font, 10.5, INK)
      if (item.detail) putRight(item.detail, PAGE_W - MARGIN, y - 12, font, 9.5, MUTED)
      y -= 20
      rule(y + 6)
    }
    y -= 8
  }

  ensure(40)
  put(
    'The photos and documents above are also saved on this project as individual project files.',
    MARGIN,
    y - 10,
    italic,
    9.5,
    MUTED
  )

  /* ---------------------------------- footers --------------------------------- */

  const footerName = input.siteName.length > 40 ? `${input.siteName.slice(0, 39)}…` : input.siteName
  pages.forEach((p, index) => {
    p.drawLine({ start: { x: MARGIN, y: 46 }, end: { x: PAGE_W - MARGIN, y: 46 }, thickness: 0.8, color: LINE })
    p.drawText(sanitize(`CPPI · Site report · ${footerName}`), {
      x: MARGIN,
      y: 32,
      size: 8.5,
      font,
      color: MUTED
    })
    const label = `Page ${index + 1} of ${pages.length}`
    p.drawText(label, {
      x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, 8.5),
      y: 32,
      size: 8.5,
      font,
      color: MUTED
    })
  })

  return doc.save()
}

/** Embed a JPEG or PNG, sniffed from its magic bytes. Returns null if neither. */
async function embed(page: PDFPage, doc: PDFDocument, data: Uint8Array): Promise<PDFImage | null> {
  void page
  try {
    if (data[0] === 0xff && data[1] === 0xd8) return await doc.embedJpg(data)
    if (data[0] === 0x89 && data[1] === 0x50) return await doc.embedPng(data)
  } catch {
    /* A file whose extension lied about its format: fall through to nothing. */
  }
  return null
}

/**
 * Greedy word wrap. Paragraph breaks are preserved; a single word wider than the
 * column (a long file URL) is hard-broken by character so it cannot run off the
 * page.
 */
function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = []
  for (const paragraph of value.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(sanitize(candidate), size) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      if (font.widthOfTextAtSize(sanitize(word), size) > maxWidth) {
        let chunk = ''
        for (const ch of word) {
          if (chunk && font.widthOfTextAtSize(sanitize(chunk + ch), size) > maxWidth) {
            out.push(chunk)
            chunk = ch
          } else {
            chunk += ch
          }
        }
        line = chunk
      } else {
        line = word
      }
    }
    if (line) out.push(line)
  }
  return out
}

export { formatBytes, sanitize }
