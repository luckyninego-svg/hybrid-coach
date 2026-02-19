/**
 * COACHING LOGIC
 * Builds the AI system prompt and analyzes Strava activities
 * All coaching decisions are grounded in the Skiba/Magness/Connelly framework
 */

/**
 * Build the full system prompt for Claude
 * Injects athlete-specific data so coaching is personalized
 */
function buildCoachingPrompt(context) {
  const { athlete, recentActivities } = context;

  const zonesBlock = athlete.critical_speed
    ? `
ATHLETE TRAINING ZONES (based on CS ${athlete.critical_speed} min/km):
- Z1 Recovery:     > ${athlete.zone1_pace} min/km
- Z2 Aerobic Base: ${athlete.zone2_pace} min/km  
- Z3 Tempo:        ${athlete.zone3_pace} min/km
- Z4 Threshold:    ${athlete.zone4_pace} min/km  ← Critical Speed zone
- Z5 VO2max+:      < ${athlete.zone5_pace} min/km
`
    : 'Training zones: Not yet calculated (ask athlete for 5K time to set zones).';

  const recentBlock = recentActivities?.length > 0
    ? `
RECENT TRAINING (last 7 days):
${recentActivities.map(a =>
  `- ${a.date?.slice(0, 10)} | ${a.type} | ${a.distance_km}km | ${a.duration_min}min | Pace: ${a.avg_pace || 'N/A'} | HR: ${a.avg_hr || 'N/A'}`
).join('\n')}
`
    : 'No recent activities logged yet.';

  return `You are a science-based running and HYROX coach. Your coaching is grounded in exercise physiology, not generic fitness advice.

COACHING FRAMEWORK (always apply these principles):
1. CRITICAL SPEED (CS) is the anchor of all training. Everything below CS is aerobically sustainable. Above CS, W' (anaerobic capacity) is being spent and is finite.
2. W' (W-prime) is the anaerobic work capacity. In HYROX, it gets spent on sleds and wall balls. Athletes must pace to protect W' for the back half of the race.
3. ZONE MODEL: Z1-Z2 = 80% of all training volume (aerobic base). Z3 is the danger zone — avoid. Z4 = threshold work (quality). Z5 = VO2max development.
4. PERIODIZATION: Base → Build → Peak → Taper. Every session has a purpose. Never prescribe work without explaining the physiological reason.
5. 3:1 LOADING: Three weeks progressive load, one week recovery (30-40% volume reduction). Never skip deload weeks.
6. HYROX PACING: Run segments 1-4 at 90-95% of 10K pace to preserve W'. Dump W' in the final stations (wall balls). The 8km of running is the biggest performance variable.
7. RECOVERY: HRV suppressed >10% below baseline = reduce intensity. Adaptation happens during recovery, not during training.
8. INTERFERENCE EFFECT (hybrid training): Strength before endurance in same session. Separate by 6+ hours when double-training. Running fitness is primary — station fitness is secondary.

COMMUNICATION STYLE:
- Always give the WHY behind every recommendation (reference physiology)
- Use specific numbers: zones, paces, HR ranges — never vague terms like "easy" or "hard"
- Be direct and confident but not harsh
- Keep responses concise for WhatsApp/Telegram — max 250 words
- Use data the athlete has logged to make feedback specific to them
- Celebrate improvements with numbers ("Your CS improved 8 sec/km over 6 weeks")

ATHLETE PROFILE:
Name: ${athlete?.name || 'Unknown'}
5K PB: ${athlete?.five_k_time || 'Not set'}
Critical Speed: ${athlete?.critical_speed || 'Not calculated'}
Training Phase: ${athlete?.training_phase || 'Base'}
Goal Race: ${athlete?.goal_race || 'Not set'}
Experience: ${athlete?.experience || 'Not set'}

${zonesBlock}

${recentBlock}

If you don't have enough data to give specific advice, ask the athlete for what you need before prescribing anything.`;
}

/**
 * Analyze a Strava activity against athlete's zones
 * Returns a structured summary for Claude to interpret
 */
function analyzeActivity(activity, athlete) {
  const paceSecPerKm = activity.average_speed > 0
    ? Math.round(1000 / activity.average_speed)
    : null;

  const zone = athlete?.critical_speed
    ? classifyZone(paceSecPerKm, athlete.critical_speed)
    : 'Unknown (no zones set)';

  const weeklyLoad = null; // Could calculate from DB if needed

  return {
    activity: {
      name: activity.name,
      type: activity.type,
      date: activity.start_date?.slice(0, 10),
      distance_km: (activity.distance / 1000).toFixed(2),
      duration_min: Math.round(activity.moving_time / 60),
      avg_pace_min_km: paceSecPerKm ? formatSeconds(paceSecPerKm) : null,
      avg_hr: activity.average_heartrate,
      max_hr: activity.max_heartrate,
      elevation_m: activity.total_elevation_gain,
      suffer_score: activity.suffer_score,
      calories: activity.calories
    },
    coaching_context: {
      zone_classification: zone,
      critical_speed: athlete?.critical_speed || null,
      five_k_time: athlete?.five_k_time || null,
      training_phase: athlete?.training_phase || 'Base',
      zone2_range: athlete?.zone2_pace || null,
      zone4_range: athlete?.zone4_pace || null,
    },
    coaching_questions: [
      'Was this session in the correct zone for its intended purpose?',
      'Is the HR proportionate to the pace (cardiac drift, heat, fatigue)?',
      'Does this fit the weekly periodization plan?',
      'Any patterns across recent sessions worth noting?'
    ]
  };
}

/**
 * Classify pace into training zone based on Critical Speed
 */
function classifyZone(paceSecPerKm, csString) {
  if (!paceSecPerKm || !csString) return 'Unknown';

  const [m, s] = csString.split(':').map(Number);
  const csSeconds = m * 60 + s;

  const ratio = paceSecPerKm / csSeconds; // Higher ratio = slower pace

  if (ratio >= 1.35) return 'Z1 - Recovery';
  if (ratio >= 1.15) return 'Z2 - Aerobic Base';
  if (ratio >= 1.05) return 'Z3 - Tempo (caution: minimize this zone)';
  if (ratio >= 0.95) return 'Z4 - Threshold (Critical Speed zone)';
  return 'Z5 - VO2max / Anaerobic';
}

/**
 * Build context object for Claude from athlete + recent activities
 */
function buildChatContext(athlete, recentActivities) {
  return { athlete, recentActivities };
}

function formatSeconds(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

module.exports = { buildCoachingPrompt, analyzeActivity, buildChatContext };
