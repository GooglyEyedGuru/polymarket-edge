/**
 * Configures a SOCKS5 proxy on the global axios instance.
 * Must be imported before any CLOB client usage.
 * Used to route Polymarket order calls through a non-US IP (geo-block bypass).
 */
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

export function setupProxy() {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) {
    console.log('⚠️  No PROXY_URL set — Polymarket orders may be geo-blocked');
    return;
  }

  const agent = new SocksProxyAgent(proxyUrl);

  // Patch global axios defaults — clob-client uses the default axios instance
  axios.defaults.httpsAgent = agent;
  axios.defaults.httpAgent  = agent;
  // Disable axios's built-in proxy handling (conflicts with manual agent)
  axios.defaults.proxy = false as any;

  console.log(`🌐 Proxy configured: ${proxyUrl.replace(/:[^:@]+@/, ':***@')}`);
}
