import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// In-memory cache
let cachedData: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL = 30 * 1000; // 30 seconds

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60 * 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return false;
  }
  if (record.count >= RATE_LIMIT) return true;
  record.count++;
  return false;
}

function formatMatchTime(timeStr: string): string {
  // Time is already formatted as "16:00 03/08/2026"
  return timeStr || '';
}

function mapMatchStatus(status: string): string {
  // Check if the match is live based on score or other indicators
  // Since the new API doesn't have explicit status, we'll determine based on score
  if (status && status !== 'vs' && status.includes('-')) {
    return 'live';
  }
  return 'upcoming';
}

function extractMatchTimestamp(timeStr: string): number {
  try {
    // Parse "16:00 03/08/2026" format
    const parts = timeStr.split(' ');
    if (parts.length !== 2) return 0;
    
    const timeParts = parts[0].split(':');
    const dateParts = parts[1].split('/');
    
    if (timeParts.length !== 2 || dateParts.length !== 3) return 0;
    
    const hours = parseInt(timeParts[0]);
    const minutes = parseInt(timeParts[1]);
    const day = parseInt(dateParts[0]);
    const month = parseInt(dateParts[1]) - 1; // Month is 0-indexed
    const year = parseInt(dateParts[2]);
    
    const date = new Date(Date.UTC(year, month, day, hours, minutes));
    return Math.floor(date.getTime() / 1000);
  } catch {
    return 0;
  }
}

interface RawMatch {
  view_url: string;
  label: string;
  time: string;
  home_logo: string;
  home_name: string;
  score: string;
  away_logo: string;
  away_name: string;
  url: string;
  authors: Array<{
    name: string;
    url: string;
    logo: string;
  }>;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] || 
                     req.headers.get('cf-connecting-ip') || 'unknown';
    
    if (isRateLimited(clientIP)) {
      return new Response(
        JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 429 }
      )
    }

    // Serve from cache if fresh
    const now = Date.now();
    if (cachedData && (now - cachedData.timestamp) < CACHE_TTL) {
      return new Response(JSON.stringify(cachedData.data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        status: 200,
      })
    }

    const response = await fetch('https://yalatt.playstoreapp.sbs/api/matches.php', {
      method: 'GET',
      headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/137.0.0.0 Mobile Safari/537.36',
      },
    })

    if (!response.ok) {
      console.error(`External API error: ${response.status}`)
      // Serve stale cache if available
      if (cachedData) {
        return new Response(JSON.stringify(cachedData.data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'STALE' },
          status: 200,
        })
      }
      throw new Error('External service unavailable')
    }

    const rawData: RawMatch[] = await response.json()

    const mapped = (rawData || []).map((m: RawMatch) => {
      const time = formatMatchTime(m.time);
      const statusHint = mapMatchStatus(m.score);
      const matchTimestamp = extractMatchTimestamp(m.time);

      // Clean up names and labels (remove trailing newlines)
      const homeName = m.home_name ? m.home_name.replace(/\n/g, '').trim() : '';
      const awayName = m.away_name ? m.away_name.replace(/\n/g, '').trim() : '';
      const leagueName = m.label ? m.label.replace(/\n/g, '').trim() : '';

      // Process authors
      const authors = (m.authors || []).map((s) => ({
        name: s.name ? s.name.replace(/\n/g, '').trim() : 'Stream',
        url: s.url || '',
        logo: s.logo || '',
        referer: '', // New API doesn provide referer
      }));

      // If no authors, use the main URL as a fallback
      if (authors.length === 0 && m.url) {
        authors.push({
          name: 'Stream',
          url: m.url,
          logo: '',
          referer: '',
        });
      }

      return {
        view_url: m.view_url || '',
        label: leagueName,
        time: statusHint === 'live' ? `Live ${time}` : time,
        home_logo: m.home_logo || '',
        home_name: homeName,
        score: m.score || 'vs',
        away_logo: m.away_logo || '',
        away_name: awayName,
        url: m.url || '',
        authors,
        match_status: statusHint,
        match_timestamp: matchTimestamp,
      };
    });

    // Update cache
    cachedData = { data: mapped, timestamp: now };

    // Save finished matches to DB (fire-and-forget)
    const finished = mapped.filter((m: { match_status: string; score: string }) => 
      m.match_status === 'live' && m.score !== 'vs'
    );
    
    if (finished.length > 0) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const sb = createClient(supabaseUrl, supabaseKey);

        const rows = finished.map((m: { home_name: string; away_name: string; match_timestamp: number; home_logo: string; away_logo: string; score: string; label: string; time: string }) => ({
          match_key: `${m.home_name}-${m.away_name}-${m.match_timestamp}`,
          home_name: m.home_name,
          away_name: m.away_name,
          home_logo: m.home_logo,
          away_logo: m.away_logo,
          score: m.score,
          league: m.label,
          match_timestamp: m.match_timestamp,
          match_time: m.time,
        }));

        await sb.from('match_results').upsert(rows, { onConflict: 'match_key', ignoreDuplicates: true });
      } catch (e) {
        console.error('Failed to save match results:', e);
      }
    }

    return new Response(JSON.stringify(mapped), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
      status: 200,
    })
  } catch (error: unknown) {
    console.error('Error fetching matches:', error)
    return new Response(
      JSON.stringify({ error: 'Unable to fetch matches. Please try again later.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
