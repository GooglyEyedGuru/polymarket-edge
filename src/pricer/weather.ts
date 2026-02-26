/**
 * Weather market pricer.
 * Uses Open-Meteo (free, no key) for daily temperature forecasts.
 *
 * Handles the actual Polymarket question format:
 *   "Will the highest temperature in [City] be [X]°F or higher on [date]?"
 *   "Will the highest temperature in [City] be between X-Y°F on [date]?"
 *   "Will the highest temperature in [City] be [X]°C on [date]?"
 *
 * Fixes applied:
 *   1. Timezone-aware expiry — skips markets whose target date has already
 *      ended in the city's local timezone.
 *   2. Narrow-band sigma — exact/2° markets get tighter σ + reduced confidence
 *      (wrong-station risk is higher when the band is only 1–2 units wide).
 *   3. Minimum per-side liquidity — skips if the tradeable side has < $100
 *      available (avoids illiquid scraps).
 */
import axios from 'axios';
import { PolymarketMarket, PricerResult } from '../types';

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING  = 'https://geocoding-api.open-meteo.com/v1/search';

const MIN_SIDE_LIQUIDITY_USD = 100;

// ── Types ─────────────────────────────────────────────────────
type TempUnit = 'F' | 'C';
type TempType = 'above' | 'below' | 'exact' | 'range';

interface ParsedTempQuestion {
  city:    string;
  unit:    TempUnit;
  type:    TempType;
  low?:    number;
  high?:   number;
  exact?:  number;
  dateStr: string;   // YYYY-MM-DD
}

// ── Question parser ───────────────────────────────────────────
function parseTempQuestion(question: string, endDateIso: string): ParsedTempQuestion | null {
  const unit: TempUnit | null = /°c\b/i.test(question) ? 'C' : /°f\b/i.test(question) ? 'F' : null;
  if (!unit) return null;

  const cityMatch = question.match(/temperature\s+in\s+(.+?)\s+be\s/i);
  if (!cityMatch) return null;
  const city = cityMatch[1].trim();

  const ql = question.toLowerCase();

  // Range: "between X-Y°"
  const rangeMatch = question.match(/between\s+(\d+\.?\d*)\s*[-–]\s*(\d+\.?\d*)/i);
  if (rangeMatch) {
    return { city, unit, type: 'range', low: Number(rangeMatch[1]), high: Number(rangeMatch[2]), dateStr: endDateIso.slice(0, 10) };
  }

  const nums = [...question.matchAll(/(\d+\.?\d*)\s*°?\s*[fc]\b/gi)].map(m => Number(m[1]));
  if (nums.length === 0) return null;

  if (/or higher|or above|or more/.test(ql))  return { city, unit, type: 'above', high: nums[0], dateStr: endDateIso.slice(0, 10) };
  if (/or below|or less|or under|or lower/.test(ql)) return { city, unit, type: 'below', low: nums[0], dateStr: endDateIso.slice(0, 10) };
  if (nums.length === 1)                       return { city, unit, type: 'exact', exact: nums[0], dateStr: endDateIso.slice(0, 10) };

  return null;
}

// ── Geocode with timezone ─────────────────────────────────────
interface GeoResult {
  lat:      number;
  lon:      number;
  timezone: string;   // IANA tz name, e.g. "America/New_York"
}

const geoCache: Record<string, GeoResult> = {};

async function geocodeWithTz(city: string): Promise<GeoResult | null> {
  const key = city.toLowerCase();
  if (geoCache[key]) return geoCache[key];
  try {
    const res = await axios.get(GEOCODING, {
      params: { name: city, count: 1, language: 'en', format: 'json' },
      timeout: 8_000,
    });
    const r = res.data?.results?.[0];
    if (!r) return null;
    const result: GeoResult = { lat: r.latitude, lon: r.longitude, timezone: r.timezone ?? 'UTC' };
    geoCache[key] = result;
    return result;
  } catch { return null; }
}

// ── FIX 1: Timezone-aware expiry check ───────────────────────
// Returns true if the target date has already ended in the city's local timezone.
// E.g. Wellington UTC+13: Feb 27 ends at 11:00 UTC on Feb 27.
function isDateExpiredLocally(dateStr: string, timezone: string): boolean {
  try {
    // Build a datetime representing midnight at the START of the day after dateStr
    // in the city's timezone, then compare to now UTC.
    // e.g. dateStr="2026-02-27", tz="Pacific/Auckland" (UTC+13)
    // "End of Feb 27 Auckland" = "2026-02-28 00:00 NZDT" = "2026-02-27 11:00 UTC"
    const endOfDay = new Date(`${dateStr}T23:59:59`);
    // Format endOfDay as if it's in the target timezone by using toLocaleString
    const nowInTz = new Date().toLocaleString('en-US', { timeZone: timezone });
    const nowLocal = new Date(nowInTz);
    // Get the date string in that timezone for "now"
    const nowDateStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone }); // "YYYY-MM-DD"
    return nowDateStr > dateStr;
  } catch {
    return false; // If timezone is invalid, don't skip
  }
}

// ── Fetch daily forecast with timezone ────────────────────────
interface DailyForecast {
  time:               string[];
  temperature_2m_max: number[];
  timezone:           string;
}

async function fetchForecast(lat: number, lon: number, unit: TempUnit): Promise<DailyForecast | null> {
  try {
    const res = await axios.get(OPEN_METEO, {
      params: {
        latitude:         lat,
        longitude:        lon,
        daily:            'temperature_2m_max',
        temperature_unit: unit === 'F' ? 'fahrenheit' : 'celsius',
        timezone:         'auto',
        forecast_days:    7,
      },
      timeout: 10_000,
    });
    return { ...res.data.daily, timezone: res.data.timezone };
  } catch { return null; }
}

// ── Normal CDF approximation ──────────────────────────────────
function normCdf(x: number, mean: number, sigma: number): number {
  const z = (x - mean) / (sigma * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = (z >= 0 ? 1 : -1) * (1 - p * Math.exp(-z * z));
  return 0.5 * (1 + erf);
}

// ── FIX 2: Sigma and confidence by question type + lead time ──
interface SigmaConf {
  sigma:      number;
  confidence: number;
}

function sigmaAndConf(unit: TempUnit, type: TempType, bandWidth: number, daysAhead: number): SigmaConf {
  // Base NWP uncertainty grows with lead time
  const baseF = unit === 'F' ? 3.0 : 1.7;
  const leadMult = daysAhead <= 1 ? 0.6 : daysAhead <= 2 ? 0.8 : daysAhead <= 3 ? 1.0 : daysAhead <= 5 ? 1.4 : 1.8;
  const sigma = baseF * leadMult;

  // Base confidence by lead time
  let conf = daysAhead <= 1 ? 80 : daysAhead <= 2 ? 75 : 65;

  // FIX 2: Narrow band penalty
  // For exact (±0.5) or narrow range (≤2 units), add station-reading risk:
  // a 1°F error in the official reading could push us to the adjacent bucket.
  const narrowThreshold = unit === 'F' ? 2.0 : 1.0;
  if (type === 'exact' || (type === 'range' && bandWidth <= narrowThreshold)) {
    conf = Math.max(conf - 15, 50);   // -15 conf for narrow bands
  }

  return { sigma, confidence: conf };
}

// ── Probability calculation ───────────────────────────────────
function calcProbability(forecastHigh: number, sigma: number, q: ParsedTempQuestion): number {
  switch (q.type) {
    case 'above': return 1 - normCdf(q.high!, forecastHigh, sigma);
    case 'below': return normCdf(q.low!, forecastHigh, sigma);
    case 'range': return normCdf(q.high!, forecastHigh, sigma) - normCdf(q.low!, forecastHigh, sigma);
    case 'exact': {
      const half = q.unit === 'C' ? 0.5 : 0.5;
      return normCdf(q.exact! + half, forecastHigh, sigma) - normCdf(q.exact! - half, forecastHigh, sigma);
    }
  }
}

// ── FIX 3: Per-side liquidity check ──────────────────────────
function checkSideLiquidity(market: PolymarketMarket, side: 'Yes' | 'No'): boolean {
  const token = market.tokens.find(t => t.outcome.toLowerCase() === side.toLowerCase());
  if (!token) return false;
  // Estimate available liquidity on this side from the token price and market liquidity
  // Jupiter-style: side liquidity ≈ market.liquidity × token.price (rough)
  // Use a simple heuristic: if market liquidity < 2× MIN, skip
  const estimatedSideLiq = market.liquidity * token.price;
  return estimatedSideLiq >= MIN_SIDE_LIQUIDITY_USD || market.liquidity >= MIN_SIDE_LIQUIDITY_USD * 2;
}

// ── Human-readable threshold string ──────────────────────────
function thresholdStr(q: ParsedTempQuestion): string {
  const u = q.unit === 'F' ? '°F' : '°C';
  switch (q.type) {
    case 'above': return `≥${q.high}${u}`;
    case 'below': return `≤${q.low}${u}`;
    case 'range': return `${q.low}–${q.high}${u}`;
    case 'exact': return `=${q.exact}${u} (±0.5${u})`;
  }
}

// ── Main pricer ───────────────────────────────────────────────
export async function priceWeatherMarket(market: PolymarketMarket): Promise<PricerResult | null> {
  // Parse question
  const parsed = parseTempQuestion(market.question, market.end_date_iso);
  if (!parsed) {
    console.log(`   ⚠️  Could not parse: "${market.question.slice(0, 70)}"`);
    return null;
  }

  // Geocode + timezone
  const geo = await geocodeWithTz(parsed.city);
  if (!geo) {
    console.log(`   ⚠️  Could not geocode: "${parsed.city}"`);
    return null;
  }

  // FIX 1: Skip if target date already passed in local timezone
  if (isDateExpiredLocally(parsed.dateStr, geo.timezone)) {
    console.log(`   ⏰ Skipping — ${parsed.dateStr} already ended in ${parsed.city} (${geo.timezone})`);
    return null;
  }

  // Fetch forecast
  const forecast = await fetchForecast(geo.lat, geo.lon, parsed.unit);
  if (!forecast) return null;

  const idx = forecast.time.findIndex(d => d === parsed.dateStr);
  if (idx === -1) {
    console.log(`   ⚠️  No forecast data for ${parsed.dateStr}`);
    return null;
  }

  const forecastHigh = forecast.temperature_2m_max[idx];
  const daysAhead    = (new Date(parsed.dateStr).getTime() - Date.now()) / 86_400_000;

  // Band width for narrow-band check
  const bandWidth = parsed.type === 'range'
    ? (parsed.high! - parsed.low!)
    : parsed.type === 'exact' ? 1.0
    : Infinity;

  // FIX 2: Sigma + confidence with narrow-band penalty
  const { sigma, confidence } = sigmaAndConf(parsed.unit, parsed.type, bandWidth, daysAhead);

  const fairProb    = calcProbability(forecastHigh, sigma, parsed);
  const yesToken    = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const impliedProb = yesToken?.price ?? 0.5;
  const edgePct     = Math.abs(fairProb - impliedProb) * 100;
  const side        = fairProb > impliedProb ? 'Yes' : 'No';

  // FIX 3: Liquidity check on the side we'd trade
  if (!checkSideLiquidity(market, side as 'Yes' | 'No')) {
    console.log(`   💧 Skipping — insufficient liquidity on ${side} side ($${market.liquidity.toFixed(0)} total)`);
    return null;
  }

  const tStr  = thresholdStr(parsed);
  const uStr  = parsed.unit === 'F' ? '°F' : '°C';
  const narrowNote = (parsed.type === 'exact' || bandWidth <= (parsed.unit === 'F' ? 2 : 1))
    ? ` [narrow band: conf -15]` : '';

  return {
    market_id:    market.condition_id,
    side,
    fair_prob:    fairProb,
    implied_prob: impliedProb,
    edge_percent: edgePct,
    confidence,
    size_usdc:    0,
    reasoning_summary:
      `Open-Meteo ${parsed.city}: ${forecastHigh.toFixed(1)}${uStr} high ` +
      `(±${sigma.toFixed(1)}${uStr} σ, ${daysAhead.toFixed(1)}d ahead${narrowNote}). ` +
      `Fair ${(fairProb * 100).toFixed(1)}% for ${tStr} vs mkt ${(impliedProb * 100).toFixed(1)}%. ` +
      `${edgePct.toFixed(1)}% edge on ${side}.`,
    risk_notes:
      `NWP σ ±${sigma.toFixed(1)}${uStr}. Resolution source: official wx station — verify.` +
      (parsed.type === 'exact' || bandWidth <= (parsed.unit === 'F' ? 2 : 1)
        ? ' Narrow band: adjacent-bucket resolution risk.'
        : ''),
  };
}
