/**
 * Weather market pricer.
 * Uses Open-Meteo (free, no key) for daily temperature forecasts.
 *
 * Handles the actual Polymarket question format:
 *   "Will the highest temperature in [City] be [X]°F [or higher|or below|between X-Y] on [date]?"
 *   "Will the highest temperature in [City] be [X]°C on [date]?"
 */
import axios from 'axios';
import { PolymarketMarket, PricerResult } from '../types';

const OPEN_METEO  = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING   = 'https://geocoding-api.open-meteo.com/v1/search';

// ── Question parser ───────────────────────────────────────────
// Handles: "Will the highest temperature in [City] be X°F or higher on [date]"
//          "Will the highest temperature in [City] be between X-Y°F on [date]"
//          "Will the highest temperature in [City] be X°C on [date]"  (exact = ±0.5°)
//          "Will the highest temperature in [City] be X°F or below on [date]"

type TempUnit  = 'F' | 'C';
type TempType  = 'above' | 'below' | 'exact' | 'range';

interface ParsedTempQuestion {
  city:      string;
  unit:      TempUnit;
  type:      TempType;
  low?:      number;   // for range / below
  high?:     number;   // for range / above
  exact?:    number;   // for exact
  dateStr:   string;   // YYYY-MM-DD (from market end_date_iso)
}

function parseTempQuestion(question: string, endDateIso: string): ParsedTempQuestion | null {
  const q    = question.trim();
  const unit: TempUnit = /°c\b/i.test(q) ? 'C' : /°f\b/i.test(q) ? 'F' : null as any;
  if (!unit) return null;

  // Extract city: "highest temperature in [City] be"
  const cityMatch = q.match(/temperature\s+in\s+(.+?)\s+be\s/i);
  if (!cityMatch) return null;
  const city = cityMatch[1].trim();

  // Extract all numbers in the question
  const nums = [...q.matchAll(/(\d+\.?\d*)\s*°?\s*[fc]\b/gi)].map(m => Number(m[1]));
  if (nums.length === 0) return null;

  const ql = q.toLowerCase();

  // Range: "between X-Y" or "between X and Y"
  const rangeMatch = q.match(/between\s+(\d+\.?\d*)\s*[-–and]\s*(\d+\.?\d*)/i);
  if (rangeMatch) {
    return {
      city, unit, type: 'range',
      low:  Number(rangeMatch[1]),
      high: Number(rangeMatch[2]),
      dateStr: endDateIso.slice(0, 10),
    };
  }

  // Above: "or higher", "or above", "or more"
  if (/or higher|or above|or more/.test(ql)) {
    return { city, unit, type: 'above', high: nums[0], dateStr: endDateIso.slice(0, 10) };
  }

  // Below: "or below", "or less", "or under", "or lower"
  if (/or below|or less|or under|or lower/.test(ql)) {
    return { city, unit, type: 'below', low: nums[0], dateStr: endDateIso.slice(0, 10) };
  }

  // Exact value: "be 12°C on" / "be 74°F on" — treat as ±0.5 unit range
  if (nums.length === 1) {
    return { city, unit, type: 'exact', exact: nums[0], dateStr: endDateIso.slice(0, 10) };
  }

  return null;
}

// ── Geocoding ─────────────────────────────────────────────────
// Cache geocodes to avoid hammering the API
const geocodeCache: Record<string, { lat: number; lon: number }> = {};

async function geocode(city: string): Promise<{ lat: number; lon: number } | null> {
  const key = city.toLowerCase();
  if (geocodeCache[key]) return geocodeCache[key];
  try {
    const res = await axios.get(GEOCODING, {
      params: { name: city, count: 1, language: 'en', format: 'json' },
      timeout: 8_000,
    });
    const r = res.data?.results?.[0];
    if (!r) return null;
    const result = { lat: r.latitude, lon: r.longitude };
    geocodeCache[key] = result;
    return result;
  } catch { return null; }
}

// ── Fetch daily forecast ──────────────────────────────────────
interface DailyForecast {
  time:                  string[];
  temperature_2m_max:    number[];
  temperature_2m_min:    number[];
}

async function fetchDailyForecast(
  lat: number, lon: number, unit: TempUnit,
): Promise<DailyForecast | null> {
  try {
    const res = await axios.get(OPEN_METEO, {
      params: {
        latitude:         lat,
        longitude:        lon,
        daily:            'temperature_2m_max,temperature_2m_min',
        temperature_unit: unit === 'F' ? 'fahrenheit' : 'celsius',
        timezone:         'auto',
        forecast_days:    7,
      },
      timeout: 10_000,
    });
    return res.data?.daily ?? null;
  } catch { return null; }
}

// ── Normal CDF approximation ──────────────────────────────────
function normCdf(x: number, mean: number, sigma: number): number {
  const z = (x - mean) / (sigma * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = (z >= 0 ? 1 : -1) * (1 - poly * Math.exp(-z * z));
  return 0.5 * (1 + erf);
}

// ── Convert forecast + question to probability ────────────────
function calcProbability(
  forecastHigh: number,
  sigma:        number,
  q:            ParsedTempQuestion,
): number {
  switch (q.type) {
    case 'above':
      return 1 - normCdf(q.high!, forecastHigh, sigma);
    case 'below':
      return normCdf(q.low!, forecastHigh, sigma);
    case 'range':
      return normCdf(q.high!, forecastHigh, sigma) - normCdf(q.low!, forecastHigh, sigma);
    case 'exact': {
      // Treat exact as ±0.5 unit band
      const halfBand = q.unit === 'C' ? 0.5 : 0.5;
      return normCdf(q.exact! + halfBand, forecastHigh, sigma) -
             normCdf(q.exact! - halfBand, forecastHigh, sigma);
    }
  }
}

// ── Forecast uncertainty (sigma) by days ahead ───────────────
// NWP error grows with lead time: ~2°F/°C at day 1, ~4 at day 3, ~6 at day 5+
function forecastSigma(unit: TempUnit, daysAhead: number): number {
  const base = unit === 'F' ? 3 : 1.7;   // convert: 3°F ≈ 1.7°C
  if (daysAhead <= 1) return base * 0.6;
  if (daysAhead <= 2) return base * 0.8;
  if (daysAhead <= 3) return base * 1.0;
  if (daysAhead <= 5) return base * 1.4;
  return base * 1.8;
}

// ── Main pricer ───────────────────────────────────────────────
export async function priceWeatherMarket(market: PolymarketMarket): Promise<PricerResult | null> {
  const parsed = parseTempQuestion(market.question, market.end_date_iso);
  if (!parsed) {
    console.log(`   ⚠️  Could not parse: "${market.question.slice(0, 70)}"`);
    return null;
  }

  const coords = await geocode(parsed.city);
  if (!coords) {
    console.log(`   ⚠️  Could not geocode: "${parsed.city}"`);
    return null;
  }

  const forecast = await fetchDailyForecast(coords.lat, coords.lon, parsed.unit);
  if (!forecast) return null;

  const idx = forecast.time.findIndex(d => d === parsed.dateStr);
  if (idx === -1) {
    console.log(`   ⚠️  No forecast data for ${parsed.dateStr}`);
    return null;
  }

  const forecastHigh = forecast.temperature_2m_max[idx];
  const daysAhead    = (new Date(parsed.dateStr).getTime() - Date.now()) / 86_400_000;
  const sigma        = forecastSigma(parsed.unit, daysAhead);
  const fairProb     = calcProbability(forecastHigh, sigma, parsed);

  const yesToken    = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const impliedProb = yesToken?.price ?? 0.5;
  const edgePct     = Math.abs(fairProb - impliedProb) * 100;
  const side        = fairProb > impliedProb ? 'Yes' : 'No';

  // Confidence: higher for near-term forecasts, lower for far out
  const baseConf  = daysAhead <= 1 ? 80 : daysAhead <= 2 ? 75 : 65;

  // Build human-readable threshold string
  const unitStr = parsed.unit === 'F' ? '°F' : '°C';
  let thresholdStr: string;
  switch (parsed.type) {
    case 'above': thresholdStr = `≥${parsed.high}${unitStr}`;   break;
    case 'below': thresholdStr = `≤${parsed.low}${unitStr}`;    break;
    case 'range': thresholdStr = `${parsed.low}–${parsed.high}${unitStr}`; break;
    case 'exact': thresholdStr = `=${parsed.exact}${unitStr}`;  break;
  }

  return {
    market_id:     market.condition_id,
    side,
    fair_prob:     fairProb,
    implied_prob:  impliedProb,
    edge_percent:  edgePct,
    confidence:    baseConf,
    size_usdc:     0,
    reasoning_summary:
      `Open-Meteo forecast ${parsed.city}: ${forecastHigh.toFixed(1)}${unitStr} high ` +
      `(±${sigma.toFixed(1)}${unitStr} σ, ${daysAhead.toFixed(1)}d ahead). ` +
      `Fair ${(fairProb*100).toFixed(1)}% for ${thresholdStr} vs market ${(impliedProb*100).toFixed(1)}%. ` +
      `${edgePct.toFixed(1)}% edge → ${side}.`,
    risk_notes:
      `NWP σ ±${sigma.toFixed(1)}${unitStr}. Resolution source is official weather station — verify which. ` +
      `Market expires ${parsed.dateStr}.`,
  };
}
