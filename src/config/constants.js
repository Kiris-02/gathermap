/**
 * GatherMap Core Constants & Configuration
 * Explicitly defines all mathematical weights, geometric thresholds, and system constants.
 */

const SCORING_WEIGHTS = {
    // Individual Member Score: 100% Preference Satisfaction (Geography strictly for candidate eligibility)
    MEMBER_PREFERENCE: 1.00,
    MEMBER_TRAVEL: 0.00,

    // Group Score: 65% Group Average + 35% Minimum Individual Satisfaction
    GROUP_AVERAGE: 0.65,
    GROUP_MINIMUM: 0.35
};

const TRAVEL_PARAMS = {
    AVERAGE_CITY_SPEED_KMH: 20, // HCMC average urban scooter/traffic speed
    BASE_TRAVEL_MINUTES: 3,     // Parking, walking, and intersection buffer
    MAX_REASONABLE_DISTANCE_KM: 10
};

const GEOMETRIC_PARAMS = {
    DEFAULT_CENTER: { lat: 10.7769, lng: 106.7009 },
    DEFAULT_RADIUS_METERS: 3000,
    CONVERGENCE_EPSILON: 1e-6,
    MAX_WEISZFELD_ITERATIONS: 100
};

const API_PROVIDERS = {
    CANDIDATE_GEMINI_MODELS: [
        'gemini-3.1-flash-lite',
        'gemini-3.5-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.8-flash'
    ],
    NOMINATIM_BASE_URL: 'https://nominatim.openstreetmap.org/search',
    GOOGLE_PLACES_NEARBY_URL: 'https://places.googleapis.com/v1/places:searchNearby',
    GOOGLE_GEOCODE_URL: 'https://maps.googleapis.com/maps/api/geocode/json'
};

module.exports = {
    SCORING_WEIGHTS,
    TRAVEL_PARAMS,
    GEOMETRIC_PARAMS,
    API_PROVIDERS
};
