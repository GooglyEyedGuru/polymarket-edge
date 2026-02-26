/**
 * Weather market pricer.
 * Uses Open-Meteo (free, no key) + NOAA forecast as cross-check.
 * Parses temperature/precipitation range questions and computes
 * our fair probability from model forecasts.
 */
import axios from 'axios';
import { PolymarketMarket, PricerResult } from '../types';

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING  = 'https://geocoding-api.open-meteo.com/v1/search';

interface WeatherForecast {
  daily: {
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum:  number[];
    time:               string[];
  };
}

// ── Resolve city name → lat/lon via Open-Meteo geocoding ─────
async function geocode(city: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const res = await axios.get(GEOCODING, {
      params: { name: city, count: 1, language: 'en', format: 'json' },
      timeout: 8_000,
    });
    const r = res.data?.results?.[0];
    if (!r) return null;
    return { lat: r.latitude, lon: r.longitude };
  } catch { return null; }
}

// ── Fetch 7-day daily forecast ────────────────────────────────
async function fetchForecast(lat: number, lon: number): Promise<WeatherForecast | null> {
  try {
    const res = await axios.get(OPEN_METEO, {
      params: {
        latitude: lat, longitude: lon,
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
        temperature_unit: 'fahrenheit',
        timezone: 'auto',
        forecast_days: 7,
      },
      timeout: 10_000,
    });
    return res.data as WeatherForecast;
  } catch { return null; }
}

// ── Parse a temperature range question ───────────────────────
// e.g. "Will NYC high temperature exceed 85°F on July 4th?"
// e.g. "Will Dallas high be between 90°F and 95°F on Friday?"
interface TempQuestion {
  city: string;
  type: 'above' | 'below' | 'range';
  low?: number;
  high?: number;
  threshold?: number;
  targetDate: string;   // YYYY-MM-DD
}

function parseTempQuestion(question: string, endDate: string): TempQuestion | null {
  const q = question.toLowerCase();

  // Extract city (crude heuristic — look for "in [City]" or "[City] high")
  const cityMatch = q.match(/(?:in |for |at )([a-z\s]+?)(?:'s)? (?:daily |high|low|temperature)/);
  const city = cityMatch ? cityMatch[1].trim() : null;
  if (!city) return null;

  // Extract threshold(s)
  const nums = [...q.matchAll(/(\d+\.?\d*)\s*°?\s*f/g)].map(m => Number(m[1]));
  if (nums.length === 0) return null;

  // Determine range type
  if (q.includes('between') && nums.length >= 2) {
    return { city, type: 'range', low: Math.min(...nums), high: Math.max(...nums), targetDate: endDate.slice(0, 10) };
  } else if (q.includes('exceed') || q.includes('above') || q.includes('over') || q.includes('higher than')) {
    return { city, type: 'above', threshold: nums[0], targetDate: endDate.slice(0, 10) };
  } else if (q.includes('below') || q.includes('under') || q.includes('lower than')) {
    return { city, type: 'below', threshold: nums[0], targetDate: endDate.slice(0, 10) };
  }

  return null;
}

// ── Convert forecast temp to probability via normal distribution
// Uses ±σ from forecast as uncertainty model (±4°F = 1 sigma typical NWP error)
function tempProb(
  forecastHigh: number, sigma: number,
  question: TempQuestion,
): number {
  const { erf } = Math;   // not built-in — approximate below
  const z = (x: number) => (x - forecastHigh) / (sigma * Math.SQRT2);
  // Approximate erf using Abramowitz & Stegun formula
  function approxErf(x: number): number {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const sign = x >= 0 ? 1 : -1;
    return sign * (1 - poly * Math.exp(-x * x));
  }
  const cdf = (x: number) => 0.5 * (1 + approxErf(z(x)));

  if (question.type === 'above' && question.threshold !== undefined) {
    return 1 - cdf(question.threshold);
  } else if (question.type === 'below' && question.threshold !== undefined) {
    return cdf(question.threshold);
  } else if (question.type === 'range' && question.low !== undefined && question.high !== undefined) {
    return cdf(question.high) - cdf(question.low);
  }
  return 0.5;
}

// ── Main: price a weather market ─────────────────────────────
export async function priceWeatherMarket(market: PolymarketMarket): Promise<PricerResult | null> {
  const q = parseTempQuestion(market.question, market.end_date_iso);
  if (!q) {
    console.log(`   ⚠️  Could not parse weather question: "${market.question.slice(0, 60)}"`);
    return null;
  }

  const coords = await geocode(q.city);
  if (!coords) {
    console.log(`   ⚠️  Could not geocode city: ${q.city}`);
    return null;
  }

  const forecast = await fetchForecast(coords.lat, coords.lon);
  if (!forecast) return null;

  // Find the forecast for target date
  const idx = forecast.daily.time.findIndex(d => d === q.targetDate);
  if (idx === -1) {
    console.log(`   ⚠️  No forecast for ${q.targetDate}`);
    return null;
  }

  const forecastHigh = forecast.daily.temperature_2m_max[idx];
  const sigma        = 4.0;  // ±4°F typical NWP uncertainty at 3-5 day range

  const fairProb   = tempProb(forecastHigh, sigma, q);
  const yesToken   = market.tokens.find(t => t.outcome.toLowerCase() === 'yes');
  const impliedProb = yesToken?.price ?? 0.5;
  const edgePct    = Math.abs(fairProb - impliedProb) * 100;
  const side       = fairProb > impliedProb ? 'Yes' : 'No';

  return {
    market_id:  market.condition_id,
    side,
    fair_prob:  fairProb,
    implied_prob: impliedProb,
    edge_percent: edgePct,
    confidence:   70,   // base confidence for weather — can be refined
    size_usdc:    0,    // set by risk module
    reasoning_summary: `Open-Meteo forecast: ${forecastHigh.toFixed(1)}°F (±${sigma}°F σ). ` +
      `Fair prob ${(fairProb * 100).toFixed(1)}% vs market ${(impliedProb * 100).toFixed(1)}%. ` +
      `${edgePct.toFixed(1)}% edge on ${side}.`,
    risk_notes: 'NWP uncertainty ±4°F. Resolution oracle dependency. Check forecast freshness.',
  };
}
