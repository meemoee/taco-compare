// compare.ts – Supabase Edge Function THIS IS A TEST
// Finds Taco Bell stores via Overpass (live if cache empty), caches them in
// tb_locations, fetches each store’s menu (15‑min menu_cache), and returns the
// menu items with the widest price spreads across nearby stores.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ────────────────────────────────────────────────────────────────────────────
// Supabase client
// ────────────────────────────────────────────────────────────────────────────
const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", // service role preferred; fall back to anon if necessary
Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "");
// User‑Agent for all outbound requests
const UA = "Mozilla/5.0 (EdgeFunction) Gecko/2025 TacoBellPriceCompare/1.1";
// ────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ────────────────────────────────────────────────────────────────────────────
function overpassQuery(lat, lon, km) {
  return `[out:json];node["amenity"="fast_food"]["name"="Taco Bell"](around:${km * 1000},${lat},${lon});out;`;
}
async function getStoreId(locationUrl) {
  const html = await fetch(locationUrl, {
    headers: {
      "User-Agent": UA
    }
  }).then((r)=>r.text());
  // Look for JSON‑LD menu URL
  const m = html.match(/"menu":"https?:\/\/www\.tacobell\.com\/food\?store=([A-Za-z0-9]{6,7})/);
  if (m) return m[1];
  // Fallback to data‑code on div#Core
  const m2 = html.match(/id="Core"[^>]+data-code="([A-Za-z0-9]{6,7})/);
  return m2?.[1];
}
const safeProd = (arr)=>(arr ?? []).filter((p)=>p && typeof p === "object" && p.name && p.price?.value !== undefined);
// Fetches and caches menu for one store
async function menuFor(store) {
  // 1. Try cache
  const { data } = await supabase.from("menu_cache").select("json, updated_at").eq("store_id", store).maybeSingle();
  if (data && Date.now() - new Date(data.updated_at).getTime() < 15 * 60_000) {
    return data.json;
  }
  // 2. Official JSON API
  const api = `https://www.tacobell.com/tacobellwebservices/v2/tacobell/products/menu/${store}`;
  let js = {};
  try {
    js = await fetch(api, {
      headers: {
        "User-Agent": UA
      }
    }).then((r)=>r.json());
  } catch  {
    js = {};
  }
  const products = safeProd(js.menuProductCategories?.flatMap((c)=>[
      ...safeProd(c.menuProducts),
      ...safeProd(c.products)
    ]));
  let items = products.map((p)=>({
      name: p.name,
      price: p.price.value
    }));
  // 3. If API empty, scrape category page
  if (!items.length) {
    const html = await fetch(`https://www.tacobell.com/food/tacos?store=${store}`, {
      headers: {
        "User-Agent": UA
      }
    }).then((r)=>r.text());
    const m = html.match(/__NEXT_DATA__"[^>]*>(.*?)<\/script/s);
    if (m) {
      const next = JSON.parse(m[1]);
      const cats = next.props.pageProps.productCategories ?? [];
      items = cats.flatMap((c)=>safeProd(c.products)).map((p)=>({
          name: p.name,
          price: p.price.value
        }));
    }
  }
  // 4. Upsert cache (ignore failure)
  try {
    await supabase.from("menu_cache").upsert({
      store_id: store,
      json: items,
      updated_at: new Date().toISOString()
    });
  } catch (_) {}
  return items;
}
function haversineMi(aLat, aLon, bLat, bLon) {
  const R = 3959;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180;
  const la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
// ────────────────────────────────────────────────────────────────────────────
// Discover stores (DB cache -> Overpass fallback)
// ────────────────────────────────────────────────────────────────────────────
async function findStores(lat, lon, radiusMi) {
  const latΔ = radiusMi / 69;
  const lonΔ = radiusMi / (69 * Math.cos(lat * Math.PI / 180));
  // Check cached tb_locations
  const { data: cached } = await supabase.from("tb_locations").select("*").gte("latitude", lat - latΔ).lte("latitude", lat + latΔ).gte("longitude", lon - lonΔ).lte("longitude", lon + lonΔ);
  if (cached && cached.length) return cached;
  // Live Overpass query
  const km = radiusMi * 1.60934;
  const q = overpassQuery(lat, lon, km);
  const overpass = Deno.env.get("OVERPASS_MIRROR") ?? "https://overpass.kumi.systems/api/interpreter";
  const elements = (await fetch(overpass + "?data=" + encodeURIComponent(q)).then((r)=>r.json())).elements ?? [];
  const stores = [];
  for (const e of elements){
    if (!e.tags?.website) continue;
    const sid = await getStoreId(e.tags.website);
    if (!sid) continue;
    const loc = {
      store_id: sid,
      name: e.tags.name ?? "Taco Bell",
      address: `${e.tags["addr:housenumber"] ?? ""} ${e.tags["addr:street"] ?? ""}`.trim(),
      latitude: e.lat,
      longitude: e.lon
    };
    stores.push(loc);
    try {
      await supabase.from("tb_locations").upsert(loc);
    } catch (_) {}
  }
  return stores;
}
// ────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ────────────────────────────────────────────────────────────────────────────
serve(async (req)=>{
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  if (isNaN(lat) || isNaN(lon)) {
    return new Response("lat & lon required", {
      status: 400
    });
  }
  const radiusMi = Number(u.searchParams.get("radius_mi") ?? 30);
  const storesWanted = Number(u.searchParams.get("stores") ?? 3);
  const rowsWanted = Number(u.searchParams.get("rows") ?? 15);
  const all = await findStores(lat, lon, radiusMi);
  const nearby = all.map((s)=>({
      ...s,
      dist: haversineMi(lat, lon, s.latitude, s.longitude)
    })).filter((s)=>s.dist <= radiusMi).sort((a, b)=>a.dist - b.dist).slice(0, storesWanted);
  if (!nearby.length) return Response.json({
    stores: [],
    items: []
  });
  const menus = await Promise.all(nearby.map((s)=>menuFor(s.store_id)));
  const priceMap = {};
  menus.forEach((menu, idx)=>menu.forEach((it)=>{
      (priceMap[it.name] ??= Array(nearby.length).fill(NaN))[idx] = it.price;
    }));
  const items = Object.entries(priceMap).map(([name, arr])=>{
    const vals = arr.filter(Number.isFinite);
    const spread = Math.max(...vals) - Math.min(...vals);
    return {
      name,
      prices: arr,
      spread
    };
  }).filter((i)=>i.prices.filter(Number.isFinite).length > 1).sort((a, b)=>b.spread - a.spread).slice(0, rowsWanted);
  return Response.json({
    stores: nearby,
    items
  });
});
