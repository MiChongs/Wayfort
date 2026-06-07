// Shared metadata formatting for the image viewer's EXIF drawer.
//
// exifr hands back raw, mostly-numeric tag values grouped per segment. This
// module turns that into a *complete*, human-readable view — the explicit goal
// is breadth, not a curated subset. It carries:
//   - enum decoders for every standard TIFF / Exif / GPS field
//   - APEX → real-world conversions (aperture / shutter / brightness)
//   - rational, date, GPS and binary formatting
//   - tag-name humanization with an override table for unfriendly acronyms
//   - a derived "summary" of the shot (camera, exposure triangle, where/when)
//
// Anything exifr surfaces gets a sensible rendering; the well-known fields also
// get a decoded label printed next to their raw value.

export type Dict = Record<string, unknown>
export type Segments = Record<string, Dict>

/* ------------------------------------------------------------------ enums -- */

export const ORIENTATION: Record<number, string> = {
  1: "正常",
  2: "水平翻转",
  3: "旋转 180°",
  4: "垂直翻转",
  5: "顺时针 90° + 翻转",
  6: "顺时针 90°",
  7: "逆时针 90° + 翻转",
  8: "逆时针 90°",
}

const RESOLUTION_UNIT: Record<number, string> = { 1: "无单位", 2: "英寸", 3: "厘米" }
const YCBCR_POSITIONING: Record<number, string> = { 1: "居中", 2: "并列" }
const EXPOSURE_PROGRAM: Record<number, string> = {
  0: "未定义", 1: "手动", 2: "标准程序", 3: "光圈优先", 4: "快门优先",
  5: "创意（景深优先）", 6: "运动（高速优先）", 7: "人像", 8: "风景",
}
const METERING_MODE: Record<number, string> = {
  0: "未知", 1: "平均", 2: "中央重点", 3: "点测光", 4: "多点", 5: "评价/矩阵", 6: "局部", 255: "其他",
}
const LIGHT_SOURCE: Record<number, string> = {
  0: "未知", 1: "日光", 2: "荧光灯", 3: "钨丝灯", 4: "闪光灯", 9: "晴天", 10: "阴天", 11: "阴影",
  12: "日光型荧光灯 D", 13: "白昼型荧光灯 N", 14: "冷白荧光灯 W", 15: "白色荧光灯 WW",
  16: "暖白荧光灯 L", 17: "标准光 A", 18: "标准光 B", 19: "标准光 C",
  20: "D55", 21: "D65", 22: "D75", 23: "D50", 24: "ISO 钨丝棚灯", 255: "其他",
}
const COLOR_SPACE: Record<number, string> = { 1: "sRGB", 2: "Adobe RGB", 65535: "未校准", 0xfffe: "宽色域" }
const SENSING_METHOD: Record<number, string> = {
  1: "未定义", 2: "单芯片彩色", 3: "双芯片彩色", 4: "三芯片彩色", 5: "色彩顺序面阵", 7: "三线性", 8: "色彩顺序线阵",
}
const CUSTOM_RENDERED: Record<number, string> = { 0: "正常", 1: "自定义处理" }
const EXPOSURE_MODE: Record<number, string> = { 0: "自动曝光", 1: "手动曝光", 2: "自动包围曝光" }
const WHITE_BALANCE: Record<number, string> = { 0: "自动", 1: "手动" }
const SCENE_CAPTURE: Record<number, string> = { 0: "标准", 1: "风景", 2: "人像", 3: "夜景" }
const GAIN_CONTROL: Record<number, string> = { 0: "无", 1: "弱增益", 2: "强增益", 3: "弱减益", 4: "强减益" }
const CONTRAST: Record<number, string> = { 0: "正常", 1: "柔和", 2: "强烈" }
const SATURATION: Record<number, string> = { 0: "正常", 1: "低", 2: "高" }
const SHARPNESS: Record<number, string> = { 0: "正常", 1: "柔和", 2: "强烈" }
const SUBJECT_RANGE: Record<number, string> = { 0: "未知", 1: "微距", 2: "近景", 3: "远景" }
const FILE_SOURCE: Record<number, string> = { 1: "扫描的胶片", 2: "扫描的反射稿", 3: "数码相机" }
const SCENE_TYPE: Record<number, string> = { 1: "直接拍摄" }
const COMPRESSION: Record<number, string> = {
  1: "无压缩", 2: "CCITT 1D", 3: "T.4/Group 3", 4: "T.6/Group 4", 5: "LZW",
  6: "JPEG（旧）", 7: "JPEG", 8: "Deflate", 32773: "PackBits", 34892: "有损 JPEG",
}
const PHOTOMETRIC: Record<number, string> = {
  0: "白为零", 1: "黑为零", 2: "RGB", 3: "调色板", 4: "透明蒙版", 5: "CMYK", 6: "YCbCr", 8: "CIELab",
}
const PLANAR_CONFIG: Record<number, string> = { 1: "块状", 2: "平面" }
const PREDICTOR: Record<number, string> = { 1: "无", 2: "水平差分", 3: "浮点水平差分" }
const SAMPLE_FORMAT: Record<number, string> = { 1: "无符号整数", 2: "有符号整数", 3: "浮点", 4: "未定义" }
const COMPONENTS: Record<number, string> = { 0: "-", 1: "Y", 2: "Cb", 3: "Cr", 4: "R", 5: "G", 6: "B" }

const GPS_ALTITUDE_REF: Record<number, string> = { 0: "海平面以上", 1: "海平面以下" }
const GPS_DIFFERENTIAL: Record<number, string> = { 0: "无差分校正", 1: "差分校正" }

const ENUMS: Record<string, Record<number, string>> = {
  Orientation: ORIENTATION,
  ResolutionUnit: RESOLUTION_UNIT,
  FocalPlaneResolutionUnit: RESOLUTION_UNIT,
  YCbCrPositioning: YCBCR_POSITIONING,
  ExposureProgram: EXPOSURE_PROGRAM,
  MeteringMode: METERING_MODE,
  LightSource: LIGHT_SOURCE,
  ColorSpace: COLOR_SPACE,
  SensingMethod: SENSING_METHOD,
  CustomRendered: CUSTOM_RENDERED,
  ExposureMode: EXPOSURE_MODE,
  WhiteBalance: WHITE_BALANCE,
  SceneCaptureType: SCENE_CAPTURE,
  GainControl: GAIN_CONTROL,
  Contrast: CONTRAST,
  Saturation: SATURATION,
  Sharpness: SHARPNESS,
  SubjectDistanceRange: SUBJECT_RANGE,
  FileSource: FILE_SOURCE,
  SceneType: SCENE_TYPE,
  Compression: COMPRESSION,
  PhotometricInterpretation: PHOTOMETRIC,
  PlanarConfiguration: PLANAR_CONFIG,
  Predictor: PREDICTOR,
  SampleFormat: SAMPLE_FORMAT,
  GPSAltitudeRef: GPS_ALTITUDE_REF,
  GPSDifferential: GPS_DIFFERENTIAL,
}

// Flash is a packed bitfield, not a flat enum — decode each bit.
function decodeFlash(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  const fired = (v & 0x1) !== 0
  const parts: string[] = [fired ? "闪光灯开启" : "未闪光"]
  const ret = (v >> 1) & 0x3
  if (ret === 2) parts.push("无返回光检测")
  if (ret === 3) parts.push("检测到返回光")
  const mode = (v >> 3) & 0x3
  if (mode === 1) parts.push("强制开启")
  if (mode === 2) parts.push("强制关闭")
  if (mode === 3) parts.push("自动")
  if ((v >> 5) & 0x1) parts.push("无闪光功能")
  if ((v >> 6) & 0x1) parts.push("红眼消减")
  return parts.join(" · ")
}

/* ------------------------------------------------------- APEX conversions -- */

const SQRT2 = Math.SQRT2

// APEX aperture value → f-number. Av = 2·log2(N) ⇒ N = √2^Av.
function apexAperture(av: number): string {
  return `f/${round(Math.pow(SQRT2, av), 1)}`
}
// APEX shutter (time) value → exposure time. Tv = -log2(t) ⇒ t = 2^-Tv.
function apexShutter(tv: number): string {
  return fmtShutter(Math.pow(2, -tv))
}

export function fmtShutter(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return "—"
  if (t >= 1) return `${round(t, 1)} s`
  return `1/${Math.round(1 / t)} s`
}

/* ------------------------------------------------ per-tag value decoders -- */

// Tags whose numeric value carries a real-world meaning beyond the raw number.
// Each returns the human label; the raw value is shown alongside by the panel.
const DECODERS: Record<string, (v: number) => string> = {
  Flash: decodeFlash,
  ShutterSpeedValue: apexShutter,
  ApertureValue: apexAperture,
  MaxApertureValue: apexAperture,
  BrightnessValue: (v) => `${round(v, 2)} EV`,
  ExposureBiasValue: (v) => `${v > 0 ? "+" : ""}${round(v, 2)} EV`,
  ExposureCompensation: (v) => `${v > 0 ? "+" : ""}${round(v, 2)} EV`,
  FNumber: (v) => `f/${round(v, 1)}`,
  ApertureFNumber: (v) => `f/${round(v, 1)}`,
  ExposureTime: fmtShutter,
  FocalLength: (v) => `${round(v, 1)} mm`,
  FocalLengthIn35mmFormat: (v) => `${Math.round(v)} mm（等效 35mm）`,
  ISO: (v) => `ISO ${v}`,
  ISOSpeedRatings: (v) => `ISO ${v}`,
  PhotographicSensitivity: (v) => `ISO ${v}`,
  DigitalZoomRatio: (v) => (v ? `${round(v, 2)}×` : "未使用"),
  SubjectDistance: (v) => (Number.isFinite(v) ? `${round(v, 2)} m` : String(v)),
  GPSAltitude: (v) => `${round(v, 1)} m`,
  GPSSpeed: (v) => `${round(v, 1)}`,
  GPSImgDirection: (v) => `${round(v, 1)}°`,
  GPSDestBearing: (v) => `${round(v, 1)}°`,
  GPSTrack: (v) => `${round(v, 1)}°`,
  GPSHPositioningError: (v) => `${round(v, 1)} m`,
  GPSDOP: (v) => round(v, 2).toString(),
  ExposureIndex: (v) => round(v, 1).toString(),
}

// "ComponentsConfiguration" is an array of channel codes (e.g. [1,2,3,0]).
function decodeComponents(arr: unknown): string | null {
  if (!Array.isArray(arr)) return null
  const s = arr
    .map((n) => COMPONENTS[n as number])
    .filter(Boolean)
    .join("")
  return s || null
}

/* -------------------------------------------------------------- helpers -- */

function round(v: number, places = 6): number {
  const p = Math.pow(10, places)
  return Math.round(v * p) / p
}

// Friendly name overrides — humanizeKey can't recover these from camelCase.
const KEY_LABELS: Record<string, string> = {
  ISO: "ISO 感光度",
  ISOSpeedRatings: "ISO 感光度",
  FNumber: "光圈值 (F)",
  GPSLatitude: "纬度 (原始)",
  GPSLongitude: "经度 (原始)",
  GPSLatitudeRef: "纬度参考",
  GPSLongitudeRef: "经度参考",
  GPSAltitude: "海拔",
  GPSAltitudeRef: "海拔参考",
  GPSImgDirection: "图像方向",
  GPSImgDirectionRef: "方向参考",
  GPSDOP: "定位精度 (DOP)",
  GPSVersionID: "GPS 版本",
  YCbCrPositioning: "YCbCr 定位",
  XResolution: "水平分辨率",
  YResolution: "垂直分辨率",
  FocalLengthIn35mmFormat: "35mm 等效焦距",
  ExifImageWidth: "图像宽度",
  ExifImageHeight: "图像高度",
  ExifVersion: "Exif 版本",
  FlashpixVersion: "Flashpix 版本",
  ComponentsConfiguration: "分量配置",
  DateTimeOriginal: "原始拍摄时间",
  CreateDate: "创建时间",
  ModifyDate: "修改时间",
  OffsetTime: "时区偏移",
  OffsetTimeOriginal: "拍摄时区偏移",
}

// Split "DateTimeOriginal" / "FNumber" → "Date Time Original" / "F Number".
export function humanizeKey(k: string): string {
  if (KEY_LABELS[k]) return KEY_LABELS[k]
  return k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^GPS\b/, "GPS ")
}

/** Decoded label for a tag, or null when nothing better than the raw exists. */
export function decodeTag(key: string, value: unknown): string | null {
  if (typeof value === "number") {
    if (ENUMS[key]) return ENUMS[key][value] ?? null
    if (DECODERS[key]) {
      try {
        return DECODERS[key](value)
      } catch {
        return null
      }
    }
  }
  if (key === "ComponentsConfiguration") return decodeComponents(value)
  return null
}

const TZ_FMT: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}

/** Best-effort string for any raw EXIF value (number, date, rational, blob…). */
export function fmtVal(v: unknown): string {
  if (v == null) return "—"
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "—" : v.toLocaleString("zh-CN", TZ_FMT)
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const len = v instanceof Uint8Array ? v.byteLength : v.byteLength
    return `二进制数据 · ${len} 字节`
  }
  if (Array.isArray(v)) return v.map(fmtVal).join(", ")
  if (typeof v === "object") {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(round(v))
  return String(v)
}

/* ----------------------------------------------------------------- GPS -- */

export type GeoFix = {
  lat: number
  lng: number
  /** Decimal degrees → DMS strings for display. */
  latDMS: string
  lngDMS: string
  altitude: number | null
  direction: number | null
  speed: number | null
  speedUnit: string | null
}

function gpsDecimal(dms: unknown, ref: unknown): number | null {
  if (typeof dms === "number") {
    const dec = dms
    return ref === "S" || ref === "W" ? -dec : dec
  }
  if (!Array.isArray(dms) || dms.length < 1) return null
  const [d = 0, m = 0, s = 0] = dms as number[]
  let dec = d + m / 60 + s / 3600
  if (ref === "S" || ref === "W") dec = -dec
  return round(dec, 6)
}

function toDMS(dec: number, pos: string, neg: string): string {
  const ref = dec >= 0 ? pos : neg
  const abs = Math.abs(dec)
  const d = Math.floor(abs)
  const mFloat = (abs - d) * 60
  const m = Math.floor(mFloat)
  const s = round((mFloat - m) * 60, 2)
  return `${d}°${m}′${s}″ ${ref}`
}

const SPEED_UNIT: Record<string, string> = { K: "km/h", M: "mph", N: "节" }

/** Pull a usable geographic fix out of the GPS segment, if present. */
export function extractGeo(gps: Dict | undefined): GeoFix | null {
  if (!gps) return null
  const lat =
    (typeof gps.latitude === "number" ? gps.latitude : null) ??
    gpsDecimal(gps.GPSLatitude, gps.GPSLatitudeRef)
  const lng =
    (typeof gps.longitude === "number" ? gps.longitude : null) ??
    gpsDecimal(gps.GPSLongitude, gps.GPSLongitudeRef)
  if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
    return null
  }
  let altitude = typeof gps.GPSAltitude === "number" ? gps.GPSAltitude : null
  if (altitude != null && gps.GPSAltitudeRef === 1) altitude = -altitude
  const direction = typeof gps.GPSImgDirection === "number" ? gps.GPSImgDirection : null
  const speed = typeof gps.GPSSpeed === "number" ? gps.GPSSpeed : null
  const speedUnit = typeof gps.GPSSpeedRef === "string" ? SPEED_UNIT[gps.GPSSpeedRef] || gps.GPSSpeedRef : null
  return {
    lat: round(lat, 6),
    lng: round(lng, 6),
    latDMS: toDMS(lat, "N", "S"),
    lngDMS: toDMS(lng, "E", "W"),
    altitude: altitude != null ? round(altitude, 1) : null,
    direction,
    speed,
    speedUnit,
  }
}

/* ------------------------------------------------------------- summary -- */

export type SummaryRow = { icon: SummaryIcon; label: string; value: string; hint?: string }
export type SummaryIcon =
  | "dimensions" | "camera" | "lens" | "aperture" | "shutter" | "iso"
  | "focal" | "flash" | "orientation" | "clock" | "location" | "software" | "color"

// The exposure triangle + the answers to "what / when / where", pulled from
// whichever segment carries each fact. Returns only the rows that exist.
export function buildSummary(seg: Segments): SummaryRow[] {
  const ifd0 = seg.ifd0 || {}
  const exif = seg.exif || {}
  const gps = seg.gps || {}
  const out: SummaryRow[] = []
  const push = (icon: SummaryIcon, label: string, value: string | null, hint?: string) => {
    if (value) out.push({ icon, label, value, hint })
  }
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

  const w = num(exif.ExifImageWidth) ?? num(ifd0.ImageWidth)
  const h = num(exif.ExifImageHeight) ?? num(ifd0.ImageHeight)
  if (w && h) {
    const mp = (w * h) / 1e6
    push("dimensions", "尺寸", `${w} × ${h}`, mp >= 0.1 ? `${round(mp, 1)} 百万像素` : undefined)
  }
  push("camera", "相机", [ifd0.Make, ifd0.Model].filter(Boolean).join(" ").trim() || null)
  push("lens", "镜头", (exif.LensModel as string) || (exif.LensInfo ? fmtVal(exif.LensInfo) : null))

  const fnum = num(exif.FNumber)
  push("aperture", "光圈", fnum != null ? `f/${round(fnum, 1)}` : num(exif.ApertureValue) != null ? apexAperture(exif.ApertureValue as number) : null)
  const exp = num(exif.ExposureTime)
  push("shutter", "快门", exp != null ? fmtShutter(exp) : num(exif.ShutterSpeedValue) != null ? apexShutter(exif.ShutterSpeedValue as number) : null)
  const iso = num(exif.ISO) ?? num(exif.ISOSpeedRatings) ?? num(exif.PhotographicSensitivity)
  push("iso", "感光度", iso != null ? `ISO ${iso}` : null)
  const focal = num(exif.FocalLength)
  const focal35 = num(exif.FocalLengthIn35mmFormat)
  push("focal", "焦距", focal != null ? `${round(focal, 1)} mm${focal35 ? `（≈${Math.round(focal35)}mm）` : ""}` : null)
  const bias = num(exif.ExposureBiasValue)
  push("aperture", "曝光补偿", bias != null && bias !== 0 ? `${bias > 0 ? "+" : ""}${round(bias, 2)} EV` : null)
  push("flash", "闪光灯", num(exif.Flash) != null ? decodeFlash(exif.Flash as number) : null)

  const orient = num(ifd0.Orientation)
  push("orientation", "方向", orient != null ? ORIENTATION[orient] || String(orient) : null)
  const dt = exif.DateTimeOriginal || exif.CreateDate || ifd0.ModifyDate
  push("clock", "拍摄时间", dt instanceof Date ? dt.toLocaleString("zh-CN", TZ_FMT) : null)

  const geo = extractGeo(gps)
  push("location", "坐标", geo ? `${geo.lat}, ${geo.lng}` : null, geo?.altitude != null ? `海拔 ${geo.altitude} m` : undefined)

  push("software", "软件", (ifd0.Software as string) || null)
  push("software", "作者", (ifd0.Artist as string) || (ifd0.Copyright as string) || null)
  const cs = num(exif.ColorSpace)
  push("color", "色彩空间", cs != null ? COLOR_SPACE[cs] || String(cs) : null)
  return out
}

/* ----------------------------------------------------------- segments -- */

// Friendly names + default-open hints for the raw segments exifr returns with
// mergeOutput:false. Order here is the display order.
export const SEGMENTS: { key: string; label: string; open?: boolean }[] = [
  { key: "ifd0", label: "主图像 · IFD0", open: true },
  { key: "exif", label: "拍摄参数 · Exif", open: true },
  { key: "gps", label: "GPS 定位", open: true },
  { key: "ifd1", label: "缩略图 · IFD1" },
  { key: "interop", label: "互操作 · Interop" },
  { key: "iptc", label: "IPTC 图说" },
  { key: "xmp", label: "XMP" },
  { key: "icc", label: "ICC 色彩描述" },
  { key: "jfif", label: "JFIF" },
  { key: "ihdr", label: "PNG 头 · IHDR" },
  { key: "makerNote", label: "厂商私有 · MakerNote" },
  { key: "userComment", label: "用户备注" },
]

/** Flatten all segment fields to "Segment · Key = value" lines for export. */
export function toPlainEntries(seg: Segments): { segment: string; key: string; value: string }[] {
  const out: { segment: string; key: string; value: string }[] = []
  for (const [segKey, fields] of Object.entries(seg)) {
    if (!fields || typeof fields !== "object") continue
    const label = SEGMENTS.find((s) => s.key === segKey)?.label || segKey
    for (const [k, v] of Object.entries(fields as Dict)) {
      out.push({ segment: label, key: humanizeKey(k), value: fmtVal(v) })
    }
  }
  return out
}
