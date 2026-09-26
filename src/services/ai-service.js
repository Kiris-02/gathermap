/**
 * AI Preference Parser Service
 * Provides LLM-powered intention parsing via Google Gemini with multi-model fallback,
 * plus a full deterministic rule-based NLP fallback when offline or unconfigured.
 */

const { API_PROVIDERS } = require('../config/constants');

async function callGemini(prompt, responseMimeType = 'application/json', geminiKey = process.env.GEMINI_API_KEY) {
    if (!geminiKey) return null;

    for (const model of API_PROVIDERS.CANDIDATE_GEMINI_MODELS) {
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        ...(responseMimeType ? { responseMimeType } : {})
                    }
                })
            });
            if (res.ok) {
                const data = await res.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) return { text, model };
            }
        } catch (e) {
            // try next model
        }
    }
    return null;
}

async function parsePreferences({ discussionText = '', friends = [] }, geminiKey = process.env.GEMINI_API_KEY) {
    const combinedWishes = friends
        .filter(f => f.wish && f.wish.trim())
        .map(f => `${f.name}: "${f.wish.trim()}"`)
        .join('\n');

    const rawInput = (discussionText + (combinedWishes ? '\n' + combinedWishes : '')).trim();

    if (geminiKey && rawInput) {
        const prompt = `You are an expert AI Preference & Intent Interpreter for a Group Dining / Hangout Application.
Analyze the user's natural-language request (in Vietnamese or English).
Extract structured hard constraints (must-haves) and soft weighted preferences.

IMPORTANT INSTRUCTIONS:
1. Do NOT force food choices into narrow enums. Support ANY cuisine (e.g. Korean, Japanese, Vietnamese, Italian, Thai, Chinese, Indian), dish (e.g. Korean BBQ, Hotpot, Sushi, Pho, Bingsu, Pizza, Seafood, Steak, Dessert), ambience (e.g. lively, quiet/study, romantic, rooftop, cozy, outdoor), and feature (e.g. parking, wifi, air_conditioned, private_room).
2. Hard constraints are non-negotiable boolean filters or maximum budgets. Only set a hard constraint to true if the user explicitly demands it (e.g. "must be vegetarian", "chay", "strictly no alcohol", "under 100k").
3. Soft preferences carry weights from 1 (minor bonus) to 5 (top priority).
4. If no specific cuisine is mentioned (e.g. "anything nearby", "ăn gì cũng được"), keep cuisines and dishes empty.
5. Preserve individual preferences. If a preference comes from a line formatted as MemberName: "wish", set memberName to that exact MemberName. Use memberName "Group" only for preferences that apply to everyone or come from general group discussion.

Return ONLY valid JSON matching this exact schema:
{
  "hardConstraints": {
    "maxPricePerPersonVnd": number or null,
    "vegetarianRequired": boolean,
    "veganRequired": boolean,
    "halalRequired": boolean,
    "noAlcohol": boolean,
    "quietRequired": boolean,
    "openNowRequired": boolean,
    "parkingRequired": boolean
  },
  "cuisines": [
    { "value": string, "weight": number, "memberName": "Group" }
  ],
  "dishes": [
    { "value": string, "weight": number, "memberName": "Group" }
  ],
  "ambience": [
    { "value": string, "weight": number, "memberName": "Group" }
  ],
  "features": [
    { "value": string, "weight": number, "memberName": "Group" }
  ],
  "negativePreferences": [
    { "value": string, "weight": number }
  ],
  "rawIntent": string
}

Input Text:
${rawInput}`;

        const aiResponse = await callGemini(prompt, 'application/json', geminiKey);
        if (aiResponse && aiResponse.text) {
            try {
                const parsed = JSON.parse(aiResponse.text);

                const legacySoft = [];
                (parsed.cuisines || []).forEach(c => legacySoft.push({ preference: c.value, criterion: 'cuisine', weight: c.weight, memberName: c.memberName || 'Group' }));
                (parsed.dishes || []).forEach(d => legacySoft.push({ preference: d.value, criterion: 'dish', weight: d.weight, memberName: d.memberName || 'Group' }));
                (parsed.ambience || []).forEach(a => legacySoft.push({ preference: a.value, criterion: 'ambience', weight: a.weight, memberName: a.memberName || 'Group' }));
                (parsed.features || []).forEach(f => legacySoft.push({ preference: f.value, criterion: 'feature', weight: f.weight, memberName: f.memberName || 'Group' }));

                const legacyReqs = {
                    vegetarian: Boolean(parsed.hardConstraints?.vegetarianRequired || parsed.hardConstraints?.veganRequired),
                    no_alcohol: Boolean(parsed.hardConstraints?.noAlcohol),
                    quiet_only: Boolean(parsed.hardConstraints?.quietRequired),
                    max_price_vnd: parsed.hardConstraints?.maxPricePerPersonVnd || null
                };
                parsed.hardConstraints = {
                    ...parsed.hardConstraints,
                    ...legacyReqs,
                    vegetarianRequired: parsed.hardConstraints?.vegetarianRequired ?? legacyReqs.vegetarian,
                    noAlcohol: parsed.hardConstraints?.noAlcohol ?? legacyReqs.no_alcohol,
                    quietRequired: parsed.hardConstraints?.quietRequired ?? legacyReqs.quiet_only,
                    maxPricePerPersonVnd: parsed.hardConstraints?.maxPricePerPersonVnd ?? legacyReqs.max_price_vnd
                };

                const dynamicPreferences = [];
                let pId = 1;
                (parsed.cuisines || []).forEach(c => dynamicPreferences.push({
                    id: `pref_${pId++}`,
                    memberId: c.memberId || null,
                    memberName: c.memberName || 'Group',
                    text: c.value,
                    importance: c.weight || 5,
                    polarity: 'positive'
                }));
                (parsed.dishes || []).forEach(d => dynamicPreferences.push({
                    id: `pref_${pId++}`,
                    memberId: d.memberId || null,
                    memberName: d.memberName || 'Group',
                    text: d.value,
                    importance: d.weight || 5,
                    polarity: 'positive'
                }));
                (parsed.ambience || []).forEach(a => dynamicPreferences.push({
                    id: `pref_${pId++}`,
                    memberId: a.memberId || null,
                    memberName: a.memberName || 'Group',
                    text: a.value,
                    importance: a.weight || 4,
                    polarity: 'positive'
                }));
                (parsed.features || []).forEach(f => dynamicPreferences.push({
                    id: `pref_${pId++}`,
                    memberId: f.memberId || null,
                    memberName: f.memberName || 'Group',
                    text: f.value,
                    importance: f.weight || 4,
                    polarity: 'positive'
                }));
                (parsed.negativePreferences || []).forEach(n => dynamicPreferences.push({
                    id: `pref_${pId++}`,
                    memberId: null,
                    memberName: 'Group',
                    text: n.value || n,
                    importance: n.weight || 5,
                    polarity: 'negative'
                }));

                return {
                    ...parsed,
                    preferences: dynamicPreferences,
                    requiredConstraints: legacyReqs,
                    softPreferences: legacySoft,
                    aiPowered: true,
                    aiModel: aiResponse.model
                };
            } catch (jsonErr) {
                console.warn('[AI Service] Failed to parse AI JSON:', jsonErr.message);
            }
        }
    }

    // Deterministic Rule-Based Fallback
    const hardConstraints = {
        maxPricePerPersonVnd: null,
        vegetarianRequired: false,
        veganRequired: false,
        halalRequired: false,
        noAlcohol: false,
        quietRequired: false,
        openNowRequired: false,
        parkingRequired: false
    };
    const cuisines = [];
    const dishes = [];
    const ambience = [];
    const features = [];
    const negativePreferences = [];

    const lower = rawInput.toLowerCase();

    // Negative preferences
    if (lower.includes('not club') || lower.includes('đừng kiểu club') || lower.includes('quá ồn') || lower.includes('not too loud') || lower.includes('not club-loud')) {
        negativePreferences.push({ value: 'club-level loud music', weight: 4 });
    }

    // Hard constraints
    if (lower.includes('vegetarian') || lower.includes('chay') || lower.includes('quán chay')) {
        hardConstraints.vegetarianRequired = true;
    }
    if (lower.includes('vegan') || lower.includes('thuần chay')) {
        hardConstraints.veganRequired = true;
        hardConstraints.vegetarianRequired = true;
    }
    if (lower.includes('halal') || lower.includes('hồi giáo')) {
        hardConstraints.halalRequired = true;
    }
    if (lower.includes('no alcohol') || lower.includes('không cồn') || lower.includes('không bia') || lower.includes('no beer')) {
        hardConstraints.noAlcohol = true;
    }
    if (lower.includes('strictly quiet') || lower.includes('yên tĩnh tuyệt đối')) {
        hardConstraints.quietRequired = true;
    }

    // Budget
    const budgetMatch = lower.match(/(?:dưới|<|under|khoảng|around|tối đa|max)\s*(\d+)\s*(k|000|vnd)/i) || lower.match(/(\d+)\s*k/i);
    if (budgetMatch) {
        const num = parseInt(budgetMatch[1], 10);
        hardConstraints.maxPricePerPersonVnd = num < 1000 ? num * 1000 : num;
    }

    // Cuisines & Dishes
    if (lower.includes('korean bbq') || lower.includes('bbq hàn') || lower.includes('thịt nướng hàn')) {
        cuisines.push({ value: 'korean', weight: 5, memberName: 'Group' });
        dishes.push({ value: 'korean bbq', weight: 5, memberName: 'Group' });
    } else if (lower.includes('korean') || lower.includes('hàn quốc') || lower.includes('món hàn')) {
        cuisines.push({ value: 'korean', weight: 5, memberName: 'Group' });
    }

    if (lower.includes('sushi') || lower.includes('sashimi')) {
        cuisines.push({ value: 'japanese', weight: 5, memberName: 'Group' });
        dishes.push({ value: 'sushi', weight: 5, memberName: 'Group' });
    } else if (lower.includes('japanese') || lower.includes('nhật bản') || lower.includes('món nhật')) {
        cuisines.push({ value: 'japanese', weight: 5, memberName: 'Group' });
    }

    if (lower.includes('hotpot') || lower.includes('lẩu')) {
        dishes.push({ value: 'hotpot', weight: 5, memberName: 'Group' });
    }
    if (lower.includes('bbq') || lower.includes('nướng') || lower.includes('grill')) {
        dishes.push({ value: 'bbq', weight: 5, memberName: 'Group' });
    }
    if (lower.includes('matcha')) {
        dishes.push({ value: 'matcha', weight: 5, memberName: 'Group' });
    }
    if (lower.includes('cafe') || lower.includes('cà phê') || lower.includes('coffee')) {
        dishes.push({ value: 'coffee', weight: 4, memberName: 'Group' });
    }
    if (lower.includes('dessert') || lower.includes('bánh ngọt') || lower.includes('bingsu') || lower.includes('chè')) {
        dishes.push({ value: 'dessert', weight: 5, memberName: 'Group' });
    }

    // Ambience
    if (lower.includes('lively') || lower.includes('nhộn nhịp') || lower.includes('sôi động') || lower.includes('tụ tập')) {
        ambience.push({ value: 'lively', weight: 4, memberName: 'Group' });
    }
    if (lower.includes('quiet') || lower.includes('yên tĩnh') || lower.includes('học bài') || lower.includes('study') || lower.includes('work')) {
        ambience.push({ value: 'quiet', weight: 5, memberName: 'Group' });
    }
    if (lower.includes('rooftop') || lower.includes('view đẹp') || lower.includes('chill')) {
        ambience.push({ value: 'rooftop_view', weight: 4, memberName: 'Group' });
    }
    if (lower.includes('aesthetic') || lower.includes('sống ảo') || lower.includes('photo')) {
        ambience.push({ value: 'aesthetic', weight: 4, memberName: 'Group' });
    }

    // Features
    if (lower.includes('parking') || lower.includes('gửi xe')) {
        features.push({ value: 'parking', weight: 3, memberName: 'Group' });
    }
    if (lower.includes('wifi') || lower.includes('mạng mạnh')) {
        features.push({ value: 'fast_wifi', weight: 3, memberName: 'Group' });
    }

    const legacySoft = [
        ...cuisines.map(c => ({ preference: c.value, criterion: 'cuisine', weight: c.weight, memberName: c.memberName })),
        ...dishes.map(d => ({ preference: d.value, criterion: 'dish', weight: d.weight, memberName: d.memberName })),
        ...ambience.map(a => ({ preference: a.value, criterion: 'ambience', weight: a.weight, memberName: a.memberName })),
        ...features.map(f => ({ preference: f.value, criterion: 'feature', weight: f.weight, memberName: f.memberName }))
    ];

    const dynamicPreferences = [];
    let pId = 1;
    (cuisines || []).forEach(c => dynamicPreferences.push({
        id: `pref_${pId++}`,
        memberId: c.memberId || null,
        memberName: c.memberName || 'Group',
        text: c.value,
        importance: c.weight || 5,
        polarity: 'positive'
    }));
    (dishes || []).forEach(d => dynamicPreferences.push({
        id: `pref_${pId++}`,
        memberId: d.memberId || null,
        memberName: d.memberName || 'Group',
        text: d.value,
        importance: d.weight || 5,
        polarity: 'positive'
    }));
    (ambience || []).forEach(a => dynamicPreferences.push({
        id: `pref_${pId++}`,
        memberId: a.memberId || null,
        memberName: a.memberName || 'Group',
        text: a.value,
        importance: a.weight || 4,
        polarity: 'positive'
    }));
    (features || []).forEach(f => dynamicPreferences.push({
        id: `pref_${pId++}`,
        memberId: f.memberId || null,
        memberName: f.memberName || 'Group',
        text: f.value,
        importance: f.weight || 4,
        polarity: 'positive'
    }));
    (negativePreferences || []).forEach(n => dynamicPreferences.push({
        id: `pref_${pId++}`,
        memberId: null,
        memberName: 'Group',
        text: n.value || n,
        importance: n.weight || 5,
        polarity: 'negative'
    }));

    return {
        hardConstraints: {
            ...hardConstraints,
            vegetarian: hardConstraints.vegetarianRequired,
            no_alcohol: hardConstraints.noAlcohol,
            quiet_only: hardConstraints.quietRequired,
            max_price_vnd: hardConstraints.maxPricePerPersonVnd
        },
        cuisines,
        dishes,
        ambience,
        features,
        negativePreferences,
        preferences: dynamicPreferences,
        rawIntent: rawInput || 'Tìm địa điểm gặp mặt phù hợp xung quanh tâm điểm nhóm',
        requiredConstraints: {
            vegetarian: hardConstraints.vegetarianRequired,
            no_alcohol: hardConstraints.noAlcohol,
            quiet_only: hardConstraints.quietRequired,
            max_price_vnd: hardConstraints.maxPricePerPersonVnd
        },
        softPreferences: legacySoft,
        aiPowered: false
    };
}

module.exports = {
    callGemini,
    parsePreferences
};
