/**
 * DATABASE LAYER - Supabase
 * Replaces SQLite so data persists across Railway redeploys
 */

const { createClient } = require('@supabase/supabase-js');

let supabase;

function init() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  console.log('SUPABASE_URL:', url ? 'found (' + url.substring(0, 30) + '...)' : 'MISSING');
  console.log('SUPABASE_SERVICE_KEY:', key ? 'found (length ' + key.length + ')' : 'MISSING');
  if (!url || !key) {
    throw new Error('Missing Supabase credentials. Check SUPABASE_URL and SUPABASE_SERVICE_KEY in Railway variables.');
  }
  supabase = createClient(url, key);
  console.log('Supabase connected');
}

async function upsertAthlete(data) {
  const { error } = await supabase
    .from('athletes')
    .upsert({ telegram_id: data.telegram_id, name: data.name }, { onConflict: 'telegram_id', ignoreDuplicates: true });
  if (error) console.error('upsertAthlete error:', error.message);
}

async function updateAthlete(telegramId, fields) {
  if (Object.keys(fields).length === 0) return;
  const { error } = await supabase
    .from('athletes')
    .update(fields)
    .eq('telegram_id', String(telegramId));
  if (error) console.error('updateAthlete error:', error.message);
}

async function getAthleteByTelegram(telegramId) {
  const { data, error } = await supabase
    .from('athletes')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .single();
  if (error && error.code !== 'PGRST116') console.error('getAthleteByTelegram error:', error.message);
  return data || null;
}

async function getAthleteByStravaId(stravaId) {
  const { data, error } = await supabase
    .from('athletes')
    .select('*')
    .eq('strava_id', String(stravaId))
    .single();
  if (error && error.code !== 'PGRST116') console.error('getAthleteByStravaId error:', error.message);
  return data || null;
}

async function saveActivity(data) {
  const { error } = await supabase
    .from('activities')
    .upsert(data, { onConflict: 'strava_id', ignoreDuplicates: true });
  if (error) console.error('saveActivity error:', error.message);
}

async function getRecentActivities(telegramId, limit) {
  const { data, error } = await supabase
    .from('activities')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .order('date', { ascending: false })
    .limit(limit || 7);
  if (error) console.error('getRecentActivities error:', error.message);
  return data || [];
}

async function getActivityByStravaId(stravaId) {
  const { data, error } = await supabase
    .from('activities')
    .select('*')
    .eq('strava_id', String(stravaId))
    .single();
  if (error && error.code !== 'PGRST116') console.error('getActivityByStravaId error:', error.message);
  return data || null;
}

async function saveRPE(stravaId, rpe) {
  const { error } = await supabase
    .from('activities')
    .update({ rpe })
    .eq('strava_id', String(stravaId));
  if (error) console.error('saveRPE error:', error.message);
}

async function getAllConnectedAthletes() {
  const { data, error } = await supabase
    .from('athletes')
    .select('*')
    .eq('strava_connected', 1);
  if (error) console.error('getAllConnectedAthletes error:', error.message);
  return data || [];
}

module.exports = {
  init,
  upsertAthlete,
  updateAthlete,
  getAthleteByTelegram,
  getAthleteByStravaId,
  saveActivity,
  getRecentActivities,
  getActivityByStravaId,
  saveRPE,
  getAllConnectedAthletes
};
